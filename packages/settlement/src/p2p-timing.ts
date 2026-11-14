import { sql } from 'kysely';
import { DomainError, type InrRail, P2P_RAIL_ORDER, type P2pTiming, RAIL_NOT_TAKEN, type RailOption, railOptions, railOptionsFor, requireOneOf, requireP2pTiming, requireUuid } from '@inrp2p/kernel';
import { type UsableUpiId, activeUpiId, pauseUpiIdInTx, usableUpiId } from '@inrp2p/clients';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { lockTrade } from '@inrp2p/trades';

/** The business clock (`inrp2p_now()`), which every deadline of a deal is judged by. */
export async function dealNow(ex: Executor): Promise<Date> {
  return (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex)).rows[0]!.now;
}

/** The programme's timing now. */
export async function programP2pTiming(ex: Executor): Promise<P2pTiming> {
  const r = await ex.selectFrom('trader_program').select('p2p_timing').where('id', '=', 1).executeTakeFirstOrThrow();
  return requireP2pTiming(r.p2p_timing);
}

/**
 * Where a P2P deal stands on its rupees, as its deadlines need it: whether the escrow is final and since when, whose
 * account the rupees go to, and whether a payment was said to be sent.
 */
export interface P2pPayState {
  readonly tradeId: string;
  readonly ref: string;
  readonly clientId: string;
  readonly buy: boolean;
  readonly lifecycle: string;
  readonly hold: boolean;
  readonly inrMinor: bigint;
  /** When the seller's USDT was final in the escrow; null while it is not. */
  readonly fundedAt: Date | null;
  /** The payee's own account, when it is active and can be shown to the buyer. */
  readonly payeeAccountId: string | null;
  /** Since when that account could be shown: a payee whose account changed after the escrow shows the new one from then. */
  readonly payeeReadyAt: Date | null;
  /** A rupee payment is said to be sent and is not failed or cancelled. */
  readonly filed: boolean;
  /** Any rupee payment was ever said to be sent: such a deal is never cancelled for time — a person decides. */
  readonly everFiled: boolean;
  readonly unwound: boolean;
  /**
   * The rails the trader's side of the deal uses (`dealRails`) — how it pays, or is paid. Null when the deal has no
   * trader's side to ask.
   */
  readonly rails: readonly InrRail[] | null;
  /** Who receives the rupees: the trader's own client on a client's BUY, the client on its SELL. */
  readonly payeeClientId: string | null;
  /**
   * The payee's live UPI ID this deal is paid to by UPI (ADR 0029/0030): the one its window was opened with, while it is
   * still live — or, before the window opens, the one that can take the amount now. Null: no UPI on this deal.
   */
  readonly payeeUpi: UsableUpiId | null;
}

/** Why UPI is not offered although the amount and the trader's side allow it: the payee has no UPI ID that can take it. */
export const RAIL_NO_UPI_ID = 'no UPI ID to pay to';

/**
 * The ways to pay one deal, best first: what its amount allows among what its trader's side uses (`railOptionsFor`) — and
 * UPI only when the payee has a live UPI ID that can take it (ADR 0029). There is no UPI address but a registered one.
 * A deal is never left with no way to pay: without UPI the amount's bank rails stand.
 */
export function dealPayOptions(inrMinor: bigint, rails: readonly InrRail[] | null, hasUpi: boolean): readonly RailOption[] {
  const options = railOptionsFor(inrMinor, rails);
  if (hasUpi || !options.some((o) => o.rail === 'UPI' && o.possible)) return options;
  const noUpi = (list: readonly RailOption[]) => list.map((o) => (o.rail === 'UPI' && o.possible ? { rail: o.rail, possible: false, limit: RAIL_NO_UPI_ID } : o));
  let narrowed = noUpi(options);
  // The side takes UPI only, and there is no UPI ID to pay: the amount's own bank rails, rather than nothing.
  if (!narrowed.some((o) => o.possible)) narrowed = noUpi(railOptions(inrMinor));
  return [...narrowed.filter((o) => o.possible), ...narrowed.filter((o) => !o.possible)];
}

