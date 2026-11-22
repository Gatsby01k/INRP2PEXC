import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, Rate, encodeTronAddress, isDomainError } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { globalImbalance } from '@inrp2p/ledger';
import { budgetFigures } from '@inrp2p/network';
import { currentPricingPolicy, setPricingPolicy } from '@inrp2p/pricing';
import { acceptQuote, createQuote, createRequest, declineRequest, rejectQuote, requestDeskQuote, requestInstantQuote, runMarketReferenceRefresh, sendQuote } from '@inrp2p/quotes';
import { runAutopay, runHoldClosing, runMonitor, runSender, runUnwindClosing } from '@inrp2p/onchain';
import { runTronConfirm } from '@inrp2p/scanner';
import { answerClientDispute, claimIncomingFiat, confirmClientReceipt, decideP2pPayment, openClientDispute, p2pDeal, runP2pDeadlines, submitTxForVerification } from '@inrp2p/settlement';
import { configureTraderProgram, deskOfTrader } from '@inrp2p/trader-core';
import {
  acceptOrder, answerOrderDispute, assignRequest, confirmOrderPaymentReceived, disputeOrderPayment, openDesk, orderDeliveryAddress, runTraderSweep, setDeskPrices, setDeskStatus, submitOrderPayment, updateBlock,
} from '@inrp2p/traders';
import { type TraderSetup, traderClient, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsTrader } from './rails-world.ts';

/**
 * A market day: the whole P2P deal, from the price to the payout, for many traders and many clients at once — the way the
 * product is used, not one deal at a time.
 *
 * Traders (some running their own desk) make their sides firm; clients ask on a desk's page, ask the INRP2P exchange for an
 * instant price, or are priced by a person on INRP2P's desk. Each deal then runs as its two people run it — the seller's
 * USDT into the deal's escrow, the buyer's rupees straight to the seller, the seller's word that they arrived (or its
 * dispute, and INRP2P's decision) — while the worker's jobs run beside them **twice at once**, as they do while a new
 * worker image rolls out or a slow run is overtaken by the next: confirming transfers, planning, signing, broadcasting and
 * settling payouts, closing network holds, sweeping orders, timing deals. Some clients decline the price; some deals are
 * disputed and decided either way. Then some deals are abandoned — a trader that never funds, a client that never pays, a
 * trader that never pays a seller — and the business clock runs past their windows: each seller gets its own USDT back.
 *
 * Afterwards the books are read, not the counters: every deal ended, nothing is left to send, each payout went out once,
 * every wallet moved by exactly its deals, every escrow kept exactly INRP2P's margin, the ledger balances, no trader's
 * capacity or TRX is still held, no rupee ever touched an INRP2P account, and no worker job failed.
 *
 * Scale is an environment variable; the default is small enough for every CI run. The timings are printed, never asserted:
 *
 *     MARKET_DEALS=1000 MARKET_LANES=60 MARKET_TRADERS=12 MARKET_WORKERS=3 pnpm run load:market
 *
 * MARKET_RAILS=GASFREE runs the same day on GasFree accounts (ADR 0022); MARKET_SEED replays one day's mix exactly.
 * The fake chain includes a block whenever a worker turns, so the waits measure the product, never TRON's ~1 minute finality.
 */
const envInt = (name: string, fallback: number) => Number.parseInt(process.env[name] ?? String(fallback), 10);
const DEALS = envInt('MARKET_DEALS', 24);
const LANES = envInt('MARKET_LANES', 8);
const TRADERS = envInt('MARKET_TRADERS', 4);
const CLIENTS = envInt('MARKET_CLIENTS', Math.max(LANES + 2, Math.ceil(DEALS / 20)));
const WORKERS = envInt('MARKET_WORKERS', 2);
const RAILS = (process.env.MARKET_RAILS ?? 'BURN') as 'BURN' | 'GASFREE';
const SEED = envInt('MARKET_SEED', 20261108);
/** How long a lane waits for the worker to move a deal on before it calls the deal stuck. */
const STUCK_MS = envInt('MARKET_STUCK_MS', 60_000);
/** Deals of each abandoned kind: opened, then left by one side until its time runs out. */
const ABANDONED = envInt('MARKET_ABANDONED', 2);

type Direction = 'SELL_USDT' | 'BUY_USDT';
type Entry = 'DESK_PAGE' | 'INSTANT' | 'INRP2P_DESK';
type Ending = 'COMPLETE' | 'DECLINE' | 'DISPUTE_THEN_CONFIRM' | 'DISPUTE_NOT_PAID' | 'ABANDONED';
type Purpose = 'CLIENT_PAYOUT' | 'ROUTE_PAYMENT' | 'ESCROW_RETURN' | 'REFUND';
/** Who walked away: the trader that never funded a purchase, the client that never paid for it, and the same for a sale. */
type Abandon = 'BUY_UNFUNDED' | 'BUY_UNPAID' | 'SELL_UNFUNDED' | 'SELL_UNPAID';

interface Spec {
  readonly i: number;
  readonly entry: Entry;
  readonly direction: Direction;
  readonly amount: string;
  readonly desk: number;
  readonly ending: Ending;
}

interface Client extends TraderSetup {
  readonly name: string;
  readonly holder: string;
}

interface Trader extends Awaited<ReturnType<typeof railsTrader>> {
  readonly name: string;
  readonly holder: string;
  readonly handle: string | null;
}

