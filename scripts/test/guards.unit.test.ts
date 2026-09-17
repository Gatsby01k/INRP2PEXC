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