/**
 * The rails a deal's rupees may travel by: what the trader's side of the order behind the trade says — `trader_block.rails`,
 * "Clients pay you by" on a side that sells USDT, "You pay clients by" on one that buys. It is the one setting about rails
 * a person chose and can change; what the amount allows is `railOptionsFor`'s to add. Until this was read, a deal offered
 * whatever the amount allowed — UPI and its fifteen minutes to a trader who had said it takes no UPI.
 *
 * The list on a bank account (`rail_preferences`) is not read here: on most accounts nobody chose it (the client's own
 * form never asked), and a deal must not be refused a way to pay by a list its owner cannot see or change.
 */
export async function dealRails(ex: Executor, input: { readonly tradeId: string }): Promise<readonly InrRail[] | null> {
  const side = await ex
    .selectFrom('trader_order as o')
    .innerJoin('trader_block as b', 'b.id', 'o.block_id')
    .select('b.rails')
    .where('o.trade_id', '=', input.tradeId)
    .orderBy('o.offered_at', 'desc')
    .executeTakeFirst();
  return side ? P2P_RAIL_ORDER.filter((r) => side.rails.includes(r)) : null;
}

export async function p2pPayState(ex: Executor, tradeId: string): Promise<P2pPayState | null> {
  const t = await ex
    .selectFrom('trade as t')
    .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
    .innerJoin('route_obligation as o', 'o.trade_id', 't.id')
    .innerJoin('liquidity_route as r', 'r.id', 'o.route_id')
    .select(['t.id', 't.ref', 't.client_id', 't.direction', 't.lifecycle_state', 't.hold', 'e.route_execution_mode', 'e.quote_inr_minor', 'o.id as obligation_id', 'r.trader_id'])
    .where('t.id', '=', requireUuid(tradeId, 'tradeId'))
    .executeTakeFirst();
  if (!t || t.route_execution_mode !== 'P2P') return null;
  const buy = t.direction === 'BUY_USDT';
  const legs = await ex.selectFrom('settlement_leg').select(['side', 'payer', 'status', 'asset', 'confirmed_at']).where('trade_id', '=', t.id).execute();
  const rupees = legs.filter((l) => l.asset === 'INR' && (buy ? l.side === 'CLIENT_TO_EXCHANGE' : l.side === 'EXCHANGE_TO_CLIENT'));
  const filed = rupees.some((l) => l.status === 'PENDING' || l.status === 'PROCESSING' || l.status === 'COMPLETED');
  let fundedAt: Date | null;
  if (buy) {
    const r = await sql<{ d: boolean; at: Date | null }>`
      select inrp2p_counterparty_delivered(${t.obligation_id}::uuid) as d,
             (select max(confirmed_at) from route_settlement where route_obligation_id = ${t.obligation_id} and flow = 'FROM_ROUTE_TO_EXCHANGE' and status = 'CONFIRMED') as at`.execute(ex);
    fundedAt = r.rows[0]!.d ? r.rows[0]!.at : null;
  } else {
    const confirmed = legs.filter((l) => l.side === 'CLIENT_TO_EXCHANGE' && l.status === 'COMPLETED' && l.confirmed_at).map((l) => l.confirmed_at!.getTime());
    fundedAt = confirmed.length > 0 ? new Date(Math.max(...confirmed)) : null;
  }
  const accountId = buy
    ? (await ex.selectFrom('trader_profile').select('bank_account_id').where('id', '=', t.trader_id!).executeTakeFirst())?.bank_account_id ?? null
    : (await sql<{ bank_account_id: string | null }>`select bank_account_id from inrp2p_trade_payout_destination(${t.id}::uuid)`.execute(ex)).rows[0]?.bank_account_id ?? null;
  const account = accountId ? await ex.selectFrom('bank_account').select(['status', 'created_at']).where('id', '=', accountId).executeTakeFirst() : undefined;
  const active = account?.status === 'ACTIVE';
  const unwound = buy ? false : (await ex.selectFrom('p2p_unwind').select('trade_id').where('trade_id', '=', t.id).executeTakeFirst()) !== undefined;
  const rails = await dealRails(ex, { tradeId: t.id });
  const payeeClientId = buy ? ((await ex.selectFrom('trader_profile').select('client_id').where('id', '=', t.trader_id!).executeTakeFirst())?.client_id ?? null) : t.client_id;
  // A deal keeps the UPI ID its window was opened with (or none); before that, the payee's UPI ID that can take it now.
  const opened = await ex.selectFrom('p2p_pay_window').select('payee_upi_id').where('trade_id', '=', t.id).executeTakeFirst();
  const upiWanted = rails === null || rails.includes('UPI');
  const payeeUpi = opened
    ? (opened.payee_upi_id ? await activeUpiId(ex, opened.payee_upi_id) : null)
    : upiWanted && payeeClientId ? await usableUpiId(ex, payeeClientId, t.quote_inr_minor) : null;
  return {
    tradeId: t.id, ref: t.ref, clientId: t.client_id, buy, lifecycle: t.lifecycle_state, hold: t.hold, inrMinor: t.quote_inr_minor, fundedAt,
    payeeAccountId: active ? accountId : null, payeeReadyAt: active ? account!.created_at : null, filed, everFiled: buy ? rupees.length > 0 : filed, unwound,
    rails,
    payeeClientId,
    payeeUpi,
  };
}

