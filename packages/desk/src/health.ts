import { sql } from 'kysely';
import type { Executor } from '@inrp2p/db';
import { DEFAULT_SETTLEMENT_POLICY } from '@inrp2p/settlement';

/**
 * What to watch, what is wrong when it moves, and where to look it up (launch checklist: monitoring + alerts).
 *
 * The list is the alert definitions. Each check names the one number a monitoring system should graph, the two
 * thresholds that separate "fine" from "look at this" from "wake someone", and the runbook that says what to do
 * — because an alert that fires at 3am without a runbook is an alert that gets silenced at 3.05.
 *
 * Every `runbook` id here must exist as a heading anchor in `docs/RUNBOOKS.md`; a unit test holds the two
 * together, so an alert cannot be added without somewhere to send the person it wakes.
 *
 * The thresholds are deliberately conservative and deliberately in code. A threshold in a dashboard is a
 * threshold nobody reviews in a pull request.
 */
export type HealthState = 'ok' | 'warn' | 'alarm';

export interface HealthCheckDefinition {
  readonly id: string;
  /** What the number means, in the words an operator would use. */
  readonly title: string;
  /** Above `warn` is worth looking at; above `alarm` is worth waking someone. */
  readonly warn: number;
  readonly alarm: number;
  readonly unit: 'count' | 'seconds' | 'inr' | 'percent' | 'days';
  /** Heading anchor in `docs/RUNBOOKS.md`. */
  readonly runbook: string;
  readonly why: string;
  /**
   * What fails when it fires: `money` (the books, the cases, what the desk can pay), `infrastructure` (the pipelines and
   * the services they need), or `liquidity` (whether a trader can take an order now). Liquidity is reported apart and
   * never makes the deployment "not ready": a trader-funded exchange with no trader online is quiet, not broken (D-16).
   */
  readonly group: 'money' | 'infrastructure' | 'liquidity';
}

