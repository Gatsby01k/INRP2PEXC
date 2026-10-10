'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { DomainError } from '@inrp2p/kernel';
import { authorizeOperator } from '@inrp2p/identity';
import { type RefreshedBalance, readRequestedBalance, recordRequestedBalance } from '@inrp2p/scanner';
import { type StatementImportResult, importBankStatement, parseStatementCsv } from '@inrp2p/settlement';
import type { BalanceObservationInput } from '@inrp2p/treasury';
import { chainForWeb } from '../chain.ts';
import { type CommandResult, failure, runCommand } from '../command.ts';
import { operatorContext } from '../operator.ts';

const MAX_BYTES = 2_000_000;

/**
 * Import a bank statement (`statement:import`, ⧗).
 *
 * The file arrives as the text the operator picked, and is hashed here, before anything reads it: the hash in
 * the audit trail is of the bytes this system was given, which is the only hash worth recording. The file's
 * contents are never stored — a statement carries every other customer of that bank account, and the question
 * this import answers ("does the bank agree with what we said we paid?") does not need them kept.
 */
export async function importStatementAction(
  input: { accountId: string; periodFrom: string; periodTo: string; filename: string; csv: string },
  key: string,
): Promise<CommandResult<StatementImportResult>> {
  const bytes = Buffer.from(input.csv, 'utf8');
  if (bytes.byteLength > MAX_BYTES) {
    return failure(new DomainError('INVALID_ARGUMENT', `a statement file may be at most ${MAX_BYTES / 1_000_000} MB`));
  }
  let lines;
  try {
    lines = parseStatementCsv(input.csv);
  } catch (e) {
    return failure(e);
  }
  const out = await runCommand((ctx) => importBankStatement(ctx.actor), {
    inrAccountId: input.accountId,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    filename: input.filename,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    lines,
  }, { name: 'statement.import', idempotencyKey: key });
  if (out.ok) revalidatePath('/', 'layout');
  return out as CommandResult<StatementImportResult>;
}

/**
 * Read what an exchange address holds now (`custody:refresh_balance`, B2). The permission is checked before any
 * provider is asked — a refresh spends provider quota — and again inside the command that records the reading. The
 * reading comes from the providers this server is configured with; the browser sends only the address, so no
 * number it sends can become a balance.
 */
export async function refreshCustodyBalanceAction(input: { address: string }, key: string): Promise<CommandResult<RefreshedBalance>> {
  let reading: BalanceObservationInput;
  try {
    const ctx = await operatorContext();
    await authorizeOperator(ctx.db, ctx.actor, 'custody:refresh_balance');
    reading = await readRequestedBalance(chainForWeb(), input.address);
  } catch (e) {
    return failure(e);
  }
  const out = await runCommand((ctx) => recordRequestedBalance(ctx.actor, reading), { address: input.address }, { name: 'custody.refresh_balance', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/usdt');
  return out;
}
