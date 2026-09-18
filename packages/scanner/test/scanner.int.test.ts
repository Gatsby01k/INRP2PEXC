import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { FakeTronProvider } from '@inrp2p/adapters/testing';
import { runAs } from '@inrp2p/identity/testing';
import { cancelTrade, confirmPayout, createPayoutLeg, recordLegEvidence, sendPayoutLeg, submitTxForVerification } from '@inrp2p/settlement';
import { readCursor, runOrphanSweep, runTronConfirm, runTronScan } from '../src/index.ts';
import {
  type ChainWorld, createChainWorld, depositAddressOf, entriesOf, journalsFor, legsOf, openCases, openTrade, settleFirstLeg, stateOf, transferByHash,
} from './world.ts';

let w: ChainWorld;
beforeAll(async () => { w = await createChainWorld('scanner', { depositPoolSize: 60 }); });
afterAll(async () => w.close());

const usdt = (decimal: string) => Money.parse(decimal, 'USDT').minor;

/** A SELL trade on the canonical rates (client ₹102.00, route ₹104.20), ready for its first leg. */
const sellTrade = (baseUsdt: string) => openTrade(w, { baseUsdt, clientRate: '102.000000', routeRate: '104.200000' });
const strangerAddress = () => encodeTronAddress(randomBytes(20));

/** Mines a deposit into a trade's assigned address and runs one full scan. */
async function deposit(tradeId: string, opts: { amount?: string; from?: string; solidify?: boolean } = {}) {
  const address = await depositAddressOf(w, tradeId);
  const amountMinor = opts.amount ? usdt(opts.amount) : address.expectedMinor!;
  const transfer = w.tron.add({ to: address.address, from: opts.from ?? w.clientSourceAddress, amountMinor });
  if (opts.solidify !== false) w.tron.solidifyAll();
  const report = await runTronScan(w.app, w.scanDeps);
  return { transfer, report, address };
}

