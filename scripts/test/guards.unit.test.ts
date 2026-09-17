import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { scanText } from '../secret-scan.ts';

describe('secret scan', () => {
  it('detects private keys and seed material', () => {
    expect(scanText('a.ts', '-----BEGIN PRIVATE KEY-----')).toHaveLength(1); // secret-scan:allow
    expect(scanText('a.ts', `const k = "${'ab'.repeat(32)}";`)).toHaveLength(1);
    expect(scanText('a.ts', 'const k = "abandon ability able about above absent absorb abstract absurd abuse access accident";')).toHaveLength(1); // secret-scan:allow
    expect(scanText('a.ts', 'const ok = "10200000.00";')).toHaveLength(0);
  });
});

describe('lint guards', () => {
  const eslint = new ESLint();
  it('forbids floating-point money operations in financial packages', async () => {
    const [r] = await eslint.lintText('export const x = parseFloat("1.10") + Math.round(2.5) + Number("3");\n', { filePath: 'packages/ledger/src/probe.ts' });
    expect(r!.messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(3);
  });

  it('enforces module boundaries', async () => {
    const [r] = await eslint.lintText("import '@inrp2p/identity';\n", { filePath: 'packages/kernel/src/probe.ts' });
    expect(r!.messages.some((m) => /must not depend/.test(m.message))).toBe(true);
    const [deep] = await eslint.lintText("import '@inrp2p/db/src/pool.ts';\n", { filePath: 'packages/ledger/src/probe.ts' });
    expect(deep!.messages.some((m) => /public entry points/.test(m.message))).toBe(true);
  });
});

describe('workspace dependency graph check', () => {
  const m = (name: string, dir: string, deps: Record<string, string> = {}) => ({ name, dir, deps });

  it('the real workspace is acyclic', async () => {
    const { checkGraph, loadWorkspace } = await import('../workspace-graph.ts');
    const { problems } = checkGraph(loadWorkspace(new URL('../..', import.meta.url).pathname));
    expect(problems).toEqual([]);
  });

  it('detects dev-dependency cycles, package→app edges and non-workspace specs', async () => {
    const { checkGraph } = await import('../workspace-graph.ts');
    const cyclic = checkGraph([m('@x/audit', 'packages/audit', { '@x/commands': 'workspace:*' }), m('@x/commands', 'packages/commands', { '@x/audit': 'workspace:*' })]);
    expect(cyclic.problems.some((p) => /cycle: @x\/audit -> @x\/commands -> @x\/audit/.test(p))).toBe(true);
    const appEdge = checkGraph([m('@x/lib', 'packages/lib', { '@x/web': 'workspace:*' }), m('@x/web', 'apps/web')]);
    expect(appEdge.problems.some((p) => /must not depend on app/.test(p))).toBe(true);
    const spec = checkGraph([m('@x/a', 'packages/a', { '@x/b': '1.0.0' }), m('@x/b', 'packages/b')]);
    expect(spec.problems.some((p) => /workspace: protocol/.test(p))).toBe(true);
  });
});
