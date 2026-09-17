import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';

export interface SealResult {
  sealed: boolean;
  fromSeq?: bigint;
  toSeq?: bigint;
  hash?: string;
}

/**
 * Seals all audit events older than `settleSeconds` into the next contiguous seal.
 * The settle window keeps in-flight transactions (whose seq numbers are already allocated)
 * from committing into an already sealed range.
 */
export async function sealAudit(db: Db, opts: { settleSeconds?: number } = {}): Promise<SealResult> {
  const settle = opts.settleSeconds ?? 300;
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('inrp2p.audit_seal'))`.execute(tx);
    const last = await tx.selectFrom('audit_seal').select(['to_seq', 'seal_hash']).orderBy('to_seq', 'desc').limit(1).executeTakeFirst();
    const fromSeq = (last?.to_seq ?? 0n) + 1n;
    const upper = await sql<{ to_seq: bigint | null }>`
      select max(seq) as to_seq from audit_event
      where seq >= ${fromSeq} and at < statement_timestamp() - make_interval(secs => ${settle})`.execute(tx);
    const toSeq = upper.rows[0]?.to_seq ?? null;
    if (toSeq === null) return { sealed: false };
    const prev = last?.seal_hash ?? null;
    const h = await sql<{ hash: string; n: bigint }>`
      select inrp2p_audit_range_hash(${prev}, ${fromSeq}, ${toSeq}) as hash,
             (select count(*) from audit_event where seq between ${fromSeq} and ${toSeq}) as n`.execute(tx);
    const { hash, n } = h.rows[0]!;
    await tx.insertInto('audit_seal').values({ from_seq: fromSeq, to_seq: toSeq, event_count: n, prev_seal_hash: prev, seal_hash: hash }).execute();
    return { sealed: true, fromSeq, toSeq, hash };
  });
}

export interface SealVerification {
  ok: boolean;
  checkedSeals: number;
  firstInvalidSealId?: bigint;
}

/** Recomputes every seal; any edited, inserted or deleted audit row in a sealed range is detected. */
export async function verifyAuditSeals(db: Db): Promise<SealVerification> {
  const r = await sql<{ id: bigint; valid: boolean; count_ok: boolean }>`
    select s.id,
           inrp2p_audit_range_hash(s.prev_seal_hash, s.from_seq, s.to_seq) = s.seal_hash as valid,
           (select count(*) from audit_event e where e.seq between s.from_seq and s.to_seq) = s.event_count as count_ok
    from audit_seal s order by s.to_seq`.execute(db);
  const bad = r.rows.find((row) => !row.valid || !row.count_ok);
  return bad ? { ok: false, checkedSeals: r.rows.length, firstInvalidSealId: bad.id } : { ok: true, checkedSeals: r.rows.length };
}