describe('detection (tron_scan)', () => {
  it('detects a client deposit, attributes it by deposit assignment and is idempotent on a rescan (FI-23, FI-26)', async () => {
    const trade = await sellTrade('1000');
    const first = await deposit(trade.tradeId);
    expect(first.report.detected).toBeGreaterThanOrEqual(1);
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');
    const legs = await legsOf(w, trade.tradeId);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ side: 'CLIENT_TO_EXCHANGE', status: 'PROCESSING', amount_minor: usdt('1000') });

    // The same block range is read again (the overlap window): the event is already known, nothing is duplicated.
    const again = await runTronScan(w.app, w.scanDeps);
    expect(again.detected).toBe(0);
    expect(again.alreadyKnown).toBeGreaterThanOrEqual(1);
    expect(await legsOf(w, trade.tradeId)).toHaveLength(1);
    const rows = await w.app.selectFrom('crypto_transfer').select('id').where('tx_hash', '=', first.transfer.txHash).execute();
    expect(rows).toHaveLength(1);
    const allocations = await w.app.selectFrom('transfer_allocation').select('id').where('crypto_transfer_id', '=', rows[0]!.id).where('voided_at', 'is', null).execute();
    expect(allocations).toHaveLength(1);
  });

  it('never allocates another trade’s deposit to this trade (FI-26)', async () => {
    const mine = await sellTrade('10');
    const other = await sellTrade('10');
    await deposit(other.tradeId);

    expect(await legsOf(w, mine.tradeId)).toHaveLength(0);
    expect(await stateOf(w, mine.tradeId)).toBe('AWAITING_FIRST_LEG');
    expect(await legsOf(w, other.tradeId)).toHaveLength(1);
  });

  it('refuses to count one transfer for a second trade — the address decides, not the operator', async () => {
    const mine = await sellTrade('10');
    const other = await sellTrade('10');
    const { transfer } = await deposit(mine.tradeId);

    // An operator hands the same hash over while working the other trade: attribution still follows the
    // destination address, so the other trade gets nothing and no second leg or allocation appears.
    const submitted = await runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.scanDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', {
      txHash: transfer.txHash, logIndex: transfer.logIndex,
    });
    expect(submitted.tradeId).toBe(mine.tradeId);
    expect(await legsOf(w, other.tradeId)).toHaveLength(0);
    expect(await legsOf(w, mine.tradeId)).toHaveLength(1);
  });

  it('opens FUNDS_AFTER_TRADE_CLOSED for funds arriving at a cooled-down address', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client stood down before sending' });
    expect((await w.app.selectFrom('deposit_address').select('status').where('id', '=', address.addressId).executeTakeFirstOrThrow()).status).toBe('COOLDOWN');

    const late = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10') });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);

    const row = await transferByHash(w, late.txHash);
    expect(row?.state).toBe('DETECTED');
    expect(await openCases(w, row!.id)).toEqual(['FUNDS_AFTER_TRADE_CLOSED']);
    expect(await legsOf(w, trade.tradeId)).toHaveLength(0);
  });

  it('opens USDT_WRONG_AMOUNT for a short payment and USDT_OVERPAYMENT for an excess one', async () => {
    const short = await sellTrade('100');
    const shortDeposit = await deposit(short.tradeId, { amount: '90' });
    const shortRow = await transferByHash(w, shortDeposit.transfer.txHash);
    expect(await openCases(w, shortRow!.id)).toEqual(['USDT_WRONG_AMOUNT']);
    expect((await w.app.selectFrom('trade').select('hold').where('id', '=', short.tradeId).executeTakeFirstOrThrow()).hold).toBe(true);

    const over = await sellTrade('100');
    const overDeposit = await deposit(over.tradeId, { amount: '120' });
    const overRow = await transferByHash(w, overDeposit.transfer.txHash);
    expect(await openCases(w, overRow!.id)).toEqual(['USDT_OVERPAYMENT']);
  });

  it('opens USDT_UNEXPECTED_SENDER when the funds come from an unregistered wallet', async () => {
    const trade = await sellTrade('10');
    const sent = await deposit(trade.tradeId, { from: strangerAddress() });
    const row = await transferByHash(w, sent.transfer.txHash);
    expect(await openCases(w, row!.id)).toEqual(['USDT_UNEXPECTED_SENDER']);
  });

  it('ignores a transfer the provider reports under another contract (FI-24)', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    const good = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10') });
    w.tron.solidifyAll();

    const other = strangerAddress();
    const lying = new FakeTronProvider('liar', w.tron, { distort: (t) => (t.txHash === good.txHash ? { ...t, tokenContract: other } : t) });
    const ignored = await runTronScan(w.app, { ...w.scanDeps, provider: lying });
    expect(ignored.wrongContract).toBe(1);
    expect(await transferByHash(w, good.txHash)).toBeUndefined();
    expect(await legsOf(w, trade.tradeId)).toHaveLength(0);

    // With an honest provider the very same transfer is detected — nothing about it was written before.
    await runTronScan(w.app, w.scanDeps);
    expect((await transferByHash(w, good.txHash))?.state).toBe('DETECTED');
    expect(await legsOf(w, trade.tradeId)).toHaveLength(1);
  });

  it('parks a direct treasury deposit in suspense on confirmation (STATE_MACHINES §5)', async () => {
    const treasury = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    const stray = w.tron.add({ to: treasury.address, from: strangerAddress(), amountMinor: usdt('7') });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);
    const row = await transferByHash(w, stray.txHash);
    expect(row).toMatchObject({ state: 'DETECTED', payee_type: 'EXCHANGE_TREASURY' });
    expect(await openCases(w, row!.id)).toEqual(['UNALLOCATED_DEPOSIT']);

    const confirmed = await runTronConfirm(w.app, w.scanDeps);
    expect(confirmed.suspense).toBeGreaterThanOrEqual(1);
    expect((await transferByHash(w, stray.txHash))?.state).toBe('CONFIRMED');
    const key = `crypto:${row!.id}:confirm`;
    expect(await journalsFor(w.app, row!.id)).toEqual([key]);
    expect(await entriesOf(w, key)).toEqual([
      `ASSET:TREASURY_USDT:${w.treasuryWalletId} DR ${usdt('7')}`,
      `SUSPENSE:UNALLOCATED CR ${usdt('7')}`,
    ]);
  });
});