interface Outcome {
  readonly spec: Spec;
  readonly tradeId: string | null;
  readonly entryUsed: Entry | null;
  readonly expected: 'COMPLETED' | 'CANCELLED' | 'NO_TRADE';
  readonly traderId: string | null;
  readonly clientIndex: number;
  /** The one USDT transfer out of the escrow the deal must end with; null when nothing was ever in it. */
  readonly send: Purpose | null;
  /** Whether the seller's USDT reached the escrow. */
  readonly funded: boolean;
}

interface Failure {
  readonly deal: number;
  readonly step: string;
  readonly code: string;
  readonly message: string;
}

let w: RailsWorld;
const traders: Trader[] = [];
const clients: Client[] = [];
const outcomes: Outcome[] = [];
const failures: Failure[] = [];
const workerFailures: { job: string; code: string; message: string }[] = [];
const timings = new Map<string, number[]>();
const walletsBefore = new Map<string, bigint>();
const budgetsBefore = new Map<string, bigint>();
let platformBudgetBefore = 0n;
let dayMs = 0;
/** Requests INRP2P's desk declined because no price at the market could leave it anything (GasFree, small amounts). */
let deskDeclined = 0;
/** Transfers that needed a second top-up because the energy they cost went up meanwhile: measured, not a failure. */
let refuelled = 0;

/** mulberry32: the day's mix is a function of its seed, so a failing day can be replayed exactly. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayMix(): Spec[] {
  const rnd = prng(SEED);
  const desks = traders.filter((t) => t.handle).length;
  return Array.from({ length: DEALS }, (_, i) => {
    const r = rnd();
    const entry: Entry = r < 0.4 && desks > 0 ? 'DESK_PAGE' : r < 0.85 ? 'INSTANT' : 'INRP2P_DESK';
    const direction: Direction = rnd() < 0.5 ? 'BUY_USDT' : 'SELL_USDT';
    // Whole USDT from 100 to 3,000: every amount any desk, firm offer and rail of the day can carry.
    const amount = String(100 + Math.floor(rnd() * 2901));
    const e = rnd();
    const ending: Ending = e < 0.8 ? 'COMPLETE' : e < 0.88 ? 'DECLINE' : e < 0.94 ? 'DISPUTE_THEN_CONFIRM' : 'DISPUTE_NOT_PAID';
    return { i, entry, direction, amount, desk: Math.floor(rnd() * Math.max(1, desks)), ending };
  });
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const list = timings.get(label) ?? [];
    list.push(performance.now() - started);
    timings.set(label, list);
  }
}

function summary(label: string) {
  const xs = [...(timings.get(label) ?? [])].sort((a, b) => a - b);
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
  return { step: label, n: xs.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), p99: Math.round(at(0.99)), max: Math.round(xs.at(-1) ?? 0) };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a person's page does: read the deal again until it shows what they are waiting for — or say it is stuck. */
async function until<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + STUCK_MS;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw Object.assign(new Error(`stuck waiting for ${what}: ${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}`), { code: 'STUCK' });
    await pause(40);
  }
}

const tradeOf = (tradeId: string) => w.app.selectFrom('trade').select(['ref', 'lifecycle_state', 'direction']).where('id', '=', tradeId).executeTakeFirstOrThrow();
const dealAs = (tradeId: string, viewer: 'CLIENT' | 'TRADER') => p2pDeal(w.app, w.deps.protector, { tradeId, viewer });

// ---- the worker, twice ------------------------------------------------------------------------------------------------

let running = true;

/** One instance of the worker's money jobs, in the order its schedule runs them, round and round until the day ends. */
async function workerInstance(n: number): Promise<void> {
  const job = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const out = (await timed(`worker.${name}`, fn)) as { failures?: readonly { code?: string; message?: string }[] } | undefined;
      for (const f of out?.failures ?? []) workerFailures.push({ job: name, code: f.code ?? 'FAILED', message: f.message ?? JSON.stringify(f) });
    } catch (e) {
      workerFailures.push({ job: name, code: (e as { code?: string }).code ?? 'THREW', message: e instanceof Error ? e.message : String(e) });
    }
  };
  while (running) {
    await job('tron_confirm', () => runTronConfirm(w.app, { chain: w.chain, providers: [] }));
    await job('autopay', () => runAutopay(w.app, w.rails));
    await job('sender', () => runSender(w.app, w.rails));
    // A block every turn of either instance: what was broadcast is included, what is final can settle.
    w.net.mine();
    await job('monitor', () => runMonitor(w.app, w.rails));
    await job('unwind_closing', () => runUnwindClosing(w.app));
    await job('hold_closing', () => runHoldClosing(w.app));
    await job('trader_orders_sweep', () => runTraderSweep(w.app));
    await job('escrow_deadlines', () => runP2pDeadlines(w.app));
    await pause(15 + n * 7);
  }
}

// ---- the people -------------------------------------------------------------------------------------------------------

/** A client checks out of the pool while it holds a live price: one live price per client is the product's own rule. */
const idleClients: number[] = [];
async function takeClient(): Promise<number> {
  for (;;) {
    const c = idleClients.shift();
    if (c !== undefined) return c;
    await pause(10);
  }
}

const marketRate = { SELL_USDT: '101.000000', BUY_USDT: '102.000000' } as const;