/** The deal waits for its buyer's rupees: the escrow is final, nothing is said to be sent, and the deal is live. */
export function isPaying(s: P2pPayState): boolean {
  const live = s.buy ? s.lifecycle === 'AWAITING_FIRST_LEG' : s.lifecycle === 'FIRST_LEG_CONFIRMED' || s.lifecycle === 'SETTLING';
  return live && s.fundedAt !== null && !s.filed && !s.unwound;
}

export interface PayWindow {
  readonly tradeId: string;
  readonly openedAt: Date;
  readonly method: InrRail;
  readonly chosen: boolean;
  readonly timing: P2pTiming;
  readonly dueAt: Date;
  readonly finalUntil: Date;
  readonly changes: number;
  readonly warnedAt: Date | null;
  /** The payee's UPI ID the window was opened with; null — the deal has no UPI. */
  readonly payeeUpiId: string | null;
}

/** A buyer changes its method at most this many times: the choice is how it pays, not a way to buy time. */
export const PAY_METHOD_CHANGES = 3;

export async function payWindowOf(ex: Executor, tradeId: string): Promise<PayWindow | null> {
  const w = await ex.selectFrom('p2p_pay_window').selectAll().where('trade_id', '=', tradeId).executeTakeFirst();
  if (!w) return null;
  return {
    tradeId: w.trade_id, openedAt: w.opened_at, method: w.method, chosen: w.chosen_by !== null, timing: requireP2pTiming(w.timing), dueAt: w.due_at,
    finalUntil: w.final_until, changes: w.changes, warnedAt: w.warned_at, payeeUpiId: w.payee_upi_id,
  };
}

/**
 * The window a deal opens, without opening it: what a screen shows in the minute before the deadlines run. It starts
 * when the buyer could first see where to pay — the escrow final and the payee's account there to show — never earlier,
 * and the same whenever the deadlines get to it. Null while the payee's account is not ready: no countdown runs then.
 */
export function prospectiveWindow(s: P2pPayState, timing: P2pTiming): PayWindow | null {
  if (!s.fundedAt || !s.payeeAccountId || !s.payeeReadyAt) return null;
  const openedAt = new Date(Math.max(s.fundedAt.getTime(), s.payeeReadyAt.getTime()));
  // The way the amount suggests, among the ways the trader's side uses — UPI only to a live UPI ID of the payee's.
  const method = dealPayOptions(s.inrMinor, s.rails, s.payeeUpi !== null)[0]!.rail;
  const dueAt = new Date(openedAt.getTime() + timing.pay[method] * 60_000);
  return { tradeId: s.tradeId, openedAt, method, chosen: false, timing, dueAt, finalUntil: new Date(dueAt.getTime() + timing.finalMinutes * 60_000), changes: 0, warnedAt: null, payeeUpiId: s.payeeUpi?.id ?? null };
}