describe('confirmation (tron_confirm)', () => {
  it('leaves a transfer DETECTED until its block is solidified, then completes the client leg (FI-24)', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    const pending = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10') });
    await runTronScan(w.app, w.scanDeps);
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');

    const early = await runTronConfirm(w.app, w.scanDeps);
    expect(early.notFinalCases).toBe(0);
    expect((await transferByHash(w, pending.txHash))?.state).toBe('DETECTED');
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');

    w.tron.solidifyAll();
    await runTronConfirm(w.app, w.scanDeps);
    const row = await transferByHash(w, pending.txHash);
    expect(row).toMatchObject({ state: 'CONFIRMED', verified_by: 'fake-node-a,fake-node-b' });
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_CONFIRMED');
    expect(await journalsFor(w.app, row!.id)).toEqual([`crypto:${row!.id}:confirm`]);
    expect((await legsOf(w, trade.tradeId))[0]).toMatchObject({ status: 'COMPLETED' });
  });

  it('blocks confirmation above the dual-provider threshold until both providers agree (D-05)', async () => {
    const trade = await sellTrade('20000');
    const address = await depositAddressOf(w, trade.tradeId);
    const big = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('20000') });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);

    w.secondary.hide(big.txHash);
    await runTronConfirm(w.app, { ...w.scanDeps, scanner: { notFinalAfterMinutes: 0 } });
    const stillDetected = await transferByHash(w, big.txHash);
    expect(stillDetected?.state).toBe('DETECTED');
    expect(await openCases(w, stillDetected!.id)).toEqual(['TX_NOT_FINAL']);
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');

    w.secondary.unhide(big.txHash);
    await runTronConfirm(w.app, w.scanDeps);
    expect(await transferByHash(w, big.txHash)).toMatchObject({ state: 'CONFIRMED', verified_by: 'fake-node-a,fake-node-b' });
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_CONFIRMED');
  });

  it('a small amount still settles on one provider’s word (below the D-05 threshold)', async () => {
    const trade = await sellTrade('5');
    const address = await depositAddressOf(w, trade.tradeId);
    const small = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('5') });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);
    w.secondary.hide(small.txHash);
    await runTronConfirm(w.app, w.scanDeps);
    expect(await transferByHash(w, small.txHash)).toMatchObject({ state: 'CONFIRMED', verified_by: 'fake-node-a' });
    w.secondary.unhide(small.txHash);
  });

  it('a failed receipt fails the transfer and puts the trade back to awaiting the client (T3)', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    const bad = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10'), receiptStatus: 'FAILED' });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);
    const report = await runTronConfirm(w.app, w.scanDeps);
    expect(report.failed).toBeGreaterThanOrEqual(1);

    const row = await transferByHash(w, bad.txHash);
    expect(row?.state).toBe('FAILED');
    expect((await legsOf(w, trade.tradeId))[0]).toMatchObject({ status: 'FAILED' });
    expect(await stateOf(w, trade.tradeId)).toBe('AWAITING_FIRST_LEG');
    expect(await journalsFor(w.app, row!.id)).toEqual([]);
  });
});

