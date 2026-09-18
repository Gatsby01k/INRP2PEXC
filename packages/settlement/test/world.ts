import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { FakeChainVerifier, testFieldProtector } from '@inrp2p/adapters/testing';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import { createTestOperator } from '@inrp2p/identity/testing';
import { addWallet } from '@inrp2p/clients';
import { createInrAccount, createSettlementEntity, setDayCapacity } from '@inrp2p/inr-accounts';
import { configureRoute } from '@inrp2p/routes';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { confirmFirstLeg, submitTxForVerification, type SettlementDeps } from '../src/index.ts';
import { createScenario, type Scenario } from '../../quotes/test/scenario.ts';

export type { Scenario };

export interface World extends Scenario {
  readonly chain: FakeChainVerifier;
  readonly settlementDeps: SettlementDeps;
  readonly settlementOp: TestOperator;
  readonly settlementOp2: TestOperator;
  readonly financeOp: TestOperator;
  readonly financeOp2: TestOperator;
  /** ACTIVE payout account with capacity, ready to pay clients. */
  readonly inrAccountId: string;
  readonly treasuryWalletId: string;
  readonly clientSourceAddress: string;
}

let accountSeq = 500000000;

/** A full Phase 4 world: the Phase 3 scenario plus payout capacity, treasury and a fake chain. */
export async function createWorld(label: string, opts: { capacityInr?: string; custody?: 'POOL' | 'UNSUPPORTED'; depositPoolSize?: number } = {}): Promise<World> {
  const s = await createScenario(label, { depositPoolSize: opts.depositPoolSize ?? 60, ...(opts.custody ? { custody: opts.custody } : {}) });
  const chain = new FakeChainVerifier();
  const settlementOp = await createTestOperator(s.t.owner, ['SETTLEMENT_OPERATOR']);
  const settlementOp2 = await createTestOperator(s.t.owner, ['SETTLEMENT_OPERATOR']);
  const financeOp = await createTestOperator(s.t.owner, ['FINANCE']);
  const financeOp2 = await createTestOperator(s.t.owner, ['FINANCE']);

  const entity = await runAs(s.app, createSettlementEntity(s.finance.actor), s.finance.ref, 'settlement_entity.create', { legalName: 'INRP2P Settlement Private Limited', shortName: `INRP2P-${randomUUID().slice(0, 6)}` });
  const account = await runAs(s.app, createInrAccount(s.finance.actor, testFieldProtector()), s.finance.ref, 'inr_account.create', {
    entityId: entity.entityId,
    label: 'Payout account',
    bankName: 'ICICI Bank',
    ifsc: 'ICIC0001234',
    accountNumber: String(accountSeq++),
    rails: ['IMPS', 'NEFT', 'RTGS'] as const,
    direction: 'BOTH' as const,
    defaultDailyCapacity: opts.capacityInr ?? '100000000.00',
  });
  await runAs(s.app, setDayCapacity(s.finance.actor), s.finance.ref, 'capacity.set_day', { accountId: account.accountId, capacity: opts.capacityInr ?? '100000000.00', reason: 'test world' });

  const hot = await s.t.owner.selectFrom('treasury_wallet').select('id').where('role', '=', 'HOT').executeTakeFirstOrThrow();
  const clientSourceAddress = encodeTronAddress(randomBytes(20));
  await runAs(s.app, addWallet(s.owner.actor), s.owner.ref, 'client_wallet.add', {
    clientId: s.clientId, network: 'TRON' as const, address: clientSourceAddress, purpose: 'SOURCE' as const, label: 'Client source wallet',
  });

  return {
    ...s,
    chain,
    settlementDeps: { chain },
    settlementOp,
    settlementOp2,
    financeOp,
    financeOp2,
    inrAccountId: account.accountId,
    treasuryWalletId: hot.id,
    clientSourceAddress,
  };
}

export interface OpenTradeOptions {
  readonly direction?: 'SELL_USDT' | 'BUY_USDT';
  readonly executionMode?: 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE';
  readonly baseUsdt?: string;
  readonly clientRate?: string;
  readonly routeRate?: string;
}

