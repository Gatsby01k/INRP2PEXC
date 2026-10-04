import { DomainError, Money } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import type { Trc20Transfer, TronProvider } from '@inrp2p/adapters';
import { recordClientDeposit } from '@inrp2p/settlement';
import { advanceCursorInTx, ensureCursorInTx, readCursor } from './cursor.ts';
import { type ScannerDeps, scannerPolicyOf } from './policy.ts';
import { ProviderTracker, firstAnswer } from './providers.ts';
import { systemStep } from './system.ts';
import { watchedAddresses } from './watch.ts';

export interface ScanReport {
  readonly head: bigint;
  readonly solidified: bigint;
  /** First block of the window this run read (inclusive). */
  readonly fromBlock: bigint;
  /** Last block of the window this run read (inclusive). Below `head` while catching up. */
  readonly windowEnd: bigint;
  /** Block the cursor stands at after this run — never beyond what was proved read for every address. */
  readonly cursorAt: bigint;
  /** True when some address's window could not be proved read in full; `incompleteReasons` says why. */
  readonly truncated: boolean;
  readonly incompleteReasons: readonly string[];
  /** True when `cursorAt >= head`. */
  readonly caughtUp: boolean;
  readonly addresses: number;
  /** Provider whose heads framed the window. */
  readonly servedBy: string;
  /** Address reads that a provider other than the first answered. */
  readonly failovers: number;
  /** Providers that failed every call this run. */
  readonly providersDown: readonly string[];
  /** Transfers the providers returned that the scanner read (after the contract filter). */
  readonly seen: number;
  /** Transfers recorded for the first time. */
  readonly detected: number;
  /** Transfers already known — a rescan of the overlap window, or a second provider report (FI-23). */
  readonly alreadyKnown: number;
  /** Transfers attributed to a trade through the open deposit assignment (FI-26). */
  readonly attributed: number;
  /** Transfers that landed somewhere with no open assignment; each opened a case. */
  readonly unattributed: number;
  /** Transfers ignored because they were not the configured USDT contract. */
  readonly wrongContract: number;
}

export interface AddressRead {
  readonly transfers: readonly Trc20Transfer[];
  /** Every transfer into the address in `[fromBlock, provenThrough]` is in `transfers`. */
  readonly provenThrough: bigint;
  readonly reason: string | null;
  readonly failover: boolean;
}

/**
 * Reads one address's window through the providers in priority order. The first complete read wins; otherwise the
 * reads are combined — each one proves its own range, so their union proves the widest of them. A provider that
 * throws proves nothing, and with nobody answering the address proves nothing at all.
 */
export async function readAddress(deps: ScannerDeps, tracker: ProviderTracker, address: string, fromBlock: bigint, windowEnd: bigint): Promise<AddressRead> {
  const seen = new Map<string, Trc20Transfer>();
  let proven = fromBlock - 1n;
  const reasons: string[] = [];
  let answeredBy: TronProvider | null = null;
  for (const p of deps.providers) {
    try {
      const w = await p.readIncomingTransfers({ address, contract: deps.chain.tokenContract, sinceBlock: fromBlock, untilBlock: windowEnd });
      tracker.ok(p);
      for (const t of w.transfers) seen.set(`${t.txHash}:${t.logIndex}`, t);
      if (w.completeThrough > proven) {
        proven = w.completeThrough;
        answeredBy = p;
      }
      if (w.complete) break;
      reasons.push(`${p.name}: ${w.incompleteReason ?? 'incomplete'}`);
    } catch (e) {
      tracker.failed(p, e);
      reasons.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  const transfers = [...seen.values()].sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.txHash !== b.txHash ? (a.txHash < b.txHash ? -1 : 1) : a.logIndex - b.logIndex));
  return {
    transfers,
    provenThrough: proven,
    reason: proven >= windowEnd ? null : reasons.join('; ') || 'no provider answered',
    failover: answeredBy !== null && answeredBy !== deps.providers[0],
  };
}

/**
 * `tron_scan` (Phase 5, hardened in A2/A3). Reads TRC20 transfers into the watched addresses over a bounded block
 * window and records each one as DETECTED. Detection never confirms and never decides what a transfer paid for:
 * attribution is the open deposit assignment's job (FI-26) and finality is `tron_confirm`'s (FI-24).
 *
 * The window starts at the cursor minus the rescan overlap and is at most `maxBlocksPerRun` wide, so a worker that
 * was offline for a week walks the whole gap over successive runs. Each provider reports, with every window it
 * reads, how far it can **prove** the read complete — every page, every receipt; the cursor then moves only to the
 * lowest such proof among all watched addresses. An interrupted page, a repeated pagination token, a receipt the
 * provider could not produce or that contradicts its own index, a provider outage or the per-run detection budget
 * therefore leaves the cursor below the first block it could not vouch for, and the next run reads from there.
 * Repetition is free: each transfer is one idempotent step keyed by its chain identity, behind the unique
 * `(network, tx_hash, log_index)` index.
 */