/** The price, by whichever door the deal came in; null when the client walked away from it. */
async function price(spec: Spec, client: Client): Promise<{ quoteId: string; entry: Entry } | null> {
  const wallet = spec.direction === 'SELL_USDT' ? { bankAccountId: client.bankAccountId } : { walletId: client.walletId };
  if (spec.entry === 'DESK_PAGE') {
    const desks = traders.filter((t) => t.handle);
    const desk = desks[spec.desk % desks.length]!;
    const q = await timed('price.desk_page', () => runAs(w.app, requestDeskQuote(client.admin.actor, w.railsDeps), client.admin.ref, 'desk_deal.request_quote', {
      handle: desk.handle!, direction: spec.direction, fixedSide: 'BASE' as const, amount: spec.amount, ...wallet,
    }));
    return { quoteId: q.quoteId, entry: 'DESK_PAGE' };
  }
  if (spec.entry === 'INSTANT') {
    const asked = await timed('price.instant', () => runAs(w.app, requestInstantQuote(client.admin.actor, w.railsDeps), client.admin.ref, 'request.instant_quote', {
      direction: spec.direction, fixedSide: 'BASE' as const, amount: spec.amount, ...wallet,
    }));
    if (asked.outcome.kind === 'QUOTED') return { quoteId: asked.outcome.quoteId, entry: 'INSTANT' };
    // Not priced at once (no firm offer fits): a person on INRP2P's desk prices the same request.
    return personPrices(spec, asked.requestId);
  }
  const request = await timed('price.request', () => runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: client.clientId, direction: spec.direction, fixedSide: 'BASE' as const, amount: spec.amount, ...wallet,
  }));
  return personPrices(spec, request.requestId);
}

/**
 * INRP2P's desk: routes the request to a trader at the rate it will quote, the trader accepts, the desk quotes it. A price
 * that would leave INRP2P less than nothing — a small amount on GasFree, whose network the deal pays in USDT — is refused
 * by the product (QUOTE_UNPROFITABLE), and the person declines the request, as they would.
 */
async function personPrices(spec: Spec, requestId: string): Promise<{ quoteId: string; entry: Entry } | null> {
  const clientRate = marketRate[spec.direction];
  const assigned = await timed('price.assign', () => runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId, plannedClientRate: clientRate }));
  const trader = await traderOfOrder(assigned.orderId);
  await timed('trader.accept_order', () => runAs(w.app, acceptOrder(trader.admin.actor), trader.admin.ref, 'trader_order.accept', { ref: assigned.ref }));
  const order = await w.app.selectFrom('trader_order').select('route_id').where('id', '=', assigned.orderId).executeTakeFirstOrThrow();
  const quote = await timed('price.quote', () => runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId, routeId: order.route_id, clientRate, validitySeconds: 300 }))
    .catch((e: unknown) => (isDomainError(e) && e.code === 'QUOTE_UNPROFITABLE' ? null : Promise.reject(e)));
  if (!quote) {
    await timed('price.desk_declines', () => runAs(w.app, declineRequest(w.dealer.actor), w.dealer.ref, 'request.decline', { requestId, reason: 'too small to cover the network at the market rate' }));
    deskDeclined += 1;
    return null;
  }
  await timed('price.send', () => runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId }));
  return { quoteId: quote.quoteId, entry: 'INRP2P_DESK' };
}

async function traderOfOrder(orderId: string): Promise<Trader> {
  const o = await w.app.selectFrom('trader_order').select('trader_id').where('id', '=', orderId).executeTakeFirstOrThrow();
  const t = traders.find((x) => x.traderId === o.trader_id);
  if (!t) throw new Error(`order ${orderId} went to a trader outside the day`);
  return t;
}

/** The seller's USDT on its way into the escrow: a transfer on chain, handed in by its hash. The worker confirms it. */
async function intoEscrow(from: string, to: string, amountMinor: bigint) {
  const receipt = w.chain.add({ from, to, amountMinor });
  await timed('chain.detect', () => runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex }));
}