export const HEALTH_CHECKS: readonly HealthCheckDefinition[] = Object.freeze([
  {
    id: 'ledger_imbalance',
    title: 'Ledger rows that do not net to zero',
    warn: 0,
    alarm: 0,
    unit: 'count',
    runbook: 'ledger-imbalance',
    why: 'The ledger nets to zero by construction (FI-40, FI-44). Anything above zero means a write got through that should have been impossible, and every figure derived from the ledger is suspect until it is explained.',
    group: 'money',
  },
  {
    id: 'scanner_lag_seconds',
    title: 'Seconds since the TRON scanner last ran',
    warn: 300,
    alarm: 900,
    unit: 'seconds',
    runbook: 'stuck-usdt-confirmation',
    why: 'A scanner that has stopped does not fail loudly — it simply stops finding deposits, and every SELL trade waits. This is the difference between quiet and broken.',
    group: 'infrastructure',
  },
  {
    id: 'scanner_block_lag',
    title: 'Blocks between the solidified head and what the scanner proved read',
    // D-05: 40 TRON blocks is two minutes behind the solidified head.
    warn: 40,
    alarm: 200,
    unit: 'count',
    runbook: 'stuck-usdt-confirmation',
    why: 'A scanner can run every minute and still prove nothing: an index that pages badly, receipts it cannot fetch. The cursor then stands still below the gap instead of skipping it, and this is the number that says so.',
    group: 'infrastructure',
  },
  {
    id: 'chain_providers_degraded',
    title: 'Chain providers whose last run failed',
    warn: 0,
    alarm: 1,
    unit: 'count',
    runbook: 'provider-outage',
    why: 'Detection fails over to the next provider, but a failing one lowers the evidence behind every confirmation; with both down, USDT stops confirming.',
    group: 'infrastructure',
  },
  {
    id: 'chain_quorum_waiting',
    title: 'Transfers held for provider quorum, conflict or outage',
    warn: 0,
    alarm: 3,
    unit: 'count',
    runbook: 'chain-quorum-failure',
    why: 'A transfer that the providers cannot confirm together waits rather than confirming on one word (D-05). Clients are waiting on each of these.',
    group: 'infrastructure',
  },
  {
    id: 'custody_outflows_unobserved',
    title: 'Addresses with USDT waiting to leave and no fresh reading of what they hold',
    warn: 0,
    alarm: 2,
    unit: 'count',
    runbook: 'custody-observation-stale',
    why: 'A USDT payout or refund leaves an address only against a reading under five minutes old that the providers agree on (B2). Each of these has money waiting to go out and nothing to check it against: the payout waits, and so does the client.',
    group: 'money',
  },
  {
    id: 'outbox_failed',
    title: 'Outbox events that have exhausted their retries',
    warn: 1,
    alarm: 10,
    unit: 'count',
    runbook: 'outbox-backlog',
    why: 'Every notification, receipt and acceptance code is delivered through the outbox. A permanently failed event is something a client was promised and did not get.',
    group: 'infrastructure',
  },
  {
    id: 'outbox_oldest_pending_seconds',
    title: 'Age of the oldest undelivered outbox event',
    warn: 300,
    alarm: 1800,
    unit: 'seconds',
    runbook: 'outbox-backlog',
    why: 'Depth alone says little; age says the worker has stopped or is losing ground.',
    group: 'infrastructure',
  },
  {
    id: 'acceptance_codes_undelivered',
    title: 'Acceptance codes still undelivered after two minutes',
    warn: 0,
    alarm: 2,
    unit: 'count',
    runbook: 'email-delivery',
    why: 'Someone is looking at a quote waiting for a code to accept it. While the code is sealed and unsent, the quote can expire under them.',
    group: 'infrastructure',
  },
  {
    id: 'email_deliveries_failing',
    title: 'Client emails refused today, or not delivered within fifteen minutes',
    warn: 0,
    alarm: 9,
    unit: 'count',
    runbook: 'email-delivery',
    why: 'The inbox is the channel of record, but a client not looking at it learns of a quote, a settlement or a destination change only by email. A refused address or a provider outage means they are not hearing.',
    group: 'infrastructure',
  },
  {
    id: 'audit_seal_age_seconds',
    title: 'Seconds since the audit trail was last sealed',
    warn: 5400,
    alarm: 10800,
    unit: 'seconds',
    runbook: 'audit-seal-stale',
    why: 'The hourly seal is what makes the audit trail evidence rather than a log (SECURITY §8). Unsealed hours are hours nobody can prove were not edited.',
    group: 'infrastructure',
  },
  {
    id: 'audit_seal_export_age_seconds',
    title: 'Seconds the oldest seal has waited to be exported off the database',
    warn: 93_600,
    alarm: 180_000,
    unit: 'seconds',
    runbook: 'audit-seal-stale',
    why: 'A seal kept only in the database proves nothing to someone who could rewrite the database. The daily export to write-once storage is what does (SECURITY §8, TD-17).',
    group: 'infrastructure',
  },
  {
    id: 'audit_archive_failures',
    title: 'Findings of the last check of the seal archive against the database',
    warn: 0,
    alarm: 0,
    unit: 'count',
    runbook: 'audit-archive-mismatch',
    why: 'A gap in the archive, a seal here that differs from the archived one, or audit events that no longer hash to it: the audit trail can no longer be proved, and that is never routine.',
    group: 'money',
  },
  {
    id: 'payouts_held',
    title: 'Outgoing payments held after a database change',
    warn: 0,
    alarm: 0,
    unit: 'count',
    runbook: 'restore-fence',
    why: 'The database was recovered, failed over or moved and may have forgotten payments already made. Nothing leaves the exchange until two people have checked every payment since against the bank and the chain.',
    group: 'money',
  },
  {
    id: 'restore_drill_age_days',
    title: 'Days since a restore was last shown to work',
    warn: 35,
    alarm: 95,
    unit: 'days',
    runbook: 'backup-restore-drill',
    why: 'A backup nobody has restored is a hope. A drill that passed recently is the only evidence the platform’s backups would bring this database back as it was.',
    group: 'infrastructure',
  },
  {
    id: 'blocking_exceptions',
    title: 'Open blocking exception cases',
    warn: 3,
    alarm: 10,
    unit: 'count',
    runbook: 'blocking-exceptions',
    why: 'Each one is a trade on hold, which means a client waiting for money with the desk unable to move it.',
    group: 'money',
  },
  {
    id: 'overdue_route_obligations',
    title: 'Route obligations past their settlement window',
    warn: 1,
    alarm: 5,
    unit: 'count',
    runbook: 'route-settlement-overdue',
    why: 'A route or trader has not delivered its side, or has not been paid its own. Since D-16 the client is paid with the counterparty’s money, so an undelivered side is a client waiting for liquidity.',
    group: 'money',
  },
  {
    id: 'trader_orders_overdue',
    title: 'Trader orders the sweep should have moved more than ten minutes ago',
    warn: 0,
    alarm: 4,
    unit: 'count',
    runbook: 'trader-sweep-behind',
    why: 'Lapsed offers that were not routed on, ended holds still holding capacity, settled orders not closed. The sweep runs every minute and isolates each order, so one that stays here is failing every time — or the worker is not running.',
    group: 'infrastructure',
  },
  {
    id: 'inr_capacity_available',
    title: 'INR capacity left across active settlement accounts today',
    warn: 2_000_000,
    alarm: 500_000,
    unit: 'inr',
    runbook: 'capacity-emergency',
    why: 'Capacity is the desk’s promise about what it can pay today. This is the one check where a **low** number is the problem.',
    group: 'money',
  },
  {
    id: 'deposit_pool_free',
    title: 'Deposit addresses available to assign',
    warn: 10,
    alarm: 3,
    unit: 'count',
    runbook: 'deposit-pool-low',
    why: 'A SELL trade cannot be accepted without an address of its own (D-02). An empty pool stops the desk taking work. With the exchange’s own HD wallet (ADR 0017) every trade derives a new address and the pool cannot run out.',
    group: 'money',
  },
  {
    id: 'chain_sends_stuck',
    title: 'Signer transfers blocked, short of TRX or unresolved for over 30 minutes',
    warn: 0,
    alarm: 2,
    unit: 'count',
    runbook: 'chain-send-stuck',
    why: 'The exchange’s signer pays USDT out of deal addresses on its own (ADR 0017). A send it cannot finish — blocked, waiting for TRX, or on chain with an outcome nobody can prove — is a client or a counterparty waiting for money that will not move without a person.',
    group: 'money',
  },
  {
    id: 'trx_price_age_seconds',
    title: 'Seconds since the TRX price quotes are priced with was published',
    warn: 172_800,
    alarm: 237_600,
    unit: 'seconds',
    runbook: 'network-fees-stale',
    why: 'Every quote carries the network fee of its transfer, valued at the TRX price the desk publishes (ADR 0017). After 72 hours without a new price no quote is sent at all; this wakes someone six hours before.',
    group: 'money',
  },
  {
    id: 'worker_heartbeat_age_seconds',
    title: 'Seconds since the worker last reported in',
    warn: 180,
    alarm: 600,
    unit: 'seconds',
    runbook: 'worker-stopped',
    why: 'The worker runs everything nobody clicks: chain scanning and confirmation, notifications, receipts, sweeps, seals. A worker that stopped looks healthy everywhere else until the queues show it.',
    group: 'infrastructure',
  },
  {
    id: 'reconciliation_mismatches',
    title: 'Open reconciliation cases: the books and the outside world disagree',
    warn: 0,
    alarm: 4,
    unit: 'count',
    runbook: 'reconciliation-mismatch',
    why: 'A statement line that does not match, money the chain moved for a leg given up on, a route movement that does not fit its obligation: each is the record and reality disagreeing, and money decisions made before it is explained are made on the wrong record.',
    group: 'money',
  },
  {
    id: 'db_connections_percent',
    title: 'Database connections in use, as a share of the server limit',
    warn: 70,
    alarm: 90,
    unit: 'percent',
    runbook: 'database-pressure',
    why: 'Every command needs a connection. Near the limit, new sign-ins, confirmations and the worker start failing at random, which looks like many different faults and is one.',
    group: 'infrastructure',
  },
  {
    id: 'traders_ready_sell_usdt',
    title: 'Traders able to take a client’s Buy USDT now (they sell USDT)',
    warn: 0,
    alarm: -1,
    unit: 'count',
    runbook: 'liquidity-thin',
    why: 'Under D-16 a client is served only with a trader’s money. None ready is not a fault — it is no liquidity on that side, and the desk should know before a client asks.',
    group: 'liquidity',
  },
  {
    id: 'traders_ready_buy_usdt',
    title: 'Traders able to take a client’s Sell USDT now (they buy USDT)',
    warn: 0,
    alarm: -1,
    unit: 'count',
    runbook: 'liquidity-thin',
    why: 'Under D-16 a client is served only with a trader’s money. None ready is not a fault — it is no liquidity on that side, and the desk should know before a client asks.',
    group: 'liquidity',
  },
]);

