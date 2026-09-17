import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRANTABLE, OPERATOR_ROLES, PERMISSION_MATRIX, type Requirement, effectiveRequirement } from '../src/rbac/matrix.ts';

/** Parses SECURITY.md §3 so the executable matrix can never drift from the approved specification. */
function parseSecurityMatrix(): Map<string, Record<string, { req: Requirement; grantable: boolean }>> {
  const doc = readFileSync(new URL('../../../docs/SECURITY.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('## 3. RBAC permission matrix'), doc.indexOf('## 4. Separation of duties'));
  const rows = section.split('\n').filter((l) => l.startsWith('| `'));
  const out = new Map<string, Record<string, { req: Requirement; grantable: boolean }>>();
  const cols = ['OWNER', 'DEALER', 'SETTLEMENT_OPERATOR', 'FINANCE', 'SUPPORT', 'READ_ONLY'];
  const SPECIAL_NAMES: Record<string, string> = { contacts: 'client:manage_contacts', export: 'ledger:export' };

  for (const line of rows) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const label = cells[0]!;
    const names = [...label.matchAll(/`([^`]+)`|\/\s*([a-z_]+)(?=\s|$)/g)].map((m) => m[1] ?? m[2]!);
    let resource = '';
    const perms = names.map((n) => {
      if (n.includes(':')) {
        resource = n.split(':')[0]!;
        return n;
      }
      return SPECIAL_NAMES[n] ?? `${resource}:${n}`;
    });
    perms.forEach((perm, idx) => {
      const rec: Record<string, { req: Requirement; grantable: boolean }> = {};
      cols.forEach((role, i) => {
        const cell = cells[i + 1]!;
        let req: Requirement;
        if (cell === '✔') req = 'ALLOW';
        else if (cell === '⧗') req = 'STEP_UP';
        else if (cell === '⧗✱') req = 'STEP_UP_SECOND_APPROVER';
        else if (cell.startsWith('—')) req = 'DENY';
        else if (cell === 'create only') req = perm.endsWith(':create') ? 'ALLOW' : 'DENY';
        else if (cell === 'pnl only') req = perm === 'pnl:view' ? 'ALLOW' : 'DENY';
        else throw new Error(`unparsed cell "${cell}" in ${label}`);
        rec[role] = { req, grantable: /grantable/.test(cell) };
      });
      out.set(perm, rec);
      void idx;
    });
  }
  return out;
}

describe('RBAC matrix parity with SECURITY.md §3', () => {
  const spec = parseSecurityMatrix();

  it('covers exactly the same permissions', () => {
    expect([...spec.keys()].sort()).toEqual(Object.keys(PERMISSION_MATRIX).sort());
  });

  it.each(Object.keys(PERMISSION_MATRIX))('%s matches the spec for every role', (perm) => {
    const row = spec.get(perm)!;
    for (const role of OPERATOR_ROLES) {
      expect({ role, req: PERMISSION_MATRIX[perm as keyof typeof PERMISSION_MATRIX][role] }).toEqual({ role, req: row[role]!.req });
      const grantable = (GRANTABLE[perm as keyof typeof GRANTABLE] ?? []).includes(role);
      expect({ role, grantable }).toEqual({ role, grantable: row[role]!.grantable });
    }
  });

  it('combines multiple roles by the most permissive requirement and applies grants only where grantable', () => {
    expect(effectiveRequirement('settlement:confirm_payout', ['READ_ONLY', 'SETTLEMENT_OPERATOR'])).toBe('STEP_UP');
    expect(effectiveRequirement('economics:view', ['READ_ONLY'], ['economics:view'])).toBe('ALLOW');
    expect(effectiveRequirement('economics:view', ['SETTLEMENT_OPERATOR'], ['economics:view'])).toBe('DENY');
    expect(effectiveRequirement('audit:view', ['READ_ONLY'], ['audit:view'])).toBe('DENY');
    expect(effectiveRequirement('desk:view', [])).toBe('DENY');
  });
});
