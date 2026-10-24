import { describe, expect, it } from 'vitest';
import { isDomainError } from '@inrp2p/kernel';
import { QuorumChainVerifier, type TransferReceipt, TronHttpProvider, sameTransfer } from '../src/index.ts';
import { FAKE_USDT_CONTRACT, FakeTronChain, FakeTronProvider, fakeTronAddress } from '../src/testing/index.ts';

const chainWith = () => {
  const chain = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
  const primary = new FakeTronProvider('node-a', chain);
  const secondary = new FakeTronProvider('node-b', chain);
  const verifier = new QuorumChainVerifier({ providers: [primary, secondary], tokenContract: FAKE_USDT_CONTRACT });
  return { chain, primary, secondary, verifier };
};

/** The receipt of a FOUND answer, or a failed expectation naming what came back instead. */
async function found(verifier: QuorumChainVerifier, txHash: string, logIndex: number): Promise<TransferReceipt> {
  const v = await verifier.verifyTransfer('TRON', txHash, logIndex);
  if (v.status !== 'FOUND') throw new Error(`expected FOUND, got ${v.status}`);
  return v.receipt;
}

describe('dual-provider verification (D-05)', () => {
  it('names both providers when they report the same facts', async () => {
    const { chain, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-1'), amountMinor: 1_000_000n });
    chain.solidifyAll();
    const receipt = await found(verifier, t.txHash, t.logIndex);
    expect(receipt).toMatchObject({ network: 'TRON', amountMinor: 1_000_000n, receiptStatus: 'SUCCESS', degraded: false, unavailable: [] });
    expect(receipt!.agreedBy).toEqual(['node-a', 'node-b']);
    expect(receipt!.agreedGroups).toEqual(['group-node-a', 'group-node-b']);
    expect(receipt!.blockNumber <= receipt!.solidifiedBlock).toBe(true);
  });

  it('names only the primary when the second provider does not know the transfer', async () => {
    const { chain, secondary, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-2'), amountMinor: 5n });
    chain.solidifyAll();
    secondary.hide(t.txHash);
    const receipt = await found(verifier, t.txHash, t.logIndex);
    expect(receipt.agreedBy).toEqual(['node-a']);
    // A lagging provider is not unavailable: it answered, it just does not know the transfer yet.
    expect(receipt.degraded).toBe(false);
  });

  it('reports a contradiction between providers as a CONFLICT, never as the word of the primary', async () => {
    const { chain, secondary, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-3'), amountMinor: 42n });
    chain.solidifyAll();
    secondary.distort = (x) => ({ ...x, amountMinor: x.amountMinor + 1n });
    const v = await verifier.verifyTransfer('TRON', t.txHash, t.logIndex);
    expect(v.status).toBe('CONFLICT');
  });

  it('reports a provider that cannot answer as unavailable and the answer as degraded, never as absent', async () => {
    const { chain, secondary, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-down'), amountMinor: 7n });
    chain.solidifyAll();
    secondary.failWith = new Error('ECONNREFUSED');
    const receipt = await found(verifier, t.txHash, t.logIndex);
    expect(receipt).toMatchObject({ agreedBy: ['node-a'], agreedGroups: ['group-node-a'], unavailable: ['node-b'], degraded: true });

    const nobody = new QuorumChainVerifier({ providers: [new FakeTronProvider('x', chain, { failWith: new Error('down') })], tokenContract: FAKE_USDT_CONTRACT });
    expect((await nobody.verifyTransfer('TRON', t.txHash, t.logIndex)).status).toBe('UNAVAILABLE');
  });

  it('reports a transfer nobody knows as NOT_FOUND with who said so, and refuses another network', async () => {
    const { verifier, secondary } = chainWith();
    expect(await verifier.verifyTransfer('TRON', 'a'.repeat(64), 0)).toMatchObject({ status: 'NOT_FOUND', absentBy: ['node-a', 'node-b'], unavailable: [] });
    secondary.failWith = new Error('down');
    expect(await verifier.verifyTransfer('TRON', 'a'.repeat(64), 0)).toMatchObject({ status: 'NOT_FOUND', absentBy: ['node-a'], unavailable: ['node-b'] });
    await expect(verifier.verifyTransfer('ETHEREUM' as 'TRON', 'a'.repeat(64), 0)).rejects.toSatisfy((e) => isDomainError(e, 'INVALID_ARGUMENT'));
  });

  it('agreement on facts is not agreement on finality: only providers that call the block final count', async () => {
    const { chain, secondary, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-final'), amountMinor: 3n });
    chain.solidifyAll();
    secondary.lagBlocks = chain.solidificationLag + 1n; // knows the transfer, but its solidified head is behind it
    const receipt = await found(verifier, t.txHash, t.logIndex);
    expect(receipt.agreedBy).toEqual(['node-a']);
    expect(receipt.blockNumber <= receipt.solidifiedBlock).toBe(true);
  });

  it('a failed transaction is TX_FAILED with the providers that call it final', async () => {
    const { chain, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-reverted'), amountMinor: 9n, receiptStatus: 'FAILED' });
    chain.solidifyAll();
    expect(await verifier.verifyTransfer('TRON', t.txHash, t.logIndex)).toMatchObject({ status: 'TX_FAILED', agreedBy: ['node-a', 'node-b'] });
  });

  it('two adapters onto the same source are one independent source, however they are named', async () => {
    const chain = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
    // Different names, same operator behind them — a mirror of one node, not a second opinion.
    const primary = new FakeTronProvider('vendor-eu', chain, { independenceGroup: 'acme-cloud' });
    const secondary = new FakeTronProvider('vendor-us', chain, { independenceGroup: 'ACME-Cloud' });
    const verifier = new QuorumChainVerifier({ providers: [primary, secondary], tokenContract: FAKE_USDT_CONTRACT });
    expect(verifier.providers).toEqual(['vendor-eu', 'vendor-us']);
    expect(verifier.independenceGroups).toEqual(['acme-cloud']);

    const t = chain.add({ to: fakeTronAddress('deposit-dup'), amountMinor: 20_000_000_000n });
    chain.solidifyAll();
    const receipt = await found(verifier, t.txHash, t.logIndex);
    // Both answered identically, and it still counts as one source: no quorum is reachable here at any amount.
    expect(receipt.agreedBy).toEqual(['vendor-eu', 'vendor-us']);
    expect(receipt.agreedGroups).toEqual(['acme-cloud']);
  });

  it('refuses a provider identity that is not a stable identifier', () => {
    const chain = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
    const nameless = new FakeTronProvider('ok', chain, { independenceGroup: '   ' });
    expect(() => new QuorumChainVerifier({ providers: [nameless], tokenContract: FAKE_USDT_CONTRACT })).toThrow();
    expect(() => new QuorumChainVerifier({ providers: [], tokenContract: FAKE_USDT_CONTRACT })).toThrow();
    expect(() => new TronHttpProvider({ name: 'n', independenceGroup: '', baseUrl: 'https://api.example.test' })).toThrow();
  });

  it('agreement compares every fact the domain reads', () => {
    const base = {
      txHash: 'ab'.repeat(32), logIndex: 0, tokenContract: FAKE_USDT_CONTRACT, fromAddress: fakeTronAddress('a'),
      toAddress: fakeTronAddress('b'), amountMinor: 10n, blockNumber: 5n, blockTime: new Date(0), receiptStatus: 'SUCCESS' as const,
    };
    expect(sameTransfer(base, { ...base, blockTime: new Date(1) })).toBe(true);
    expect(sameTransfer(base, { ...base, amountMinor: 11n })).toBe(false);
    expect(sameTransfer(base, { ...base, blockNumber: 6n })).toBe(false);
    expect(sameTransfer(base, { ...base, receiptStatus: 'FAILED' })).toBe(false);
    expect(sameTransfer(base, { ...base, toAddress: fakeTronAddress('c') })).toBe(false);
  });
});

describe('the TronGrid HTTP provider', () => {
  const provider = (handler: (url: string) => unknown) =>
    new TronHttpProvider({
      name: 'node-http',
      independenceGroup: 'group-http',
      baseUrl: 'https://api.example.test/',
      fetchImpl: (async (input: unknown) => {
        const body = handler(String(input));
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });

  it('reads the head and the solidified head from the two block endpoints', async () => {
    const p = provider((url) => ({ block_header: { raw_data: { number: url.includes('walletsolidity') ? 990 : 1_010 } } }));
    expect(await p.getLatestBlockNumber()).toBe(1_010n);
    expect(await p.getSolidifiedBlockNumber()).toBe(990n);
  });

  it('refuses a provider answer it cannot read rather than guessing', async () => {
    const p = provider(() => ({ block_header: { raw_data: { number: 'not-a-number' } } }));
    await expect(p.getLatestBlockNumber()).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_EVIDENCE_INVALID'));
  });

  it('turns an unreachable or failing node into a CHAIN_PROVIDER_ERROR', async () => {
    const failing = new TronHttpProvider({
      name: 'node-down', independenceGroup: 'group-down', baseUrl: 'https://api.example.test', retryBaseDelayMs: 0,
      fetchImpl: (async () => new Response('nope', { status: 503 })) as typeof fetch,
    });
    await expect(failing.getLatestBlockNumber()).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_PROVIDER_ERROR'));

    const unreachable = new TronHttpProvider({
      name: 'node-gone', independenceGroup: 'group-gone', baseUrl: 'https://api.example.test', retryBaseDelayMs: 0,
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
    });
    await expect(unreachable.getSolidifiedBlockNumber()).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_PROVIDER_ERROR'));
  });

  it('waits out a rate limit (429) for as long as the provider asks, and then reads', async () => {
    const calls: number[] = [];
    const limited = new TronHttpProvider({
      name: 'node-busy', independenceGroup: 'group-busy', baseUrl: 'https://api.example.test', retryBaseDelayMs: 0, rateLimitDelayMs: 1,
      fetchImpl: (async () => {
        calls.push(Date.now());
        // Rate limited three times in a row — one more than other transient failures are retried — then an answer.
        if (calls.length <= 3) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.02' } });
        return Response.json({ block_header: { raw_data: { number: 42 } } });
      }) as typeof fetch,
    });
    expect(await limited.getLatestBlockNumber()).toBe(42n);
    expect(calls).toHaveLength(4);
    // Each wait honoured the provider's Retry-After (20 ms) rather than asking again at once.
    for (let i = 1; i < calls.length; i++) expect(calls[i]! - calls[i - 1]!).toBeGreaterThanOrEqual(15);
  });

  it('gives up on a rate limit that does not lift, as a provider error that says so', async () => {
    const limited = new TronHttpProvider({
      name: 'node-busy', independenceGroup: 'group-busy', baseUrl: 'https://api.example.test', retryBaseDelayMs: 0, rateLimitDelayMs: 0,
      fetchImpl: (async () => new Response('slow down', { status: 429 })) as typeof fetch,
    });
    await expect(limited.getLatestBlockNumber()).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_PROVIDER_ERROR') && /429/.test((e as Error).message));
  });
});

describe('the fake TRON chain', () => {
  it('keeps a transfer unsolidified until the head moves past the finality lag', async () => {
    const { chain, primary } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-4'), amountMinor: 1n });
    expect(await primary.getSolidifiedBlockNumber()).toBeLessThan(t.blockNumber);
    chain.solidifyAll();
    expect(await primary.getSolidifiedBlockNumber()).toBeGreaterThanOrEqual(t.blockNumber);
  });

  it('forgets an orphaned transfer and hides one from a lagging provider', async () => {
    const { chain, primary, secondary } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-5'), amountMinor: 1n });
    secondary.lagBlocks = 100n;
    expect((await secondary.getTransfer(t.txHash, t.logIndex)).status).toBe('NOT_FOUND');
    expect((await primary.getTransfer(t.txHash, t.logIndex)).status).toBe('FOUND');
    chain.orphan(t.txHash, t.logIndex);
    expect((await primary.getTransfer(t.txHash, t.logIndex)).status).toBe('NOT_FOUND');
  });
});
