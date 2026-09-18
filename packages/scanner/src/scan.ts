import { Money } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import type { Trc20Transfer } from '@inrp2p/adapters';
import { recordClientDeposit } from '@inrp2p/settlement';
import { advanceCursorInTx, ensureCursorInTx, readCursor } from './cursor.ts';
import { type ScannerDeps, scannerPolicyOf } from './policy.ts';
import { systemStep } from './system.ts';
import { watchedAddresses } from './watch.ts';

export interface ScanReport {
  readonly head: bigint;
  readonly solidified: bigint;
  /** First block of the window this run read (inclusive). */
  readonly fromBlock: bigint;
  /** Last block of the window this run read (inclusive). Below `head` while catching up. */
  readonly windowEnd: bigint;
  /** Block the cursor was advanced to — never beyond what was fully processed. */
  readonly cursorAt: bigint;
  /** True when a provider returned a full page for some address, so the window was not fully read. */
  readonly truncated: boolean;
  /** True when `windowEnd < head`: more blocks remain and the next run continues from here. */
  readonly caughtUp: boolean;
  readonly addresses: number;
  /** Transfers the provider returned that the scanner read (after the contract filter). */
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

/**
 * `tron_scan` (Phase 5). Reads TRC20 transfers into the watched addresses over a bounded block window and
 * records each one as DETECTED. Detection never confirms and never decides what a transfer paid for:
 * attribution is the open deposit assignment's job (FI-26) and finality is `tron_confirm`'s (FI-24).
 *
 * Catching up is the interesting case. The window starts at the cursor minus the rescan overlap and is at most
 * `maxBlocksPerRun` wide, so a worker that was offline for a week walks the whole gap over successive runs
 * rather than jumping to the head and skipping everything in between. The cursor is advanced **after** the
 * window has been processed, and only as far as was actually read: if a provider returned a full page for some
 * address — meaning there may be more in that range — the cursor stops below the truncation point and the next
 * run re-reads from there. A failure anywhere in the pass throws before the advance, so the run is simply
 * repeated. Repetition is free: each transfer is one idempotent step keyed by its own chain identity, behind the
 * unique `(network, tx_hash, log_index)` index.
 */
export async function runTronScan(db: Db, deps: ScannerDeps): Promise<ScanReport> {
  const policy = scannerPolicyOf(deps);
  const contract = deps.chain.tokenContract;
  const head = await deps.provider.getLatestBlockNumber();
  const solidified = await deps.provider.getSolidifiedBlockNumber();

  const start = head > policy.startLookbackBlocks ? head - policy.startLookbackBlocks : 0n;
  let cursor = await readCursor(db, policy.scanner);
  if (!cursor) {
    cursor = (await systemStep(db, 'chain.cursor_open', { scanner: policy.scanner }, (ctx) => ensureCursorInTx(ctx, policy.scanner, start))).result;
  }
  const fromBlock = cursor.lastScannedBlock > policy.rescanOverlapBlocks ? cursor.lastScannedBlock - policy.rescanOverlapBlocks : 0n;
  const windowEnd = head - fromBlock > policy.maxBlocksPerRun ? fromBlock + policy.maxBlocksPerRun : head;

  const addresses = await watchedAddresses(db, policy.maxAddressesPerRun);
  const report = { seen: 0, detected: 0, alreadyKnown: 0, attributed: 0, unattributed: 0, wrongContract: 0 };
  const handled = new Set<string>();
  // Lowest block we are not sure we read completely: a full page means there may be more in that range.
  let firstIncompleteBlock: bigint | null = null;

  for (const watched of addresses) {
    if (report.seen >= policy.maxTransfersPerRun) {
      firstIncompleteBlock = firstIncompleteBlock === null || fromBlock < firstIncompleteBlock ? fromBlock : firstIncompleteBlock;
      break;
    }
    const transfers = await deps.provider.listIncomingTransfers({
      address: watched.address,
      contract,
      sinceBlock: fromBlock,
      untilBlock: windowEnd,
      limit: policy.maxTransfersPerAddress,
    });
    if (transfers.length >= policy.maxTransfersPerAddress) {
      // The page is full, so this address may have more transfers inside the window. Everything from the last
      // block we saw is suspect; the cursor stops below it.
      const lastBlock = transfers[transfers.length - 1]!.blockNumber;
      if (firstIncompleteBlock === null || lastBlock < firstIncompleteBlock) firstIncompleteBlock = lastBlock;
    }
    for (const transfer of transfers) {
      if (report.seen >= policy.maxTransfersPerRun) {
        firstIncompleteBlock = firstIncompleteBlock === null || transfer.blockNumber < firstIncompleteBlock ? transfer.blockNumber : firstIncompleteBlock;
        break;
      }
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
      const outcome = await detect(db, transfer);
      if (outcome.existing) report.alreadyKnown += 1;
      else report.detected += 1;
      if (outcome.tradeId) report.attributed += 1;
      else report.unattributed += 1;
    }
  }

  // Advance only across what was read completely, and never backwards (the database refuses that anyway).
  let cursorAt = windowEnd;
  if (firstIncompleteBlock !== null) {
    const safe = firstIncompleteBlock > 0n ? firstIncompleteBlock - 1n : 0n;
    cursorAt = safe > cursor.lastScannedBlock ? safe : cursor.lastScannedBlock;
  }
  await systemStep(db, 'chain.cursor_advance', { scanner: policy.scanner, to: cursorAt.toString() }, (ctx) =>
    advanceCursorInTx(ctx, policy.scanner, { scannedThrough: cursorAt, solidified }),
  );
  return {
    head,
    solidified,
    fromBlock,
    windowEnd,
    cursorAt,
    truncated: firstIncompleteBlock !== null,
    caughtUp: cursorAt >= head,
    addresses: addresses.length,
    ...report,
  };
}

/** One chain event, one idempotent command. A replay returns the first run's result without touching anything. */
async function detect(db: Db, transfer: Trc20Transfer): Promise<{ tradeId: string | null; existing: boolean }> {
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