export async function runTronScan(db: Db, deps: ScannerDeps): Promise<ScanReport> {
  if (deps.providers.length === 0) throw new DomainError('CHAIN_MONITORING_UNCONFIGURED', 'no TRON provider is configured');
  const policy = scannerPolicyOf(deps);
  const contract = deps.chain.tokenContract;
  const tracker = new ProviderTracker(deps.providers);
  try {
    const heads = await firstAnswer(deps.providers, tracker, async (p) => {
      const head = await p.getLatestBlockNumber();
      const solidified = await p.getSolidifiedBlockNumber();
      if (solidified > head) throw new DomainError('CHAIN_EVIDENCE_INVALID', `${p.name} reports a solidified block ${solidified} above its head ${head}`);
      tracker.ok(p, { head, solidified });
      return { head, solidified };
    });
    if (heads.value === null) throw new DomainError('CHAIN_PROVIDER_ERROR', `no TRON provider answered: ${heads.errors.join('; ')}`);
    const { head, solidified } = heads.value;

    const start = head > policy.startLookbackBlocks ? head - policy.startLookbackBlocks : 0n;
    let cursor = await readCursor(db, policy.scanner);
    if (!cursor) {
      cursor = (await systemStep(db, 'chain.cursor_open', { scanner: policy.scanner }, (ctx) => ensureCursorInTx(ctx, policy.scanner, start))).result;
    }
    const fromBlock = cursor.lastScannedBlock > policy.rescanOverlapBlocks ? cursor.lastScannedBlock - policy.rescanOverlapBlocks : 0n;
    const windowEnd = head - fromBlock > policy.maxBlocksPerRun ? fromBlock + policy.maxBlocksPerRun : head;

    const addresses = await watchedAddresses(db);
    const report = { seen: 0, detected: 0, alreadyKnown: 0, attributed: 0, unattributed: 0, wrongContract: 0 };
    const reasons: string[] = [];
    const handled = new Set<string>();
    let provenThrough = windowEnd;
    let failovers = 0;
    let budgetSpent = false;
    let newWork = 0;

    for (const watched of addresses) {
      if (budgetSpent) {
        // An address this run never read proves nothing past the window's start.
        provenThrough = fromBlock - 1n < provenThrough ? fromBlock - 1n : provenThrough;
        continue;
      }
      const read = await readAddress(deps, tracker, watched.address, fromBlock, windowEnd);
      if (read.failover) failovers += 1;
      let addressProven = read.provenThrough;
      if (read.reason) reasons.push(`${watched.address}: ${read.reason}`);
      for (const transfer of read.transfers) {
        // A provider that answers with another token's transfer is ignored outright: the contract is ours to
        // decide, not the provider's (FI-24).
        if (transfer.tokenContract !== contract) {
          report.wrongContract += 1;
          continue;
        }
        if (transfer.toAddress !== watched.address) continue;
        const key = `${transfer.txHash.toLowerCase()}:${transfer.logIndex}`;
        if (handled.has(key)) continue;
        handled.add(key);
        report.seen += 1;
        // A rescan of the overlap meets mostly transfers it already recorded; those cost a lookup, not a step,
        // and never use up the budget that bounds new work.
        if (await alreadyRecorded(db, transfer)) {
          report.alreadyKnown += 1;
          continue;
        }
        if (newWork >= policy.maxTransfersPerRun) {
          // Out of budget: nothing from this transfer's block on is processed, so nothing from it on is proven.
          budgetSpent = true;
          if (transfer.blockNumber - 1n < addressProven) addressProven = transfer.blockNumber - 1n;
          reasons.push(`detection budget of ${policy.maxTransfersPerRun} new transfers reached`);
          break;
        }
        newWork += 1;
        const outcome = await detect(db, transfer);
        if (outcome.existing) report.alreadyKnown += 1;
        else report.detected += 1;
        if (outcome.tradeId) report.attributed += 1;
        else report.unattributed += 1;
      }
      if (addressProven < provenThrough) provenThrough = addressProven;
    }

    const advanced = await systemStep(db, 'chain.cursor_advance', { scanner: policy.scanner, to: provenThrough.toString() }, (ctx) =>
      advanceCursorInTx(ctx, policy.scanner, {
        scannedThrough: provenThrough,
        solidified,
        window: { from: fromBlock, to: windowEnd },
        complete: reasons.length === 0,
        incompleteReason: reasons.length ? reasons.join(' | ') : null,
        servedBy: heads.provider.name,
      }),
    );
    const cursorAt = advanced.result.lastScannedBlock;
    return {
      head,
      solidified,
      fromBlock,
      windowEnd,
      cursorAt,
      truncated: provenThrough < windowEnd,
      incompleteReasons: reasons,
      caughtUp: cursorAt >= head,
      addresses: addresses.length,
      servedBy: heads.provider.name,
      failovers,
      providersDown: tracker.down,
      ...report,
    };
  } finally {
    await tracker.flush(db);
  }
}

async function alreadyRecorded(db: Db, transfer: Trc20Transfer): Promise<boolean> {
  const row = await db
    .selectFrom('crypto_transfer')
    .select('id')
    .where('network', '=', 'TRON')
    .where('tx_hash', '=', transfer.txHash.toLowerCase())
    .where('log_index', '=', transfer.logIndex)
    .executeTakeFirst();
  return row !== undefined;
}

/** One chain event, one idempotent command. A replay returns the first run's result without touching anything. */
export async function detect(db: Db, transfer: Trc20Transfer): Promise<{ tradeId: string | null; existing: boolean }> {
  const payload = {
    txHash: transfer.txHash.toLowerCase(),
    logIndex: transfer.logIndex,
    tokenContract: transfer.tokenContract,
    fromAddress: transfer.fromAddress,
    toAddress: transfer.toAddress,
    amountMinor: transfer.amountMinor.toString(),
  };
  const step = await systemStep(
    db,
    'chain.deposit_detected',
    payload,
    async (ctx) => {
      const out = await recordClientDeposit(ctx, {
        txHash: payload.txHash,
        logIndex: payload.logIndex,
        tokenContract: payload.tokenContract,
        fromAddress: payload.fromAddress,
        toAddress: payload.toAddress,
        amount: Money.ofMinor(BigInt(payload.amountMinor), 'USDT'),
        source: 'SCANNER',
      });
      return { tradeId: out.tradeId, transferId: out.transferId };
    },
    { key: `tron:${payload.txHash}:${payload.logIndex}`, financial: true },
  );
  return { tradeId: step.result.tradeId, existing: step.replayed };
}
