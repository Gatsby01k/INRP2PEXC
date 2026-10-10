import { describe, expect, it } from 'vitest';
import { FAKE_USDT_CONTRACT, FakeTronGrid, fakeTronAddress } from '@inrp2p/adapters/testing';
import { runSmoke, smokeConfigFromEnv } from '../tron-smoke.ts';

/**
 * The smoke gate itself needs credentials and a live network, so it never runs in CI (TD-07). What CI can check
 * is that it refuses to run on an incomplete or self-defeating configuration — in particular one where both
 * "independent" providers are the same source.
 */
const complete = {
  INRP2P_SMOKE_TRON_PRIMARY_URL: 'https://api.trongrid.io',
  INRP2P_SMOKE_TRON_PRIMARY_GROUP: 'trongrid',
  INRP2P_SMOKE_TRON_SECONDARY_URL: 'https://node.example.test',
  INRP2P_SMOKE_TRON_SECONDARY_GROUP: 'self-hosted',
  INRP2P_SMOKE_USDT_CONTRACT: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  INRP2P_SMOKE_TX_HASH: 'ab'.repeat(32),
  INRP2P_SMOKE_EXPECT_FROM: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  INRP2P_SMOKE_EXPECT_TO: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  INRP2P_SMOKE_EXPECT_AMOUNT: '12.500000',
};

const problemsOf = (env: Record<string, string>) => {
  const parsed = smokeConfigFromEnv(env);
  return 'problems' in parsed ? parsed.problems.join(' | ') : '';
};

describe('the TRON smoke gate configuration', () => {
  it('accepts a complete configuration and parses it canonically', () => {
    const parsed = smokeConfigFromEnv({ ...complete, INRP2P_SMOKE_TX_HASH: `0x${'AB'.repeat(32)}`, INRP2P_SMOKE_LOG_INDEX: '3' });
    expect('config' in parsed).toBe(true);
    if (!('config' in parsed)) return;
    expect(parsed.config).toMatchObject({ network: 'TRON', txHash: 'ab'.repeat(32), logIndex: 3 });
    expect(parsed.config.expect.amountMinor).toBe(12_500_000n);
    expect(parsed.config.primary).toMatchObject({ name: 'smoke-primary', group: 'trongrid' });
    expect(parsed.config.secondary).toMatchObject({ name: 'smoke-secondary', group: 'self-hosted' });
  });

  it('refuses two providers that declare the same independence group', () => {
    expect(problemsOf({ ...complete, INRP2P_SMOKE_TRON_SECONDARY_GROUP: 'TronGrid' })).toContain('same independence group');
  });

  it('names every missing or unusable setting rather than failing on the first one', () => {
    const problems = problemsOf({});
    for (const key of [
      'INRP2P_SMOKE_USDT_CONTRACT', 'INRP2P_SMOKE_TX_HASH', 'INRP2P_SMOKE_EXPECT_FROM', 'INRP2P_SMOKE_EXPECT_TO',
      'INRP2P_SMOKE_EXPECT_AMOUNT', 'INRP2P_SMOKE_TRON_PRIMARY_URL', 'INRP2P_SMOKE_TRON_PRIMARY_GROUP',
      'INRP2P_SMOKE_TRON_SECONDARY_URL', 'INRP2P_SMOKE_TRON_SECONDARY_GROUP',
    ]) {
      expect(problems).toContain(key);
    }
  });

  it('rejects malformed values', () => {
    expect(problemsOf({ ...complete, INRP2P_SMOKE_USDT_CONTRACT: 'not-an-address' })).toContain('not a TRON address');
    expect(problemsOf({ ...complete, INRP2P_SMOKE_TX_HASH: 'short' })).toContain('64 hex characters');
    expect(problemsOf({ ...complete, INRP2P_SMOKE_TRON_PRIMARY_URL: 'ftp://nope' })).toContain('http(s) URL');
    expect(problemsOf({ ...complete, INRP2P_SMOKE_EXPECT_AMOUNT: '12.5000001' })).toContain('decimal USDT amount');
    expect(problemsOf({ ...complete, INRP2P_SMOKE_LOG_INDEX: '-1' })).toContain('non-negative integer');
    expect(problemsOf({ ...complete, INRP2P_SMOKE_NETWORK: 'ETHEREUM' })).toContain('not supported');
  });
});

describe('the TRON smoke gate, dry run against two fake nodes serving the documented shapes', () => {
  const txHash = 'cd'.repeat(32);
  const setup = (opts: { secondaryValue?: bigint } = {}) => {
    const from = fakeTronAddress('smoke-from');
    const to = fakeTronAddress('smoke-to');
    const a = new FakeTronGrid({ baseUrl: 'https://primary.example.test' });
    const b = new FakeTronGrid({ baseUrl: 'https://secondary.example.test' });
    a.addTransfer({ from, to, value: 12_500_000n, txHash, blockNumber: 2_000n });
    b.addTransfer({ from, to, value: opts.secondaryValue ?? 12_500_000n, txHash, blockNumber: 2_000n });
    a.solidifyAll();
    b.solidifyAll();
    const parsed = smokeConfigFromEnv({
      ...complete,
      INRP2P_SMOKE_ENVIRONMENT: 'dry-run',
      INRP2P_SMOKE_TRON_PRIMARY_URL: a.baseUrl,
      INRP2P_SMOKE_TRON_SECONDARY_URL: b.baseUrl,
      INRP2P_SMOKE_TRON_PRIMARY_KEY: 'smoke-only-key-value',
      INRP2P_SMOKE_USDT_CONTRACT: FAKE_USDT_CONTRACT,
      INRP2P_SMOKE_TX_HASH: txHash,
      INRP2P_SMOKE_EXPECT_FROM: from,
      INRP2P_SMOKE_EXPECT_TO: to,
      INRP2P_SMOKE_EXPECT_AMOUNT: '12.500000',
    });
    if (!('config' in parsed)) throw new Error(parsed.problems.join('; '));
    return { config: parsed.config, fetchImpl: { primary: a.fetch, secondary: b.fetch } };
  };

  it('passes, reports finality and agreement, and never writes a key into the report', async () => {
    const { config, fetchImpl } = setup();
    const report = await runSmoke(config, { fetchImpl });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report).toMatchObject({ ok: true, environment: 'dry-run', agreement: { agreedGroups: ['trongrid', 'self-hosted'] }, finality: { blockNumber: '2000' } });
    expect(report.checks.map((c) => c.name)).toContain('smoke-primary: window read');
    expect(JSON.stringify(report)).not.toContain('smoke-only-key-value');
  });

  it('fails when the second provider reports different facts', async () => {
    const { config, fetchImpl } = setup({ secondaryValue: 12_500_001n });
    const report = await runSmoke(config, { fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'providers report identical facts')?.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'verifier decision')?.detail).toMatch(/CONFLICT/);
  });
});