/**
 * Opens the deal's window once (ADR 0023): from the escrow being final, with the method the amount suggests and the
 * programme's timing as it is now. The caller holds the trade lock; a second call finds the first one's window.
 */
export async function openPayWindowInTx(ctx: TxContext, s0: P2pPayState): Promise<PayWindow | null> {
  const existing = await payWindowOf(ctx.tx, s0.tradeId);
  if (existing) return existing;
  // The deal's UPI ID is fixed here, and what it takes in a day is counted from here: one payee's deals choose theirs one
  // at a time, so two deals opening together are never both promised the last of a UPI ID's day (ADR 0029).
  let s = s0;
  if (s.payeeClientId && (s.rails === null || s.rails.includes('UPI'))) {
    await sql`select pg_advisory_xact_lock(hashtext(${`upi_pin:${s.payeeClientId}`}))`.execute(ctx.tx);
    s = { ...s, payeeUpi: await usableUpiId(ctx.tx, s.payeeClientId, s.inrMinor) };
  }
  const w = prospectiveWindow(s, await programP2pTiming(ctx.tx));
  if (!w) return null;
  const opened = await sql<{ trade_id: string }>`
    insert into p2p_pay_window (trade_id, opened_at, method, timing, due_at, final_until, payee_upi_id)
    values (${s.tradeId}::uuid, ${w.openedAt}::timestamptz, ${w.method}, ${JSON.stringify(w.timing)}::jsonb,
            ${w.openedAt}::timestamptz + make_interval(mins => ${w.timing.pay[w.method]}),
            ${w.openedAt}::timestamptz + make_interval(mins => ${w.timing.pay[w.method] + w.timing.finalMinutes}),
            ${w.payeeUpiId}::uuid)
    on conflict (trade_id) do nothing
    returning trade_id`.execute(ctx.tx);
  const window = await payWindowOf(ctx.tx, s.tradeId);
  // The buyer's clock has just started: it is told now, once, with the time it has — not when that time is up (0049).
  if (opened.rows.length > 0 && window) {
    const payload = { tradeId: s.tradeId, clientId: s.clientId, payer: s.buy ? 'CLIENT' : 'TRADER', method: window.method, dueAt: window.dueAt.toISOString() };
    await enqueueOutbox(ctx, { type: 'p2p.pay_window_opened', aggregateType: 'trade', aggregateId: s.tradeId, payload });
    await enqueueOutbox(ctx, { type: 'trader.p2p_pay_window_opened', aggregateType: 'trade', aggregateId: s.tradeId, payload });
  }
  return window;
}

/**
 * The buyer's time is up and it has not said it paid: it is told once, and has the final period — counted from now, so a
 * deadline run that came late never cuts it short. The caller holds the trade lock.
 */
export async function warnPayWindowInTx(ctx: TxContext, w: PayWindow, now: Date): Promise<PayWindow> {
  await sql`
    update p2p_pay_window
       set warned_at = ${now}::timestamptz,
           final_until = greatest(final_until, ${now}::timestamptz + make_interval(mins => ${w.timing.finalMinutes})),
           updated_at = ${now}::timestamptz
     where trade_id = ${w.tradeId}::uuid and warned_at is null`.execute(ctx.tx);
  return (await payWindowOf(ctx.tx, w.tradeId))!;
}

export type PayerSide = 'CLIENT' | 'TRADER';

/**
 * `escrow_payment.choose_method` — the buyer says how it is paying, and its window is that method's time from the escrow being
 * final. Never longer than the slowest method's, whatever it chooses or how often (at most three times); a method whose
 * time from the escrow is already over cannot be chosen; and once the rupees are said to be sent, the method is theirs.
 */
