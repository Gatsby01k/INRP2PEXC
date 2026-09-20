'use server';

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { DomainError } from '@inrp2p/kernel';
import { type StatementImportResult, importBankStatement, parseStatementCsv } from '@inrp2p/settlement';
import { type CommandResult, failure, runCommand } from '../command.ts';

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
