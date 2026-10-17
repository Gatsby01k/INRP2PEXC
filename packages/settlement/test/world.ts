import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { FakeChainVerifier } from '@inrp2p/adapters/testing';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import { createTestOperator } from '@inrp2p/identity/testing';
import { addWallet } from '@inrp2p/clients';
import { createInrAccount, createSettlementEntity, setDayCapacity } from '@inrp2p/inr-accounts';
import { configureRoute } from '@inrp2p/routes';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { checkIncomingSender, confirmFirstLeg, confirmRouteSettlement, expectedAccounts, obligationRemaining, recordRouteSettlement, submitTxForVerification, type SettlementDeps } from '../src/index.ts';
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
  // Sealed with the scenario's own protector, so a client's payment screen can open the number (ADR 0018).
  const account = await runAs(s.app, createInrAccount(s.finance.actor, s.deps.protector), s.finance.ref, 'inr_account.create', {
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
  /** A SELL trade's payout account, when not the world's own. */
  readonly bankAccountId?: string;
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
    ...(direction === 'SELL_USDT' ? { bankAccountId: opts.bankAccountId ?? w.bankAccountId } : { walletId: w.walletId }),
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
  await seeOwnSender(db, w.settlementOp, { transferId: recorded.transferId });
  await runAs(db, confirmFirstLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'settlement.confirm_incoming', { legId: recorded.legId });
  return { legId: recorded.legId, transferId: recorded.transferId };
}

/**
 * The counterparty (the trade's route, or a trader) delivers its side to the exchange (D-16), through the real
 * commands: FINANCE records the movement against the route obligation and confirms it (INR against the bank, USDT on
 * the fake chain). It lands where the exchange will pay the client from — the world's payout account for INR, the
 * HOT treasury wallet for USDT — so an exchange-paid payout of the trade is funded by it, and by nothing else.
 */
export async function deliverCounterparty(
  w: World,
  tradeId: string,
  opts: { amount?: string; inrAccountId?: string; treasuryWalletId?: string; db?: Db } = {},
): Promise<{ routeSettlementId: string; amount: string }> {
  const db = opts.db ?? w.app;
  const obligation = await w.app.selectFrom('route_obligation').select(['id', 'route_id', 'route_delivers_asset']).where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
  const remaining = await obligationRemaining(w.app, obligation.id);
  const amount = opts.amount ?? remaining.routeDelivers.toDecimalString();
  let recorded: { routeSettlementId: string };
  if (obligation.route_delivers_asset === 'INR') {
    recorded = await runAs(db, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: obligation.id, flow: 'FROM_ROUTE_TO_EXCHANGE' as const, amount, rail: 'IMPS' as const, utr: newUtr('RT'), inrAccountId: opts.inrAccountId ?? w.inrAccountId,
    });
  } else {
    const walletId = opts.treasuryWalletId ?? w.treasuryWalletId;
    const wallet = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', walletId).executeTakeFirstOrThrow();
    const routeAddress = (await w.app.selectFrom('liquidity_route').select('registered_route_address').where('id', '=', obligation.route_id).executeTakeFirstOrThrow()).registered_route_address
      ?? encodeTronAddress(randomBytes(20));
    const receipt = w.chain.add({ from: routeAddress, to: wallet.address, amountMinor: Money.parse(amount, 'USDT').minor });
    recorded = await runAs(db, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: obligation.id, flow: 'FROM_ROUTE_TO_EXCHANGE' as const, amount, txHash: receipt.txHash, logIndex: receipt.logIndex, fromAddress: routeAddress, treasuryWalletId: walletId,
    });
  }
  await runAs(db, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: recorded.routeSettlementId });
  return { routeSettlementId: recorded.routeSettlementId, amount };
}

/**
 * Records what the fake chain shows at `address` as a custody balance observation (B2), as the worker's
 * `custody_observe` job or an operator's refresh would: two independent sources agreeing on the solidified balance.
 */