export async function choosePayMethodInTx(ctx: TxContext, input: { readonly tradeId: string; readonly payer: PayerSide; readonly userId: string; readonly method: unknown }): Promise<{ readonly method: InrRail; readonly dueAt: string; readonly finalUntil: string; readonly changed: boolean }> {
  await lockTrade(ctx.tx, input.tradeId);
  const s = await p2pPayState(ctx.tx, input.tradeId);
  if (!s) throw new DomainError('NOT_FOUND', 'deal not found');
  if ((s.buy ? 'CLIENT' : 'TRADER') !== input.payer) throw new DomainError('NOT_THE_PAYER', 'only the one who pays the rupees chooses how');
  if (!isPaying(s)) throw new DomainError('INVALID_TRANSITION', s.filed ? 'your payment is already filed' : 'this deal is not waiting for your payment');
  const method = requireOneOf(input.method, 'method', P2P_RAIL_ORDER);
  const now = await dealNow(ctx.tx);
  const w = await openPayWindowInTx(ctx, s);
  if (!w) throw new DomainError('INVALID_TRANSITION', 'the seller’s account is not ready yet');
  // Judged against the window as it is: UPI only to the UPI ID the deal was opened with, while it is still live.
  const hasUpi = w.payeeUpiId !== null && (await activeUpiId(ctx.tx, w.payeeUpiId)) !== null;
  const option = dealPayOptions(s.inrMinor, s.rails, hasUpi).find((o) => o.rail === method)!;
  if (!option.possible) {
    const why = option.limit === RAIL_NOT_TAKEN ? `${method} is not used on this deal` : option.limit === RAIL_NO_UPI_ID ? 'the seller has no UPI ID to pay to' : option.limit;
    throw new DomainError('INVALID_ARGUMENT', `${why} — choose another way to pay`, { field: 'method' });
  }
  if (w.method === method) return { method, dueAt: w.dueAt.toISOString(), finalUntil: w.finalUntil.toISOString(), changed: false };
  if (w.changes >= PAY_METHOD_CHANGES) throw new DomainError('P2P_METHOD_LOCKED', `the way you pay was changed ${PAY_METHOD_CHANGES} times already — pay by ${w.method}`);
  const dueAt = new Date(w.openedAt.getTime() + w.timing.pay[method] * 60_000);
  if (dueAt.getTime() <= now.getTime() + 60_000) {
    throw new DomainError('P2P_METHOD_TOO_LATE', `${method}’s ${w.timing.pay[method]} minutes from the escrow are over — choose a slower way, or say you paid now`);
  }
  await sql`
    update p2p_pay_window
       set method = ${method}, chosen_by = ${requireUuid(input.userId, 'userId')}::uuid,
           due_at = opened_at + make_interval(mins => ${w.timing.pay[method]}),
           final_until = opened_at + make_interval(mins => ${w.timing.pay[method] + w.timing.finalMinutes}),
           changes = changes + 1, warned_at = null, updated_at = ${now}::timestamptz
     where trade_id = ${s.tradeId}::uuid`.execute(ctx.tx);
  await appendAudit(ctx, { action: 'p2p.pay_method_chosen', entityType: 'trade', entityId: s.tradeId, before: { method: w.method, due_at: w.dueAt.toISOString() }, after: { method, due_at: dueAt.toISOString() } });
  const after = (await payWindowOf(ctx.tx, s.tradeId))!;
  return { method, dueAt: after.dueAt.toISOString(), finalUntil: after.finalUntil.toISOString(), changed: true };
}

/**
 * ADR 0030: the payer of a deal's UPI ID says its UPI app showed the name the deal told it to expect — before it says it
 * paid. Asked only of a payment by UPI on a deal paid to a UPI ID; recorded on the deal's window, and read when the payee
 * confirms the rupees arrived (`confirmP2pReceiptInTx`). The caller holds the trade lock.
 */
export async function recordPayeeNameCheckInTx(ctx: TxContext, input: { readonly tradeId: string; readonly rail: InrRail; readonly confirmed: unknown }): Promise<void> {
  if (input.rail !== 'UPI') return;
  // Said before the deadlines opened the window: it opens now, on the UPI ID the payer was shown — the same choice.
  let w = await payWindowOf(ctx.tx, input.tradeId);
  if (!w) {
    const s = await p2pPayState(ctx.tx, input.tradeId);
    if (s && isPaying(s)) w = await openPayWindowInTx(ctx, s);
  }
  if (!w?.payeeUpiId) return;
  if (input.confirmed !== true) {
    throw new DomainError('UPI_NAME_UNCHECKED', 'Check the name your UPI app shows for the seller’s UPI ID first. If it shows another name, do not pay — say so instead, and pay by bank transfer.', { field: 'payeeNameConfirmed' });
  }
  await sql`
    update p2p_pay_window set payee_name_confirmed_at = inrp2p_now(), updated_at = inrp2p_now()
     where trade_id = ${input.tradeId}::uuid and payee_name_confirmed_at is null`.execute(ctx.tx);
}

