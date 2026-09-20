import { describe, expect, it } from 'vitest';
import { isDomainError } from '@inrp2p/kernel';
import { parseStatementCsv } from '../src/statements.ts';

/**
 * The statement reader. It is deliberately dull: it reads the shape and hands every judgement to the import
 * command. What it must not do is quietly change a figure on the way in — a statement is evidence, and evidence
 * that the reader "helped" is not evidence any more.
 */
const HEADER = 'value_date,direction,amount,reference,description';

describe('reading a bank statement', () => {
  it('reads the ordinary export', () => {
    const lines = parseStatementCsv(`${HEADER}\n2026-09-15,DEBIT,90000.00,ABC123456789,"Payout, second leg"\n2026-09-15,CREDIT,1200.50,FEE0001,\n`);
    expect(lines).toEqual([
      { valueDate: '2026-09-15', direction: 'DEBIT', amount: '90000.00', reference: 'ABC123456789', description: 'Payout, second leg' },
      { valueDate: '2026-09-15', direction: 'CREDIT', amount: '1200.50', reference: 'FEE0001', description: null },
    ]);
  });

  it('survives what banks actually export: a BOM, CRLF, spaced headers and grouped amounts', () => {
    const lines = parseStatementCsv('﻿Value Date,Direction,Amount,Reference\r\n2026-09-15,debit,"1,23,456.78",UTR9\r\n');
    expect(lines[0]).toEqual({ valueDate: '2026-09-15', direction: 'DEBIT', amount: '123456.78', reference: 'UTR9', description: null });
  });

  it('reads back what a spreadsheet-safe writer produces, formula guard and all', () => {
    // A field beginning `=`, `+`, `-` or `@` is written with a leading tab so a spreadsheet cannot execute it.
    // The reader removes that tab, so a file exported from this system and re-imported means the same thing.
    const lines = parseStatementCsv(`${HEADER}\r\n2026-09-15,DEBIT,90000.00,"\t=EVIL()","quoted ""thing"""\r\n`);
    expect(lines[0]?.reference).toBe('=EVIL()');
    expect(lines[0]?.description).toBe('quoted "thing"');
  });

  it('refuses a file whose columns it cannot name', () => {
    try {
      parseStatementCsv('date,amount\n2026-09-15,10.00\n');
      expect.unreachable('a statement without a reference column reconciles nothing');
    } catch (e) {
      expect(isDomainError(e) && e.code).toBe('INVALID_ARGUMENT');
      expect((e as Error).message).toContain('direction');
    }
  });

  it('refuses an empty file rather than importing nothing', () => {
    expect(() => parseStatementCsv('   \n\n')).toThrow(/empty/);
  });

  it('keeps a blank trailing line from becoming a line of the statement', () => {
    expect(parseStatementCsv(`${HEADER}\n2026-09-15,DEBIT,1.00,A1,\n\n`)).toHaveLength(1);
  });
});