describe('reorganisations (tron_orphan_sweep)', () => {
  it('reverts a detected transfer that the chain no longer knows', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    const doomed = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10') });
    await runTronScan(w.app, w.scanDeps);
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');

    w.tron.orphan(doomed.txHash, doomed.logIndex);
    const swept = await runOrphanSweep(w.app, { ...w.scanDeps, scanner: { orphanAfterMinutes: 0 } });
    expect(swept.orphaned).toBeGreaterThanOrEqual(1);
    expect(swept.legsReverted).toBeGreaterThanOrEqual(1);

    const row = await transferByHash(w, doomed.txHash);
    expect(row?.state).toBe('ORPHANED');
    expect((await legsOf(w, trade.tradeId))[0]).toMatchObject({ status: 'FAILED' });
    expect(await stateOf(w, trade.tradeId)).toBe('AWAITING_FIRST_LEG');
    expect(await journalsFor(w.app, row!.id)).toEqual([]);
    const allocations = await w.app.selectFrom('transfer_allocation').select('voided_at').where('crypto_transfer_id', '=', row!.id).execute();
    expect(allocations.every((a) => a.voided_at !== null)).toBe(true);
  });

  it('leaves a transfer alone while the providers still report it', async () => {
    const trade = await sellTrade('10');
    const { transfer } = await deposit(trade.tradeId, { solidify: false });
    const swept = await runOrphanSweep(w.app, { ...w.scanDeps, scanner: { orphanAfterMinutes: 0 } });
    expect(swept.orphaned).toBe(0);
    expect((await transferByHash(w, transfer.txHash))?.state).toBe('DETECTED');
    w.tron.solidifyAll();
    await runTronConfirm(w.app, w.scanDeps);
    expect((await transferByHash(w, transfer.txHash))?.state).toBe('CONFIRMED');
  });
});

describe('outbound USDT (BUY payouts)', () => {
  it('verifies the payout transaction by tx hash but leaves the release to an operator', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '500', clientRate: '106.000000', routeRate: '104.200000' });
    await settleFirstLeg(w, trade.tradeId);

    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
      tradeId: trade.tradeId, amount: '500', payer: 'EXCHANGE_ACCOUNT' as const, treasuryWalletId: w.treasuryWalletId,
    });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });

    const treasury = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    const clientWallet = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
    const sent = w.tron.add({ to: clientWallet.address, from: treasury.address, amountMinor: usdt('500') });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.scanDeps), w.settlementOp.ref, 'payout_leg.record_evidence', {
      legId: leg.legId, txHash: sent.txHash, logIndex: sent.logIndex, fromAddress: treasury.address,
    });

    // Not final yet: the operator cannot confirm, and neither does the scanner.
    await expect(confirmPayout(w.app, w.settlementOp.actor, w.scanDeps, { legId: leg.legId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'TRANSFER_NOT_CONFIRMED' });

    w.tron.solidifyAll();
    const verified = await runTronConfirm(w.app, w.scanDeps);
    expect(verified.verified).toBeGreaterThanOrEqual(1);
    expect((await transferByHash(w, sent.txHash))?.state).toBe('CONFIRMED');
    // Verification is not release: the leg stays in flight until an operator confirms it (⧗).
    expect((await w.app.selectFrom('settlement_leg').select('status').where('id', '=', leg.legId).executeTakeFirstOrThrow()).status).toBe('PROCESSING');

    const done = await confirmPayout(w.app, w.settlementOp.actor, w.scanDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
    expect(done.completed).toBe(true);
    expect(await stateOf(w, trade.tradeId)).toBe('COMPLETED');
  });
});

describe('the scanner cursor', () => {
  it('advances with the chain and never moves backwards (IX066)', async () => {
    await runTronScan(w.app, w.scanDeps);
    const before = await readCursor(w.app, 'tron_deposits');
    expect(before).not.toBeNull();
    w.tron.advance(50n);
    await runTronScan(w.app, w.scanDeps);
    const after = await readCursor(w.app, 'tron_deposits');
    expect(after!.lastScannedBlock).toBeGreaterThan(before!.lastScannedBlock);
    expect(after!.lastSolidifiedBlock).toBeGreaterThanOrEqual(before!.lastSolidifiedBlock);

    const failure = await w.app
      .updateTable('chain_cursor')
      .set({ last_scanned_block: 1n })
      .where('network', '=', 'TRON')
      .where('scanner', '=', 'tron_deposits')
      .execute()
      .then(() => null, (e: unknown) => e);
    expect(pgErrorCode(failure)).toBe('IX066');
  });
});
