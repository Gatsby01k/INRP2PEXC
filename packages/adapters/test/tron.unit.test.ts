import { describe, expect, it } from 'vitest';
import { isDomainError } from '@inrp2p/kernel';
import { DualProviderChainVerifier, TronHttpProvider, sameTransfer } from '../src/index.ts';
import { FAKE_USDT_CONTRACT, FakeTronChain, FakeTronProvider, fakeTronAddress } from '../src/testing/index.ts';

const chainWith = () => {
  const chain = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
  const primary = new FakeTronProvider('node-a', chain);
  const secondary = new FakeTronProvider('node-b', chain);
  const verifier = new DualProviderChainVerifier({ primary, secondary, tokenContract: FAKE_USDT_CONTRACT });
  return { chain, primary, secondary, verifier };
};

describe('dual-provider verification (D-05)', () => {
  it('names both providers when they report the same facts', async () => {
    const { chain, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-1'), amountMinor: 1_000_000n });
    chain.solidifyAll();
    const receipt = await verifier.lookupTransfer('TRON', t.txHash, t.logIndex);
    expect(receipt).toMatchObject({ network: 'TRON', amountMinor: 1_000_000n, receiptStatus: 'SUCCESS' });
    expect(receipt!.agreedBy).toEqual(['node-a', 'node-b']);
    expect(receipt!.agreedGroups).toEqual(['group-node-a', 'group-node-b']);
    expect(receipt!.blockNumber <= receipt!.solidifiedBlock).toBe(true);
  });

  it('names only the primary when the second provider does not know the transfer', async () => {
    const { chain, secondary, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-2'), amountMinor: 5n });
    chain.solidifyAll();
    secondary.hide(t.txHash);
    const receipt = await verifier.lookupTransfer('TRON', t.txHash, t.logIndex);
    expect(receipt!.agreedBy).toEqual(['node-a']);
  });

  it('names only the primary when the second provider reports different facts', async () => {
    const { chain, secondary, verifier } = chainWith();
    const t = chain.add({ to: fakeTronAddress('deposit-3'), amountMinor: 42n });
    chain.solidifyAll();
    secondary.distort = (x) => ({ ...x, amountMinor: x.amountMinor + 1n });
    const receipt = await verifier.lookupTransfer('TRON', t.txHash, t.logIndex);
    expect(receipt!.agreedBy).toEqual(['node-a']);
    // The facts are the primary's, never a blend of the two.
    expect(receipt!.amountMinor).toBe(42n);
  });

  it('reports a transfer the chain does not know as null, and refuses another network', async () => {
    const { verifier } = chainWith();
    expect(await verifier.lookupTransfer('TRON', 'a'.repeat(64), 0)).toBeNull();
    await expect(verifier.lookupTransfer('ETHEREUM' as 'TRON', 'a'.repeat(64), 0)).rejects.toSatisfy((e) => isDomainError(e, 'INVALID_ARGUMENT'));
  });

  it('two adapters onto the same source are one independent source, however they are named', async () => {
    const chain = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
    // Different names, same operator behind them — a mirror of one node, not a second opinion.
    const primary = new FakeTronProvider('vendor-eu', chain, { independenceGroup: 'acme-cloud' });
    const secondary = new FakeTronProvider('vendor-us', chain, { independenceGroup: 'ACME-Cloud' });
    const verifier = new DualProviderChainVerifier({ primary, secondary, tokenContract: FAKE_USDT_CONTRACT });
    expect(verifier.providers).toEqual(['vendor-eu', 'vendor-us']);
    expect(verifier.independenceGroups).toEqual(['acme-cloud']);

    const t = chain.add({ to: fakeTronAddress('deposit-dup'), amountMinor: 20_000_000_000n });
    chain.solidifyAll();
    const receipt = await verifier.lookupTransfer('TRON', t.txHash, t.logIndex);
    // Both answered identically, and it still counts as one source: no quorum is reachable here at any amount.
    expect(receipt!.agreedBy).toEqual(['vendor-eu', 'vendor-us']);
    expect(receipt!.agreedGroups).toEqual(['acme-cloud']);
  });

  it('refuses a provider identity that is not a stable identifier', () => {
    const chain = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
    const nameless = new FakeTronProvider('ok', chain, { independenceGroup: '   ' });
    expect(() => new DualProviderChainVerifier({ primary: nameless, tokenContract: FAKE_USDT_CONTRACT })).toThrow();
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

  it('keeps only transfers of the asked contract, at or above the asked block', async () => {
    const to = fakeTronAddress('watched');
    const from = fakeTronAddress('sender');
    const other = fakeTronAddress('other-token');
    const p = provider(() => ({
      data: [
        { transaction_id: 'AA'.repeat(32), event_index: 0, token_info: { address: FAKE_USDT_CONTRACT }, from, to, value: '1000000', block: 100, block_timestamp: 1_700_000_000_000 },
        { transaction_id: 'BB'.repeat(32), event_index: 1, token_info: { address: FAKE_USDT_CONTRACT }, from, to, value: '2000000', block: 50, block_timestamp: 1_700_000_000_000 },
        { transaction_id: 'CC'.repeat(32), event_index: 0, token_info: { address: other }, from, to, value: '3000000', block: 120, block_timestamp: 1_700_000_000_000 },
      ],
    }));
    const rows = await p.listIncomingTransfers({ address: to, contract: FAKE_USDT_CONTRACT, sinceBlock: 100n });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: 'aa'.repeat(32), logIndex: 0, amountMinor: 1_000_000n, blockNumber: 100n, receiptStatus: null });
  });

  it('refuses a provider answer it cannot read rather than guessing', async () => {
    const p = provider(() => ({ block_header: { raw_data: { number: 'not-a-number' } } }));
    await expect(p.getLatestBlockNumber()).rejects.toSatisfy((e) => isDomainError(e, 'INVALID_ARGUMENT'));

    const badAddress = provider(() => ({ data: [{ transaction_id: 'AA'.repeat(32), token_info: { address: 'not-an-address' }, from: 'x', to: 'y', value: '1', block: 1, block_timestamp: 1 }] }));
    await expect(badAddress.listIncomingTransfers({ address: fakeTronAddress('watched'), contract: FAKE_USDT_CONTRACT, sinceBlock: 0n }))
      .rejects.toSatisfy((e) => isDomainError(e, 'INVALID_ADDRESS'));
  });

  it('turns an unreachable or failing node into a CHAIN_PROVIDER_ERROR', async () => {
    const failing = new TronHttpProvider({
      name: 'node-down', independenceGroup: 'group-down', baseUrl: 'https://api.example.test',
      fetchImpl: (async () => new Response('nope', { status: 503 })) as typeof fetch,
    });
    await expect(failing.getLatestBlockNumber()).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_PROVIDER_ERROR'));

    const unreachable = new TronHttpProvider({
      name: 'node-gone', independenceGroup: 'group-gone', baseUrl: 'https://api.example.test',
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
    });
    await expect(unreachable.getSolidifiedBlockNumber()).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_PROVIDER_ERROR'));
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
    expect(await secondary.getTransfer(t.txHash, t.logIndex)).toBeNull();
    expect(await primary.getTransfer(t.txHash, t.logIndex)).not.toBeNull();
    chain.orphan(t.txHash, t.logIndex);
    expect(await primary.getTransfer(t.txHash, t.logIndex)).toBeNull();
  });
});