export interface HealthCheck extends HealthCheckDefinition {
  readonly value: number;
  readonly state: HealthState;
}

export interface SystemHealth {
  /** The worst of the money and infrastructure signals: what readiness and the pager act on. */
  readonly state: HealthState;
  /** Liquidity on its own: whether traders can take orders now. It never makes the deployment unready (D-16). */
  readonly liquidity: HealthState;
  readonly checkedAt: string;
  readonly checks: readonly HealthCheck[];
}

/** A low number is the problem for capacity, the address pool and liquidity; for everything else a high one is. */
const LOWER_IS_WORSE = new Set(['inr_capacity_available', 'deposit_pool_free', 'traders_ready_sell_usdt', 'traders_ready_buy_usdt']);
export const isLowerWorse = (id: string): boolean => LOWER_IS_WORSE.has(id);

export function stateOf(definition: HealthCheckDefinition, value: number): HealthState {
  if (LOWER_IS_WORSE.has(definition.id)) {
    if (value <= definition.alarm) return 'alarm';
    return value <= definition.warn ? 'warn' : 'ok';
  }
  if (value > definition.alarm) return 'alarm';
  return value > definition.warn ? 'warn' : 'ok';
}

const worst = (states: readonly HealthState[]): HealthState =>
  states.includes('alarm') ? 'alarm' : states.includes('warn') ? 'warn' : 'ok';