/** Accepts a quote and returns the open trade (T1), ready for its first leg. */
export async function openTrade(w: World, opts: OpenTradeOptions = {}): Promise<{ tradeId: string; tradeRef: string; quoteId: string; routeObligationId: string }> {
  const direction = opts.direction ?? 'SELL_USDT';
  const mode = opts.executionMode ?? 'DIRECT_TO_CLIENT';
  const current = await w.app.selectFrom('liquidity_route').select(['execution_mode', 'version']).where('id', '=', w.routeId).executeTakeFirstOrThrow();
  if (current.execution_mode !== mode) {
    await runAs(w.app, configureRoute(w.owner.actor), w.owner.ref, 'routes.configure', { routeId: w.routeId, expectedVersion: current.version, executionMode: mode, reason: 'test world execution mode' });
  }
  if (opts.routeRate) {
    const { publishRouteRate } = await import('@inrp2p/pricing');
    await runAs(w.app, publishRouteRate(w.dealer.actor), w.dealer.ref, 'rates.publish_route', { routeId: w.routeId, direction, rate: opts.routeRate });
  }
  const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: w.clientId, direction, fixedSide: 'BASE' as const, amount: opts.baseUsdt ?? '100000',
    ...(direction === 'SELL_USDT' ? { bankAccountId: w.bankAccountId } : { walletId: w.walletId }),
  });
  const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', {
    requestId: request.requestId, routeId: w.routeId, clientRate: opts.clientRate ?? (direction === 'SELL_USDT' ? '102.000000' : '106.000000'), validitySeconds: 300,
  });
  await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
  const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.deps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
  const obligation = await w.app.selectFrom('route_obligation').select('id').where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
  return { tradeId: accepted.tradeId, tradeRef: accepted.tradeRef, quoteId: quote.quoteId, routeObligationId: obligation.id };
}

/** Client sends the first leg and it is confirmed (T2 + T4), leaving the trade payable. */
export async function settleFirstLeg(w: World, tradeId: string, opts: { amountUsdt?: string; from?: string; db?: Db } = {}): Promise<{ legId: string; transferId: string }> {
  const db = opts.db ?? w.app;
  const trade = await w.app.selectFrom('trade').select(['direction']).where('id', '=', tradeId).executeTakeFirstOrThrow();
  if (trade.direction === 'SELL_USDT') {
    const assignment = await w.app
      .selectFrom('deposit_assignment as a')
      .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
      .select(['d.address', 'a.expected_amount_minor'])
      .where('a.trade_id', '=', tradeId)
      .executeTakeFirstOrThrow();
    const amount = opts.amountUsdt ? Money.parse(opts.amountUsdt, 'USDT') : Money.ofMinor(assignment.expected_amount_minor!, 'USDT');
    const receipt = w.chain.add({ from: opts.from ?? w.clientSourceAddress, to: assignment.address, amountMinor: amount.minor });
    const submitted = await runAs(db, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
    expect(submitted.legId).not.toBeNull();
    await runAs(db, confirmFirstLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'settlement.confirm_incoming', { legId: submitted.legId! });
    return { legId: submitted.legId!, transferId: submitted.transferId };
  }
  const { recordIncomingFiat } = await import('../src/index.ts');
  const econ = await w.app.selectFrom('trade_economics').select('quote_inr_minor').where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
  const recorded = await runAs(db, recordIncomingFiat(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.record', {
    tradeId, rail: 'IMPS' as const, utr: `IN${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`,
    amount: Money.ofMinor(econ.quote_inr_minor, 'INR').toDecimalString(), inrAccountId: w.inrAccountId,
  });
  await runAs(db, confirmFirstLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'settlement.confirm_incoming', { legId: recorded.legId });
  return { legId: recorded.legId, transferId: recorded.transferId };
}

/** A SETTLEMENT_OPERATOR whose TOTP step-up is older than the freshness window. */
export async function createStaleSettlementOperator(w: World): Promise<TestOperator> {
  return createTestOperator(w.t.owner, ['SETTLEMENT_OPERATOR'], 'stale');
}

export const newUtr = (prefix = 'UTR') => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;

/** Ledger balance of an account code (DR − CR), optionally restricted to one route obligation. */
export async function balanceOf(db: Db, code: string, currency: 'INR' | 'USDT', opts: { routeObligationId?: string; tradeId?: string } = {}): Promise<bigint> {
  const r = await sql<{ net: string }>`
    select coalesce(sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end), 0)::text as net
    from ledger_entry e join ledger_account a on a.id = e.account_id
    where a.code like ${`${code}%`} and e.currency = ${currency}
      ${opts.routeObligationId ? sql`and e.route_obligation_id = ${opts.routeObligationId}` : sql``}
      ${opts.tradeId ? sql`and e.trade_id = ${opts.tradeId}` : sql``}`.execute(db);
  return BigInt(r.rows[0]!.net);
}

/** Every journal that carries a movement id, so tests can assert "exactly one journal per movement" (FI-27). */
export async function journalsFor(db: Db, movementId: string): Promise<string[]> {
  const r = await db.selectFrom('ledger_journal').select('posting_key').where('posting_key', 'like', `%${movementId}%`).execute();
  return r.map((x) => x.posting_key);
}