/**
 * `escrow_payment.report_name` (ADR 0030) — the payer's UPI app shows another name for the deal's UPI ID than the one it was
 * told to expect: it does not pay it. The UPI ID is paused for a person at INRP2P (`pauseUpiIdInTx`), and the deal goes on
 * by bank transfer to the payee's own account — the way the amount suits whose time from the escrow is still open, or the
 * slowest; never a longer window than that way's own. Not a change of the payer's (its three stay). The caller is the
 * deal's payer; the trade is locked here.
 */
export async function reportPayeeUpiNameInTx(ctx: TxContext, input: { readonly tradeId: string; readonly payer: PayerSide; readonly shownName: unknown }): Promise<{ readonly method: InrRail; readonly dueAt: string; readonly finalUntil: string }> {
  await lockTrade(ctx.tx, input.tradeId);
  const s = await p2pPayState(ctx.tx, input.tradeId);
  if (!s) throw new DomainError('NOT_FOUND', 'deal not found');
  if ((s.buy ? 'CLIENT' : 'TRADER') !== input.payer) throw new DomainError('NOT_THE_PAYER', 'only the one who pays the rupees checks the name');
  if (!isPaying(s)) throw new DomainError('INVALID_TRANSITION', s.filed ? 'your payment is already filed' : 'this deal is not waiting for your payment');
  const w = await openPayWindowInTx(ctx, s);
  if (!w) throw new DomainError('INVALID_TRANSITION', 'the seller’s account is not ready yet');
  if (!w.payeeUpiId) throw new DomainError('INVALID_TRANSITION', 'this deal is not paid to a UPI ID');
  const shownName = typeof input.shownName === 'string' ? input.shownName : '';
  await pauseUpiIdInTx(ctx, { upiId: w.payeeUpiId, tradeId: s.tradeId, shownName });
  const now = await dealNow(ctx.tx);
  const banks = dealPayOptions(s.inrMinor, s.rails, false).filter((o) => o.possible && o.rail !== 'UPI');
  const due = (rail: InrRail) => new Date(w.openedAt.getTime() + w.timing.pay[rail] * 60_000);
  const next = banks.find((o) => due(o.rail).getTime() > now.getTime() + 5 * 60_000) ?? [...banks].sort((a, b) => due(b.rail).getTime() - due(a.rail).getTime())[0];
  if (!next) throw new DomainError('INVALID_TRANSITION', 'this deal has no bank transfer to fall back on — ask INRP2P in the chat');
  if (w.method === 'UPI') {
    await sql`
      update p2p_pay_window
         set method = ${next.rail},
             due_at = opened_at + make_interval(mins => ${w.timing.pay[next.rail]}),
             final_until = greatest(opened_at + make_interval(mins => ${w.timing.pay[next.rail] + w.timing.finalMinutes}), ${now}::timestamptz + make_interval(mins => ${w.timing.finalMinutes})),
             warned_at = null, updated_at = ${now}::timestamptz
       where trade_id = ${s.tradeId}::uuid`.execute(ctx.tx);
  }
  await appendAudit(ctx, { action: 'p2p.payee_name_reported', entityType: 'trade', entityId: s.tradeId, before: { method: w.method }, after: { method: w.method === 'UPI' ? next.rail : w.method, upi_id: w.payeeUpiId, shown_name: shownName } });
  const after = (await payWindowOf(ctx.tx, s.tradeId))!;
  return { method: after.method, dueAt: after.dueAt.toISOString(), finalUntil: after.finalUntil.toISOString() };
}