export async function observe(w: World, address: string, opts: { db?: Db } = {}): Promise<void> {
  const { executeCommand } = await import('@inrp2p/commands');
  const { recordBalanceObservation } = await import('@inrp2p/treasury');
  const sources = w.chain.balanceSources();
  const readings = await Promise.all(sources.map((s) => s.getSolidifiedBalance(address, w.chain.tokenContract)));
  await executeCommand(opts.db ?? w.app, {
    authorize: async () => {},
    handle: (ctx) => recordBalanceObservation(ctx, {
      address, tokenContract: w.chain.tokenContract, quality: 'AGREED', balanceMinor: readings[0]!.balanceMinor, solidifiedBlock: readings[0]!.solidifiedBlock,
      trxSun: readings[0]!.trxSun, providers: sources.map((s) => s.name), independentSources: sources.length,
    }),
  }, { name: 'custody.observe_balance', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { address }, financial: false });
}

/** Delivers the counterparty's side once: a no-op when the trade already holds counterparty funds. */
export async function ensureCounterpartyFunds(w: World, tradeId: string, opts: { db?: Db } = {}): Promise<void> {
  const delivered = await w.app.selectFrom('funding_source').select('source_id').where('trade_id', '=', tradeId).where('kind', '=', 'COUNTERPARTY_FUNDS').executeTakeFirst();
  if (!delivered) await deliverCounterparty(w, tradeId, opts);
}

/** The deposit address a trade's client USDT arrived at (where its client funds are, D-16). */
export async function clientDepositAddressOf(w: World, tradeId: string): Promise<{ id: string; address: string }> {
  const row = await w.app
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.id', 'd.address'])
    .where('a.trade_id', '=', tradeId)
    .executeTakeFirstOrThrow();
  return row;
}

/** A SETTLEMENT_OPERATOR whose TOTP step-up is older than the freshness window. */
export async function createStaleSettlementOperator(w: World): Promise<TestOperator> {
  return createTestOperator(w.t.owner, ['SETTLEMENT_OPERATOR'], 'stale');
}

/** How the bank shows the scenario client's own account as a sender (ADR 0018). */
export const CLIENT_SENDER = 'ACME PAY PVT LTD';

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

/**
 * ADR 0018: the desk saw a payment's credit come from the payer's own registered account — what every confirmation of a
 * client's, or a trader's, rupees needs now. It checks with the holder name of the account the payment was declared
 * from, or the payer's first active account. A USDT leg, or rupees from a desk route, need nothing and get nothing.
 */
export async function seeOwnSender(db: Db, operator: TestOperator, ref: { readonly transferId?: string; readonly legId?: string; readonly routeSettlementId?: string }): Promise<void> {
  let transferId = ref.transferId ?? null;
  if (!transferId && ref.legId) {
    const a = await db.selectFrom('transfer_allocation').select('fiat_transfer_id').where('settlement_leg_id', '=', ref.legId).where('voided_at', 'is', null).executeTakeFirst();
    transferId = a?.fiat_transfer_id ?? null;
  }
  if (!transferId && ref.routeSettlementId) {
    const r = await db.selectFrom('route_settlement').select('fiat_transfer_id').where('id', '=', ref.routeSettlementId).executeTakeFirst();
    transferId = r?.fiat_transfer_id ?? null;
  }
  if (!transferId) return;
  const f = await sql<{ payer_type: string; payer_id: string; payer_bank_account_id: string | null; status: string; needs: boolean; verdict: string }>`
    select f.payer_type, f.payer_id, f.payer_bank_account_id, f.status, inrp2p_fiat_needs_sender_check(f) as needs, inrp2p_fiat_sender_verdict(f.id) as verdict
    from fiat_transfer f where f.id = ${transferId}`.execute(db);
  const row = f.rows[0];
  if (!row?.needs || row.status !== 'RECORDED' || row.verdict === 'MATCH' || row.verdict === 'ACCEPTED') return;
  const [account] = await expectedAccounts(db, { payerType: row.payer_type, payerId: row.payer_id, declared: row.payer_bank_account_id });
  if (!account) throw new Error(`payment ${transferId}: the payer has no registered account to have paid from`);
  await runAs(db, checkIncomingSender(operator.actor), operator.ref, 'fiat_in.check_sender', { transferId, senderName: account.holderName });
}