/**
 * Reads every signal in one round trip.
 *
 * One query rather than nine because health is a snapshot: nine queries taken over a second describe a system
 * that never existed, and the first thing anyone does with a health page is refresh it.
 */
export async function systemHealth(ex: Executor): Promise<SystemHealth> {
  const r = await sql<{
    ledger_imbalance: string;
    scanner_lag_seconds: string;
    scanner_block_lag: string;
    chain_providers_degraded: string;
    chain_quorum_waiting: string;
    custody_outflows_unobserved: string;
    outbox_failed: string;
    outbox_oldest_pending_seconds: string;
    acceptance_codes_undelivered: string;
    email_deliveries_failing: string;
    audit_seal_age_seconds: string;
    blocking_exceptions: string;
    overdue_route_obligations: string;
    trader_orders_overdue: string;
    worker_heartbeat_age_seconds: string;
    audit_seal_export_age_seconds: string;
    audit_archive_failures: string;
    restore_drill_age_days: string;
    payouts_held: string;
    reconciliation_mismatches: string;
    db_connections_percent: string;
    traders_ready_sell_usdt: string;
    traders_ready_buy_usdt: string;
    inr_capacity_available: string;
    deposit_pool_free: string;
    chain_sends_stuck: string;
    trx_price_age_seconds: string;
    checked_at: Date;
  }>`
    select
      (select count(*) from ledger_global_imbalance)::text as ledger_imbalance,
      coalesce((select extract(epoch from (inrp2p_now() - max(last_run_at)))::bigint
                from chain_cursor), 0)::text as scanner_lag_seconds,
      coalesce((select max(greatest(last_solidified_block - last_scanned_block, 0)) from chain_cursor), 0)::text as scanner_block_lag,
      (select count(*) from chain_provider_status where consecutive_failures > 0)::text as chain_providers_degraded,
      (select count(*) from exception_case
        where type = 'TX_NOT_FINAL' and status in ('OPEN', 'IN_PROGRESS')
          and details ->> 'code' in ('INSUFFICIENT_PROVIDER_QUORUM', 'PROVIDER_CONFLICT', 'PROVIDER_UNAVAILABLE'))::text as chain_quorum_waiting,
      -- B2: planned USDT outflows (payouts and refunds not yet sent) from an address whose latest reading is missing,
      -- unusable, or older than the settlement policy allows (DEFAULT_SETTLEMENT_POLICY.maxObservationAgeSeconds).
      (select count(*) from (
         select distinct coalesce(d.address, w.address) as address
           from settlement_leg l
           left join deposit_address d on d.id = l.source_deposit_address_id
           left join treasury_wallet w on w.id = l.treasury_wallet_id
          where l.payer = 'EXCHANGE_ACCOUNT' and l.asset = 'USDT' and l.side <> 'CLIENT_TO_EXCHANGE' and l.status = 'PENDING'
       ) o
       where o.address is not null and not exists (
         select 1 from (select quality, observed_at from custody_balance_observation b
                         where b.network = 'TRON' and b.address = o.address order by b.observed_at desc, b.id desc limit 1) latest
          where latest.quality in ('AGREED', 'SINGLE_SOURCE')
            and latest.observed_at >= inrp2p_now() - make_interval(secs => ${DEFAULT_SETTLEMENT_POLICY.maxObservationAgeSeconds})))::text as custody_outflows_unobserved,
      (select count(*) from outbox_event where failed_at is not null and dispatched_at is null)::text as outbox_failed,
      coalesce((select extract(epoch from (statement_timestamp() - min(created_at)))::bigint
                from outbox_event where dispatched_at is null and failed_at is null), 0)::text as outbox_oldest_pending_seconds,
      (select count(*) from otp_delivery d join acceptance_challenge c on c.id = d.challenge_id
        where d.code_sealed is not null and c.status = 'PENDING' and c.expires_at > inrp2p_now()
          and d.created_at < inrp2p_now() - make_interval(mins => 2))::text as acceptance_codes_undelivered,
      (select count(*) from client_notification_email
        where (status = 'FAILED' and failed_at > inrp2p_now() - make_interval(hours => 24))
           or (status = 'PENDING' and created_at < inrp2p_now() - make_interval(mins => 15)))::text as email_deliveries_failing,
      coalesce((select extract(epoch from (statement_timestamp() - max(sealed_at)))::bigint
                from audit_seal), 0)::text as audit_seal_age_seconds,
      (select count(*) from exception_case where status in ('OPEN', 'IN_PROGRESS') and severity = 'BLOCKING')::text as blocking_exceptions,
      (select count(*) from route_obligation o
        where o.status not in ('SETTLED', 'CANCELLED')
          and o.opened_at < inrp2p_now() - make_interval(hours => 24))::text as overdue_route_obligations,
      -- What runTraderSweep acts on (dueOrders), left undone for ten minutes: offers past expiry, holds past their end,
      -- started orders whose obligation is settled or cancelled.
      (select count(*) from trader_order t
         left join route_obligation r on r.id = t.route_obligation_id
        where (t.status = 'OFFERED' and t.offer_expires_at < inrp2p_now() - make_interval(mins => 10))
           or (t.status = 'ACCEPTED' and t.hold_until < inrp2p_now() - make_interval(mins => 10))
           or (t.status = 'IN_PROGRESS' and r.status in ('SETTLED', 'CANCELLED')
               and coalesce(r.settled_at, r.cancelled_at) < inrp2p_now() - make_interval(mins => 10)))::text as trader_orders_overdue,
      coalesce((select extract(epoch from (inrp2p_now() - min(s.sealed_at)))::bigint from audit_seal s
                 where s.id > coalesce((select max(last_seal_id) from audit_seal_export), 0)), 0)::text as audit_seal_export_age_seconds,
      coalesce((select jsonb_array_length(v.findings) from audit_archive_verification v order by v.ran_at desc, v.id desc limit 1), 0)::text as audit_archive_failures,
      coalesce((select floor(extract(epoch from (inrp2p_now() - max(b.ran_at))) / 86400)::bigint from backup_verification b where b.ok), 9999)::text as restore_drill_age_days,
      (case when inrp2p_payouts_held() then 1 else 0 end)::text as payouts_held,
      -- No heartbeat at all reads as a very long silence, not as fine.
      coalesce((select extract(epoch from (inrp2p_now() - max(beat_at)))::bigint from worker_heartbeat), 999999)::text as worker_heartbeat_age_seconds,
      (select count(*) from exception_case
        where status in ('OPEN', 'IN_PROGRESS')
          and type in ('RECONCILIATION_MISMATCH', 'ROUTE_SETTLEMENT_MISMATCH', 'ROUTE_DIRECT_PAYOUT_MISMATCH', 'DUPLICATE_UTR', 'DUPLICATE_TX_HASH'))::text as reconciliation_mismatches,
      ((select count(*) from pg_stat_activity) * 100 / greatest(current_setting('max_connections')::int, 1))::text as db_connections_percent,
      -- A trader that could be offered an order now, per side: approved, online, taking assignments, its reserve covering
      -- the requirement, its settlement details active, and an active block with capacity left and a rate.
      (select count(distinct t.id) from trader_profile t
         join trader_block b on b.trader_id = t.id and b.side = 'SELL_USDT' and b.status = 'ACTIVE' and b.rate_micro is not null and b.capacity_minor > b.reserved_minor
         join bank_account ba on ba.id = t.bank_account_id and ba.status = 'ACTIVE'
         join crypto_wallet cw on cw.id = t.wallet_id and cw.status = 'ACTIVE'
        where t.status = 'APPROVED' and t.available and t.assignments_enabled and t.required_reserve_minor is not null
          and inrp2p_trader_reserve_free(t.id, null) >= t.required_reserve_minor)::text as traders_ready_sell_usdt,
      (select count(distinct t.id) from trader_profile t
         join trader_block b on b.trader_id = t.id and b.side = 'BUY_USDT' and b.status = 'ACTIVE' and b.rate_micro is not null and b.capacity_minor > b.reserved_minor
         join bank_account ba on ba.id = t.bank_account_id and ba.status = 'ACTIVE'
         join crypto_wallet cw on cw.id = t.wallet_id and cw.status = 'ACTIVE'
        where t.status = 'APPROVED' and t.available and t.assignments_enabled and t.required_reserve_minor is not null
          and inrp2p_trader_reserve_free(t.id, null) >= t.required_reserve_minor)::text as traders_ready_buy_usdt,
      -- Whole rupees, divided in SQL on the bigint: no money is ever converted to a JavaScript number, and
      -- integer division rounds *down*, so this check understates what is available rather than overstating it.
      coalesce((select sum(greatest(coalesce(d.capacity_minor, a.default_daily_capacity_minor) - coalesce(d.used_minor, 0) - coalesce(d.reserved_minor, 0), 0)) / 100
                from inr_settlement_account a
                left join inr_account_day d on d.account_id = a.id
                     and d.day = (inrp2p_now() at time zone 'Asia/Kolkata')::date
                where a.status = 'ACTIVE'), 0)::text as inr_capacity_available,
      -- With the HD wallet recorded (ADR 0017) addresses are derived per trade: the pool is not a limit.
      (case when exists (select 1 from custody_hd_account) then 999999
            else (select count(*) from deposit_address where status = 'AVAILABLE') end)::text as deposit_pool_free,
      (select count(*) from chain_send
        where status = 'BLOCKED'
           or (status in ('SENDING', 'AWAITING_RESOURCES') and updated_at < inrp2p_now() - make_interval(mins => 30)))::text as chain_sends_stuck,
      -- Only once the exchange's own rails exist: before that no quote depends on a TRX price.
      (case when exists (select 1 from custody_hd_account)
            then coalesce((select extract(epoch from (inrp2p_now() - max(effective_at)))::bigint from network_trx_rate), 999999)
            else 0 end)::text as trx_price_age_seconds,
      inrp2p_now() as checked_at`.execute(ex);

  const row = r.rows[0]!;
  // Every figure arrives as an integer string and stays an integer: counts, seconds, and whole rupees that
  // PostgreSQL already divided. Nothing here is money in the arithmetic sense — these are signals to compare
  // against a threshold, and the one that started as money never passes through a float to get here.
  const int = (value: string): number => Number.parseInt(value, 10);
  const values: Record<string, number> = {
    ledger_imbalance: int(row.ledger_imbalance),
    scanner_lag_seconds: int(row.scanner_lag_seconds),
    scanner_block_lag: int(row.scanner_block_lag),
    chain_providers_degraded: int(row.chain_providers_degraded),
    chain_quorum_waiting: int(row.chain_quorum_waiting),
    custody_outflows_unobserved: int(row.custody_outflows_unobserved),
    outbox_failed: int(row.outbox_failed),
    outbox_oldest_pending_seconds: int(row.outbox_oldest_pending_seconds),
    acceptance_codes_undelivered: int(row.acceptance_codes_undelivered),
    email_deliveries_failing: int(row.email_deliveries_failing),
    audit_seal_age_seconds: int(row.audit_seal_age_seconds),
    blocking_exceptions: int(row.blocking_exceptions),
    overdue_route_obligations: int(row.overdue_route_obligations),
    trader_orders_overdue: int(row.trader_orders_overdue),
    worker_heartbeat_age_seconds: int(row.worker_heartbeat_age_seconds),
    audit_seal_export_age_seconds: int(row.audit_seal_export_age_seconds),
    audit_archive_failures: int(row.audit_archive_failures),
    restore_drill_age_days: int(row.restore_drill_age_days),
    payouts_held: int(row.payouts_held),
    reconciliation_mismatches: int(row.reconciliation_mismatches),
    db_connections_percent: int(row.db_connections_percent),
    traders_ready_sell_usdt: int(row.traders_ready_sell_usdt),
    traders_ready_buy_usdt: int(row.traders_ready_buy_usdt),
    inr_capacity_available: int(row.inr_capacity_available),
    deposit_pool_free: int(row.deposit_pool_free),
    chain_sends_stuck: int(row.chain_sends_stuck),
    trx_price_age_seconds: int(row.trx_price_age_seconds),
  };

  const checks = HEALTH_CHECKS.map((definition) => {
    const value = values[definition.id] ?? 0;
    return { ...definition, value, state: stateOf(definition, value) };
  });
  return {
    state: worst(checks.filter((c) => c.group !== 'liquidity').map((c) => c.state)),
    liquidity: worst(checks.filter((c) => c.group === 'liquidity').map((c) => c.state)),
    checkedAt: row.checked_at.toISOString(),
    checks,
  };
}
