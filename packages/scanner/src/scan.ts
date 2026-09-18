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
  readonly fromBlock: bigint;
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
 * `tron_scan` (Phase 5). Reads TRC20 transfers into the watched addresses since the cursor and records each one
 * as DETECTED. Detection never confirms and never decides what a transfer paid for: attribution is the open
 * deposit assignment's job (FI-26) and finality is `tron_confirm`'s (FI-24).
 *
 * The run is safe to repeat: each transfer is one idempotent step keyed by its own chain identity, the unique
 * `(network, tx_hash, log_index)` index is the backstop, and the cursor only moves forward once the pass is done.
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

  const addresses = await watchedAddresses(db, policy.maxAddressesPerRun);
  const report = { seen: 0, detected: 0, alreadyKnown: 0, attributed: 0, unattributed: 0, wrongContract: 0 };
  const handled = new Set<string>();

  for (const watched of addresses) {
    if (report.seen >= policy.maxTransfersPerRun) break;
    const transfers = await deps.provider.listIncomingTransfers({
      address: watched.address,
      contract,
      sinceBlock: fromBlock,
      limit: policy.maxTransfersPerAddress,
    });
    for (const transfer of transfers) {
      if (report.seen >= policy.maxTransfersPerRun) break;
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

  await systemStep(db, 'chain.cursor_advance', { scanner: policy.scanner, head: head.toString() }, (ctx) =>
    advanceCursorInTx(ctx, policy.scanner, { scannedThrough: head, solidified }),
  );
  return { head, solidified, fromBlock, addresses: addresses.length, ...report };
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