/** A client buys USDT: the trader funds the escrow, the client pays the trader's account, the trader confirms. */
async function runBuy(spec: Spec, client: Client, trader: Trader, tradeId: string, orderRef: string) {
  const { ref: tradeRef } = await tradeOf(tradeId);
  const issued = await timed('trader.delivery_address', () => runAs(w.app, orderDeliveryAddress(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.delivery_address', { ref: orderRef }));
  await intoEscrow(trader.walletAddress, issued.address, Money.parse(issued.amount, 'USDT').minor);
  const t0 = performance.now();
  const funded = await until('the escrow to show funded to the client', () => dealAs(tradeId, 'CLIENT'), (d) => d?.escrowFunded === true && d.step === 'PAY');
  timings.set('wait.escrow_funded', [...(timings.get('wait.escrow_funded') ?? []), performance.now() - t0]);
  expect(funded!.payTo).toMatchObject({ holderName: trader.holder });

  await timed('client.claim_paid', () => runAs(w.app, claimIncomingFiat(client.admin.actor), client.admin.ref, 'fiat_in.claim', { tradeRef, rail: 'IMPS' as const, utr: utr(), fromBankAccountId: client.bankAccountId }));
  await until('the trader to see the claim', () => dealAs(tradeId, 'TRADER'), (d) => d?.step === 'CONFIRM');

  if (spec.ending === 'DISPUTE_THEN_CONFIRM' || spec.ending === 'DISPUTE_NOT_PAID') {
    await timed('trader.dispute', () => runAs(w.app, disputeOrderPayment(trader.admin.actor), trader.admin.ref, 'trader_order.dispute', { ref: orderRef, reason: 'NO_CREDIT' as const, note: 'Nothing in my statement yet' }));
    await timed('client.answer_dispute', () => runAs(w.app, answerClientDispute(client.admin.actor), client.admin.ref, 'escrow_dispute.answer', { tradeRef, note: 'Sent by IMPS, UTR on the deal' }));
    if (spec.ending === 'DISPUTE_NOT_PAID') {
      await timed('inrp2p.decide', () => runAs(w.app, decideP2pPayment(w.dealer.actor, w.settlementDeps), w.dealer.ref, 'escrow_payment.decide', { tradeId, decision: 'NOT_PAID' as const, notes: 'No credit on the trader’s statement' }));
      return;
    }
  }
  await timed('trader.confirm_received', () => runAs(w.app, confirmOrderPaymentReceived(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.confirm_received', { ref: orderRef, senderName: client.holder }));
}

/** A client sells USDT: the client funds the escrow, the trader pays the client's account, the client confirms. */
async function runSell(spec: Spec, client: Client, trader: Trader, tradeId: string, orderRef: string) {
  const { ref: tradeRef } = await tradeOf(tradeId);
  const deposit = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.address', 'a.expected_amount_minor']).where('a.trade_id', '=', tradeId).executeTakeFirstOrThrow();
  await intoEscrow(client.walletAddress, deposit.address, deposit.expected_amount_minor!);
  const t0 = performance.now();
  const due = await until('the trader to be told to pay', () => dealAs(tradeId, 'TRADER'), (d) => d?.escrowFunded === true && d.step === 'PAY');
  timings.set('wait.escrow_funded', [...(timings.get('wait.escrow_funded') ?? []), performance.now() - t0]);
  expect(due!.payTo).toMatchObject({ holderName: client.holder });

  const paid = await timed('trader.submit_payment', () => runAs(w.app, submitOrderPayment(trader.admin.actor), trader.admin.ref, 'trader_order.submit_payment', { ref: orderRef, rail: 'IMPS' as const, utr: utr() }));
  await until('the client to be asked to confirm', () => dealAs(tradeId, 'CLIENT'), (d) => d?.step === 'CONFIRM');

  if (spec.ending === 'DISPUTE_THEN_CONFIRM' || spec.ending === 'DISPUTE_NOT_PAID') {
    await timed('client.dispute', () => runAs(w.app, openClientDispute(client.admin.actor), client.admin.ref, 'escrow_dispute.open', { tradeRef, reason: 'NO_CREDIT' as const, note: 'Nothing in my statement yet' }));
    await timed('trader.answer_dispute', () => runAs(w.app, answerOrderDispute(trader.admin.actor), trader.admin.ref, 'trader_order.answer_dispute', { ref: orderRef, note: 'Paid by IMPS, UTR on the order' }));
    if (spec.ending === 'DISPUTE_NOT_PAID') {
      await timed('inrp2p.decide', () => runAs(w.app, decideP2pPayment(w.dealer.actor, w.settlementDeps), w.dealer.ref, 'escrow_payment.decide', { tradeId, decision: 'NOT_PAID' as const, notes: 'No credit on the client’s statement' }));
      return;
    }
  }
  await timed('client.confirm_received', () => runAs(w.app, confirmClientReceipt(client.admin.actor, w.settlementDeps), client.admin.ref, 'payout.confirm_received', { tradeRef, legRef: paid.settlementRef, senderName: trader.holder }));
}

/** One deal, as its people make it; a refusal anywhere is recorded with its step rather than ending the day. */
async function runDeal(spec: Spec): Promise<void> {
  let step = 'price';
  let clientIndex = -1;
  let tradeId: string | null = null;
  let entryUsed: Entry | null = null;
  let traderId: string | null = null;
  const started = performance.now();
  try {
    clientIndex = await takeClient();
    const client = clients[clientIndex]!;
    let priced: Awaited<ReturnType<typeof price>>;
    try {
      priced = await price(spec, client);
      if (!priced) {
        outcomes.push({ spec, tradeId: null, entryUsed: 'INRP2P_DESK', expected: 'NO_TRADE', traderId: null, clientIndex, send: null, funded: false });
        return;
      }
      entryUsed = priced.entry;
      if (spec.ending === 'DECLINE') {
        step = 'decline';
        await timed('client.decline', () => runAs(w.app, rejectQuote(client.admin.actor), client.admin.ref, 'quote.reject', { quoteId: priced!.quoteId }));
        outcomes.push({ spec, tradeId: null, entryUsed, expected: 'NO_TRADE', traderId: null, clientIndex, send: null, funded: false });
        return;
      }
      step = 'accept';
      const accepted = await timed('client.accept', () => runAs(w.app, acceptQuote(client.admin.actor, w.railsDeps), client.admin.ref, 'quote.accept', { quoteId: priced!.quoteId }));
      tradeId = accepted.tradeId;
    } finally {
      // The live price is decided: the client may ask for its next one while this deal runs.
      idleClients.push(clientIndex);
    }
    const order = await w.app.selectFrom('trader_order').select(['ref', 'trader_id']).where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
    traderId = order.trader_id;
    const trader = traders.find((t) => t.traderId === order.trader_id);
    if (!trader) throw new Error(`deal ${spec.i} went to a trader outside the day`);
    step = spec.direction === 'BUY_USDT' ? 'buy' : 'sell';
    if (spec.direction === 'BUY_USDT') await runBuy(spec, client, trader, tradeId, order.ref);
    else await runSell(spec, client, trader, tradeId, order.ref);

    step = 'settle';
    const end = spec.ending === 'DISPUTE_NOT_PAID' ? 'CANCELLED' : 'COMPLETED';
    const t0 = performance.now();
    await until(`the deal to be ${end}`, () => tradeOf(tradeId!).then((t) => t.lifecycle_state), (s) => s === end);
    timings.set('wait.payout', [...(timings.get('wait.payout') ?? []), performance.now() - t0]);
    timings.set('deal.total', [...(timings.get('deal.total') ?? []), performance.now() - started]);
    const buy = spec.direction === 'BUY_USDT';
    const send: Purpose = end === 'COMPLETED' ? (buy ? 'CLIENT_PAYOUT' : 'ROUTE_PAYMENT') : (buy ? 'ESCROW_RETURN' : 'REFUND');
    outcomes.push({ spec, tradeId, entryUsed, expected: end, traderId, clientIndex, send, funded: true });
  } catch (e) {
    failures.push({
      deal: spec.i, step: `${spec.entry}/${spec.direction}/${spec.ending}: ${step}`,
      code: (e as { code?: string }).code ?? (isDomainError(e) ? e.code : 'ERROR'), message: e instanceof Error ? e.message.slice(0, 400) : String(e),
    });
    if (tradeId) outcomes.push({ spec, tradeId, entryUsed, expected: 'COMPLETED', traderId, clientIndex, send: null, funded: false });
  }
}

/** A deal one side walks away from: priced and accepted, perhaps funded — and then nobody does the next step. */
async function abandonDeal(kind: Abandon, i: number, into: Outcome[]): Promise<void> {
  const direction: Direction = kind.startsWith('BUY') ? 'BUY_USDT' : 'SELL_USDT';
  const spec: Spec = { i: DEALS + i, entry: i % 2 === 0 || !traders.some((t) => t.handle) ? 'INSTANT' : 'DESK_PAGE', direction, amount: String(1500 + 37 * i), desk: i, ending: 'ABANDONED' };
  let step = 'price';
  try {
    const clientIndex = await takeClient();
    const client = clients[clientIndex]!;
    let tradeId: string;
    let entryUsed: Entry;
    try {
      const priced = (await price(spec, client))!;
      entryUsed = priced.entry;
      step = 'accept';
      tradeId = (await runAs(w.app, acceptQuote(client.admin.actor, w.railsDeps), client.admin.ref, 'quote.accept', { quoteId: priced.quoteId })).tradeId;
    } finally {
      idleClients.push(clientIndex);
    }
    const order = await w.app.selectFrom('trader_order').select(['ref', 'trader_id']).where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
    const trader = traders.find((t) => t.traderId === order.trader_id)!;
    step = 'fund';
    if (kind === 'BUY_UNPAID') {
      const issued = await runAs(w.app, orderDeliveryAddress(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.delivery_address', { ref: order.ref });
      await intoEscrow(trader.walletAddress, issued.address, Money.parse(issued.amount, 'USDT').minor);
      await until('the escrow to show funded', () => dealAs(tradeId, 'CLIENT'), (d) => d?.escrowFunded === true && d.step === 'PAY');
    } else if (kind === 'SELL_UNPAID') {
      const deposit = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
        .select(['d.address', 'a.expected_amount_minor']).where('a.trade_id', '=', tradeId).executeTakeFirstOrThrow();
      await intoEscrow(client.walletAddress, deposit.address, deposit.expected_amount_minor!);
      await until('the trader to be told to pay', () => dealAs(tradeId, 'TRADER'), (d) => d?.escrowFunded === true && d.step === 'PAY');
    }
    const send: Purpose | null = kind === 'BUY_UNPAID' ? 'ESCROW_RETURN' : kind === 'SELL_UNPAID' ? 'REFUND' : null;
    into.push({ spec, tradeId, entryUsed, expected: 'CANCELLED', traderId: order.trader_id, clientIndex, send, funded: send !== null });
  } catch (e) {
    failures.push({ deal: spec.i, step: `${kind}: ${step}`, code: (e as { code?: string }).code ?? 'ERROR', message: e instanceof Error ? e.message.slice(0, 400) : String(e) });
  }
}

/** The deposit scanner read the whole chain, up to its head, `minutes` from now: a transfer sent before then is seen. */
async function chainReadAt(minutes: number) {
  const at = new Date(Date.now() + minutes * 60_000);
  await w.t.owner.insertInto('chain_cursor').values({ network: 'TRON', scanner: 'tron_deposits', last_scanned_block: 1n, last_window_to: 1n, last_complete: true, last_run_at: at })
    .onConflict((oc) => oc.columns(['network', 'scanner']).doUpdateSet({ last_window_to: 1n, last_complete: true, last_run_at: at })).execute();
}

// ---- the day ----------------------------------------------------------------------------------------------------------

const r = (d: string) => Rate.parse(d, 'ROUTE').micro;

beforeAll(async () => {
  w = await createRailsWorld('market', { resourceMode: RAILS });
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, riskPolicy: null, reason: 'a market day: P2P escrow' });

  for (let i = 0; i < TRADERS; i++) {
    const name = `Trader ${String(i + 1).padStart(2, '0')}`;
    // Each a little apart, so the instant prices have a best trader to choose and the desk a choice to route.
    const t = await railsTrader(w, name, {
      buy: { capacity: '900000000', rate: (101.8 - 0.04 * (i % 10)).toFixed(2), min: '100', max: '50000000' },
      sell: { capacity: '9000000', rate: (101.2 + 0.04 * (i % 10)).toFixed(2), min: '10', max: '500000' },
    }, '200000');
    for (const side of ['BUY_USDT', 'SELL_USDT'] as const) {
      const block = await w.app.selectFrom('trader_block').select('version').where('trader_id', '=', t.traderId).where('side', '=', side).executeTakeFirstOrThrow();
      await runAs(w.app, updateBlock(t.admin.actor), t.admin.ref, 'trader.update_block', { side, expectedVersion: block.version, firmHours: 24 });
    }
    let handle: string | null = null;
    if (i % 2 === 0) {
      handle = `market-desk-${i + 1}`;
      await runAs(w.app, openDesk(t.admin.actor), t.admin.ref, 'desk.open', { handle, displayName: `${name} Desk` });
      await runAs(w.app, setDeskPrices(t.admin.actor), t.admin.ref, 'desk.set_prices', {
        prices: [
          { direction: 'SELL_USDT' as const, rate: '100.900000', min: '100', max: '20000', live: true },
          { direction: 'BUY_USDT' as const, rate: '102.100000', min: '100', max: '20000', live: true },
        ],
        validForHours: 12,
      });
      await runAs(w.app, setDeskStatus(t.admin.actor), t.admin.ref, 'desk.set_status', { expectedVersion: (await deskOfTrader(w.app, t.traderId))!.version, status: 'LIVE' as const });
    }
    traders.push({ ...t, name, holder: `${name} LLP`, handle });
  }

  // Automatic prices on, against a fresh market (ADR 0025).
  await runMarketReferenceRefresh(w.app, async () => ({ bidMicro: r('101.00'), askMicro: r('102.00'), source: 'market: a market day' }));
  await runAs(w.app, setPricingPolicy(w.owner.actor), w.owner.ref, 'pricing.set_policy', { expectedPolicyId: (await currentPricingPolicy(w.app)).id, autoQuote: true, reason: 'a market day' });

  for (let i = 0; i < CLIENTS; i++) {
    const name = `Client ${String(i + 1).padStart(3, '0')}`;
    clients.push({ ...(await traderClient(w, name)), name, holder: `${name} LLP` });
    idleClients.push(i);
  }

  // Everyone starts the day holding USDT, as a trader that sells it and a client that sells it do: from an exchange account
  // outside INRP2P. (A USDT transfer to a wallet that holds none costs about twice the energy; the day still has those —
  // a client buying into an emptied wallet, a trader that paid all of its USDT out — but not on every deal.)
  const outside = encodeTronAddress(randomBytes(20));
  for (const a of [...clients.map((c) => c.walletAddress), ...traders.map((t) => t.walletAddress)]) w.chain.add({ from: outside, to: a, amountMinor: Money.parse('5000000', 'USDT').minor });
  for (const a of [...clients.map((c) => c.walletAddress), ...traders.map((t) => t.walletAddress)]) walletsBefore.set(a, w.chain.balanceOf(a));
  for (const t of traders) budgetsBefore.set(t.traderId, (await budgetFigures(w.app, t.traderId)).availableSun);
  platformBudgetBefore = (await budgetFigures(w.app, null)).availableSun;
}, 600_000);

afterAll(async () => {
  running = false;
  await w?.close();
});

describe(`a market day: ${DEALS} deals, ${LANES} people at once, ${TRADERS} traders, ${CLIENTS} clients, ${WORKERS} workers, ${RAILS}`, () => {
  it('runs every deal from its price to its end', async () => {
    const mix = dayMix();
    const workers = Array.from({ length: WORKERS }, (_, n) => workerInstance(n));
    const started = performance.now();
    let next = 0;
    await Promise.all(Array.from({ length: LANES }, async () => {
      for (let i = next++; i < mix.length; i = next++) await runDeal(mix[i]!);
    }));
    dayMs = performance.now() - started;
    running = false;
    await Promise.all(workers);

    if (failures.length > 0) console.table(failures);
    expect(failures).toEqual([]);
  }, 1_800_000);

  it('gives each side its own back when the other never acts: the time runs out, the deal ends, the escrow returns', async () => {
    running = true;
    const workers = Array.from({ length: WORKERS }, (_, n) => workerInstance(n));
    const kinds: Abandon[] = ['BUY_UNFUNDED', 'BUY_UNPAID', 'SELL_UNFUNDED', 'SELL_UNPAID'];
    const left: Outcome[] = [];
    await Promise.all(Array.from({ length: ABANDONED * kinds.length }, (_, i) => abandonDeal(kinds[i % kinds.length]!, i, left)));
    expect(failures).toEqual([]);

    // Nobody acts. The chain has been read past every deadline; the business clock moves on: the warning, then the end.
    await chainReadAt(90);
    const clock = await w.t.pinnedClock();
    for (const minutes of [40, 85]) {
      await clock.set(new Date(Date.now() + minutes * 60_000));
      const out = await timed('deadlines.run', () => runP2pDeadlines(clock.db));
      expect(out.failures).toEqual([]);
    }
    await clock.set(null);

    // The worker sends each seller its own USDT back from the escrow; a deal nobody funded just ends.
    for (const o of left) {
      await until(`abandoned deal ${o.spec.i} to end with ${o.send ?? 'nothing'} sent`, async () => ({
        state: (await tradeOf(o.tradeId!)).lifecycle_state,
        sent: (await w.app.selectFrom('chain_send').select('purpose').where('trade_id', '=', o.tradeId!).where('status', '=', 'CONFIRMED').where('purpose', '<>', 'TOPUP').execute()).map((x) => x.purpose),
      }), (v) => v.state === 'CANCELLED' && (o.send === null ? v.sent.length === 0 : v.sent.includes(o.send)));
    }
    running = false;
    await Promise.all(workers);
    outcomes.push(...left);
    expect(left).toHaveLength(ABANDONED * kinds.length);
  }, 600_000);

  it('leaves nothing between steps: every deal ended as its people ended it, and nothing is left to send', async () => {
    const opened = outcomes.filter((o) => o.tradeId);
    const states = await w.app.selectFrom('trade').select(['id', 'ref', 'lifecycle_state']).where('id', 'in', opened.map((o) => o.tradeId!)).execute();
    const stateOf = new Map(states.map((s) => [s.id, s]));
    const wrong = opened.filter((o) => stateOf.get(o.tradeId!)?.lifecycle_state !== o.expected).map((o) => ({ deal: o.spec.i, ref: stateOf.get(o.tradeId!)?.ref, expected: o.expected, is: stateOf.get(o.tradeId!)?.lifecycle_state }));
    expect(wrong).toEqual([]);

    // The worker has nothing left: no send open, no order holding capacity, no network hold, no unwind waiting.
    expect(await w.app.selectFrom('chain_send').select(['id', 'purpose', 'status']).where('status', 'not in', ['CONFIRMED', 'CANCELLED']).execute()).toEqual([]);
    expect(await w.app.selectFrom('trader_order').select(['ref', 'status']).where('status', 'in', ['OFFERED', 'ACCEPTED', 'IN_PROGRESS']).where('trade_id', 'is not', null).execute()).toEqual([]);
    expect(await w.app.selectFrom('network_budget_hold').select(['trade_id', 'status']).where('status', '=', 'ACTIVE').where('trade_id', 'in', opened.map((o) => o.tradeId!)).execute()).toEqual([]);
    expect(workerFailures).toEqual([]);
  });

  it('paid each deal once: one payout, or one return, per deal — never two — and fuelled no transfer past its cap', async () => {
    const sends = await w.app.selectFrom('chain_send').select(['id', 'trade_id', 'purpose', 'parent_send_id']).where('status', '=', 'CONFIRMED').where('trade_id', 'is not', null).execute();
    const counted = new Map<string, number>();
    for (const s of sends.filter((x) => x.purpose !== 'TOPUP')) counted.set(`${s.trade_id}:${s.purpose}`, (counted.get(`${s.trade_id}:${s.purpose}`) ?? 0) + 1);
    expect([...counted.entries()].filter(([, n]) => n > 1)).toEqual([]);
    // A transfer may need a second top-up — its recipient emptied its wallet meanwhile, and a USDT transfer to an address
    // holding none costs about twice the energy — but never more TRX than the cap its trade fixed for it (ADR 0017 §2).
    const fuelled = await sql<{ ref: string; cap: string; used: string; topups: string }>`
      select p.ref, p.network_cap_sun::text as cap, inrp2p_send_network_used(p.id)::text as used,
             (select count(*) from chain_send t where t.parent_send_id = p.id and t.purpose = 'TOPUP' and t.status = 'CONFIRMED')::text as topups
        from chain_send p where p.network_cap_sun is not null and p.trade_id is not null`.execute(w.app);
    expect(fuelled.rows.filter((f) => BigInt(f.used) > BigInt(f.cap))).toEqual([]);
    refuelled = fuelled.rows.filter((f) => Number(f.topups) > 1).length;
    for (const o of outcomes.filter((x) => x.tradeId)) {
      const purposes = sends.filter((s) => s.trade_id === o.tradeId && ['CLIENT_PAYOUT', 'ROUTE_PAYMENT', 'ESCROW_RETURN', 'REFUND'].includes(s.purpose)).map((s) => s.purpose);
      expect({ deal: o.spec.i, purposes }).toEqual({ deal: o.spec.i, purposes: o.send ? [o.send] : [] });
    }
  });

  it('moved every wallet by exactly its deals, and left exactly INRP2P’s margin at every escrow', async () => {
    const expected = new Map<string, bigint>();
    const add = (address: string, minor: bigint) => expected.set(address, (expected.get(address) ?? 0n) + minor);
    for (const o of outcomes.filter((x) => x.tradeId && x.funded)) {
      const econ = await w.app.selectFrom('trade_economics').select(['base_minor', 'route_base_minor', 'gross_margin_base_minor']).where('trade_id', '=', o.tradeId!).executeTakeFirstOrThrow();
      const order = await w.app.selectFrom('trader_order').select('base_minor').where('trade_id', '=', o.tradeId!).executeTakeFirstOrThrow();
      const client = clients[o.clientIndex]!;
      const trader = traders.find((t) => t.traderId === o.traderId)!;
      const out = await w.app.selectFrom('chain_send').select(['id', 'from_address', 'amount_minor', 'fee_cap_usdt_minor']).where('trade_id', '=', o.tradeId!).where('purpose', '=', o.send!).executeTakeFirstOrThrow();
      // On GasFree a return or a refund goes back less its own network, taken by the controller from the escrow (ADR 0022
      // §2.3) — never more than the send's cap. In TRX the trader's deposit pays it, and the whole amount goes back.
      const permit = await w.app.selectFrom('gasfree_permit').select(sql<string>`coalesce(sum(fee_minor), 0)::text`.as('charged'))
        .where('send_id', '=', out.id).where('status', '=', 'CONFIRMED').executeTakeFirstOrThrow();
      const ownNetwork = o.send === 'ESCROW_RETURN' || o.send === 'REFUND' ? BigInt(permit.charged) : 0n;
      if (RAILS === 'BURN') expect(ownNetwork).toBe(0n);
      else expect({ deal: o.spec.i, charged: ownNetwork, withinCap: ownNetwork <= (out.fee_cap_usdt_minor ?? 0n) }).toEqual({ deal: o.spec.i, charged: ownNetwork, withinCap: true });
      // The seller's USDT went in; it comes out once — to the buyer, or back to the seller.
      if (o.spec.direction === 'BUY_USDT') add(trader.walletAddress, -order.base_minor);
      else add(client.walletAddress, -econ.base_minor);
      if (o.send === 'CLIENT_PAYOUT') add(client.walletAddress, econ.base_minor);
      else if (o.send === 'ROUTE_PAYMENT') add(trader.walletAddress, econ.route_base_minor!);
      else if (o.send === 'ESCROW_RETURN') add(trader.walletAddress, order.base_minor - ownNetwork);
      else add(client.walletAddress, econ.base_minor - ownNetwork);
      const left = w.chain.balanceOf(out.from_address);
      if (o.expected === 'CANCELLED') expect({ deal: o.spec.i, left }).toEqual({ deal: o.spec.i, left: 0n });
      else if (RAILS === 'BURN') expect({ deal: o.spec.i, left }).toEqual({ deal: o.spec.i, left: econ.gross_margin_base_minor });
      else expect(left >= 0n && left <= econ.gross_margin_base_minor!, `deal ${o.spec.i}: ${left} left of a ${econ.gross_margin_base_minor} margin`).toBe(true);
    }
    const moved = [...walletsBefore.keys()].map((a) => ({ address: a, moved: w.chain.balanceOf(a) - walletsBefore.get(a)! }));
    expect(moved.filter((m) => m.moved !== (expected.get(m.address) ?? 0n)).map((m) => ({ ...m, expected: expected.get(m.address) ?? 0n }))).toEqual([]);
  });

  it('kept the books: balanced, no rupee on an INRP2P account, no capacity or TRX still held, the platform’s TRX untouched', async () => {
    expect(await globalImbalance(w.app)).toEqual([]);
    const inr = await sql<{ code: string; net: string }>`
      select a.code, sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end)::text as net
      from ledger_entry e join ledger_account a on a.id = e.account_id
      where a.code like 'ASSET:INR_SETTLEMENT:%' group by a.code having sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) <> 0`.execute(w.app);
    expect(inr.rows).toEqual([]);
    const held = await sql<{ trader_id: string; side: string; reserved: string; open: string }>`
      select b.trader_id, b.side, b.reserved_minor::text as reserved,
             coalesce((select sum(o.capacity_minor) from trader_order o where o.trader_id = b.trader_id and o.side = b.side and o.status in ('OFFERED', 'ACCEPTED', 'IN_PROGRESS')), 0)::text as open
      from trader_block b`.execute(w.app);
    expect(held.rows.filter((b) => b.reserved !== b.open)).toEqual([]);
    for (const t of traders) {
      const now = await budgetFigures(w.app, t.traderId);
      const spent = await w.app.selectFrom('network_budget_hold').select(sql<string>`coalesce(sum(spent_sun), 0)::text`.as('spent')).where('trader_id', '=', t.traderId).executeTakeFirstOrThrow();
      // What a trader's TRX deposit lost is exactly what its deals' transfers spent.
      expect({ trader: t.name, lost: budgetsBefore.get(t.traderId)! - now.availableSun }).toEqual({ trader: t.name, lost: BigInt(spent.spent) });
    }
    expect((await budgetFigures(w.app, null)).availableSun).toBe(platformBudgetBefore);
    const utrs = await sql<{ utr: string }>`select utr from fiat_transfer group by utr having count(*) > 1`.execute(w.app);
    expect(utrs.rows).toEqual([]);
    const shared = await sql<{ deposit_address_id: string }>`
      select deposit_address_id from deposit_assignment where released_at is null group by deposit_address_id having count(*) > 1`.execute(w.app);
    expect(shared.rows).toEqual([]);
  });

  it('reports what the day measured', () => {
    const done = outcomes.filter((o) => o.expected !== 'NO_TRADE').length;
    const byEntry = Object.fromEntries((['DESK_PAGE', 'INSTANT', 'INRP2P_DESK'] as const).map((e) => [e, outcomes.filter((o) => o.entryUsed === e).length]));
    const ended = Object.fromEntries((['COMPLETE', 'DECLINE', 'DISPUTE_THEN_CONFIRM', 'DISPUTE_NOT_PAID', 'ABANDONED'] as const).map((e) => [e, outcomes.filter((o) => o.spec.ending === e).length]));
    console.log(`market day (${RAILS}, seed ${SEED}): ${outcomes.length} deals in ${(dayMs / 1000).toFixed(1)} s — ${done} trades, ${(done / (dayMs / 60_000)).toFixed(0)} trades a minute; by entry ${JSON.stringify(byEntry)}; endings ${JSON.stringify(ended)}; ${deskDeclined} requests declined by INRP2P's desk as unprofitable; ${refuelled} transfers topped up twice`);
    console.table([...timings.keys()].sort().map(summary));
    if (process.env.MARKET_TIMINGS_OUT) writeFileSync(process.env.MARKET_TIMINGS_OUT, JSON.stringify({ dayMs, trades: done, steps: [...timings.keys()].sort().map(summary) }, null, 2));
    expect(outcomes.length).toBe(DEALS + ABANDONED * 4);
  });
});
