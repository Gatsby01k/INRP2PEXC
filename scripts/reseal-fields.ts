/**
 * Moves every sealed value to the current key-encryption key — production's move from the locally held `prod-v1` to
 * AWS KMS (owner direction 2026-10-11; migration 0036; RUNBOOKS `field-encryption-keys`).
 *
 *   DATABASE_MIGRATOR_URL=…                                  the schema owner (the application cannot re-seal)
 *   INRP2P_KEK_PROVIDER=aws-kms INRP2P_KEK_ID=… INRP2P_KMS_KEY_ARN=…   the target: the key the release will run on
 *   INRP2P_FIELD_HMAC_BASE64=…                               the lookup key the values were written with — unchanged
 *   INRP2P_RESEAL_FROM='[{"id":"prod-v1","provider":"local","base64":"…"}]'   the key(s) the values are under now
 *   node scripts/reseal-fields.ts plan | apply [--limit N] | verify
 *
 * - `plan` writes nothing: it counts the values per field and key, opens every one with the keys it was given, checks
 *   each account number against its stored lookup HMAC (so a wrong HMAC key is found before anything moves), and asks
 *   the target key to wrap and unwrap once.
 * - `apply` moves the values one row per transaction: the data key is unwrapped with the old key and wrapped by the
 *   target; the iv, ciphertext and tag are kept, so the field cannot change (the database checks that too). Before the
 *   row is written the new value is opened with the target key alone and must say exactly what the old one said, and
 *   an account number must still match its lookup HMAC. Each move is audited (`field.resealed`, key ids only). A run
 *   that stops — a crash, a KMS outage, `--limit` — leaves every row either moved or untouched; running `apply` again
 *   continues from where it stopped, and a row already under the target is skipped.
 * - `verify` uses the target key alone, as the release will: every value must open, every account number must match
 *   its HMAC, and no value may remain under another key. Only then can the old key be retired.
 *
 * Nothing is printed but field names, row ids, key ids and counts — never a value, sealed or open.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import {
  type FieldProtector, type KeyEncryptionKey, AwsKmsKeyEncryptionKey, LocalKeyEncryptionKey, awsCredentialsFromEnvironment, createFieldProtector,
  fieldProtectionFromEnv, rewrapSealed, sealedKeyId,
} from '@inrp2p/adapters';
import { appendAuditDirect } from '@inrp2p/audit';
import { BANK_ACCOUNT_HMAC_CONTEXT, bankAccountSealContext, contactPhoneSealContext } from '@inrp2p/clients';
import { type Db, SCHEMA_VERSION, createDb, createPool } from '@inrp2p/db';
import { INR_ACCOUNT_HMAC_CONTEXT, inrAccountSealContext } from '@inrp2p/inr-accounts';
import { otpSealContext } from '@inrp2p/quotes';
import { traderPhoneSealContext } from '@inrp2p/traders';

type Row = Record<string, unknown> & { id: string };

export interface SealedField {
  readonly table: string;
  readonly column: string;
  /** Columns the seal context is built from. */
  readonly with: readonly string[];
  /** The context the value was sealed under (its AAD) — the same function the application seals with. */
  readonly context: (row: Row) => string;
  /** A lookup HMAC kept beside the value: the opened value must still produce it. */
  readonly hmac?: { readonly column: string; readonly context: string };
}

/** Every `inrp2p_sealed` column of the schema. A column the database has and this list lacks stops the tool. */
export const SEALED_FIELDS: readonly SealedField[] = [
  { table: 'bank_account', column: 'account_number_enc', with: ['client_id'], context: (r) => bankAccountSealContext(String(r.client_id)), hmac: { column: 'account_hmac', context: BANK_ACCOUNT_HMAC_CONTEXT } },
  { table: 'inr_settlement_account', column: 'account_number_enc', with: ['entity_id'], context: (r) => inrAccountSealContext(String(r.entity_id)), hmac: { column: 'account_hmac', context: INR_ACCOUNT_HMAC_CONTEXT } },
  { table: 'client_contact', column: 'phone_enc', with: ['client_id'], context: (r) => contactPhoneSealContext(String(r.client_id), 'phone') },
  { table: 'client_contact', column: 'whatsapp_enc', with: ['client_id'], context: (r) => contactPhoneSealContext(String(r.client_id), 'whatsapp') },
  { table: 'trader_profile', column: 'phone_enc', with: ['client_id'], context: (r) => traderPhoneSealContext(String(r.client_id)) },
  { table: 'otp_delivery', column: 'code_sealed', with: ['challenge_id'], context: (r) => otpSealContext(String(r.challenge_id)) },
];

export interface ResealKeys {
  /** The key the release runs on. */
  readonly target: KeyEncryptionKey;
  /** Keys values may be under now (never the target). */
  readonly sources: readonly KeyEncryptionKey[];
  readonly hmacKey: Buffer;
}

/** The keys from the environment: the target as the release configures it, the sources from `INRP2P_RESEAL_FROM`. */
export function resealKeysFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { fetchImpl?: typeof fetch } = {}): ResealKeys {
  const config = fieldProtectionFromEnv(env, deps);
  if (!config) throw new Error('the target key is not configured (INRP2P_KEK_PROVIDER, INRP2P_KEK_ID, INRP2P_KMS_KEY_ARN, INRP2P_FIELD_HMAC_BASE64)');
  let list: unknown;
  try {
    list = JSON.parse(env.INRP2P_RESEAL_FROM ?? '[]');
  } catch {
    throw new Error('INRP2P_RESEAL_FROM is not JSON');
  }
  if (!Array.isArray(list)) throw new Error('INRP2P_RESEAL_FROM must be a JSON array');
  const sources: KeyEncryptionKey[] = [...config.previous];
  for (const entry of list as { id?: string; provider?: string; base64?: string; arn?: string }[]) {
    if (!entry.id || entry.id === config.current.keyId) throw new Error('every key in INRP2P_RESEAL_FROM needs its own id, different from the target');
    if (entry.provider === 'local') {
      // The one place a locally held key is accepted in production: to take values away from it.
      if (!entry.base64) throw new Error(`key ${entry.id} has no key material`);
      sources.push(LocalKeyEncryptionKey.fromBase64(entry.id, entry.base64));
    } else if (entry.provider === 'aws-kms') {
      if (!entry.arn) throw new Error(`key ${entry.id} has no ARN`);
      sources.push(new AwsKmsKeyEncryptionKey({
        keyId: entry.id, keyArn: entry.arn, credentials: awsCredentialsFromEnvironment(env, deps.fetchImpl ?? fetch),
        ...(env.INRP2P_KMS_ENDPOINT ? { endpoint: env.INRP2P_KMS_ENDPOINT } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }));
    } else throw new Error(`key ${entry.id} has an unknown provider`);
  }
  return { target: config.current, sources, hmacKey: Buffer.from(env.INRP2P_FIELD_HMAC_BASE64!.trim(), 'base64') };
}

export interface FieldReport {
  readonly field: string;
  /** Values per key id, before (plan, apply) or now (verify). */
  readonly byKey: Record<string, number>;
  moved: number;
  /** Rows that could not be opened, matched or moved: ids only. */
  readonly failed: { readonly id: string; readonly reason: string }[];
}

export interface ResealReport {
  readonly mode: 'plan' | 'apply' | 'verify';
  readonly target: string;
  readonly fields: FieldReport[];
  /** Values still under another key after the run. */
  readonly remaining: number;
  readonly ok: boolean;
}

const name = (f: SealedField) => `${f.table}.${f.column}`;

/** The run is the schema owner's, on this release's schema, and knows every sealed column the database has. */
async function preconditions(db: Db): Promise<void> {
  const r = (await sql<{ application: boolean; version: number | null }>`select inrp2p_is_application_session() as application, inrp2p_schema_version() as version`.execute(db)).rows[0]!;
  if (r.application) throw new Error('connect as the schema owner (DATABASE_MIGRATOR_URL): the application cannot re-seal');
  if (r.version !== SCHEMA_VERSION) throw new Error(`the database is at migration ${r.version ?? 'none'}; this tool belongs to ${SCHEMA_VERSION}: migrate first`);
  const columns = (await sql<{ table_name: string; column_name: string }>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and domain_name = 'inrp2p_sealed' order by 1, 2`.execute(db)).rows;
  const unknown = columns.filter((c) => !SEALED_FIELDS.some((f) => f.table === c.table_name && f.column === c.column_name));
  if (unknown.length) throw new Error(`sealed columns this tool does not know: ${unknown.map((c) => `${c.table_name}.${c.column_name}`).join(', ')}`);
}

const selectRows = (db: Db, f: SealedField, extra = sql``) => sql<Row>`
  select ${sql.join([sql.ref('id'), sql.ref(f.column), ...f.with.map((c) => sql.ref(c)), ...(f.hmac ? [sql.ref(f.hmac.column)] : [])])}
  from ${sql.table(f.table)} where ${sql.ref(f.column)} is not null ${extra} order by id`.execute(db);

async function countByKey(db: Db, f: SealedField): Promise<Record<string, number>> {
  const rows = (await sql<{ key_id: string; n: number }>`
    select split_part(${sql.ref(f.column)}, '.', 2) as key_id, count(*)::int as n from ${sql.table(f.table)}
    where ${sql.ref(f.column)} is not null group by 1 order by 1`.execute(db)).rows;
  return Object.fromEntries(rows.map((r) => [r.key_id, r.n]));
}

/** Opens `sealed` and checks it against its HMAC; returns the reason it fails, or null. */
async function check(protector: FieldProtector, f: SealedField, row: Row, sealed: string): Promise<{ value: string } | { reason: string }> {
  let value: string;
  try {
    value = await protector.open(sealed, f.context(row));
  } catch (e) {
    return { reason: `does not open: ${(e as { code?: string }).code ?? (e as Error).message}` };
  }
  if (f.hmac && protector.lookupHash(value, f.hmac.context) !== row[f.hmac.column]) {
    return { reason: 'opens, but its lookup HMAC differs: INRP2P_FIELD_HMAC_BASE64 is not the key it was written with' };
  }
  return { value };
}

export async function reseal(db: Db, keys: ResealKeys, mode: 'plan' | 'apply' | 'verify', opts: { limit?: number; log?: (line: string) => void; probed?: boolean } = {}): Promise<ResealReport> {
  const log = opts.log ?? (() => {});
  await preconditions(db);
  const targetOnly = createFieldProtector({ kek: keys.target, hmacKey: keys.hmacKey });
  const withSources = createFieldProtector({ kek: keys.target, previous: keys.sources, hmacKey: keys.hmacKey });
  if (mode !== 'verify' && !opts.probed) {
    // The target must answer before anything is planned against it.
    const probe = randomBytes(32);
    if (!(await keys.target.unwrap(await keys.target.wrap(probe))).equals(probe)) throw new Error(`the target key ${keys.target.keyId} does not give back what it wrapped`);
  }

  if (mode === 'apply') {
    // Everything is checked before anything moves: one value that does not open, or a lookup key that is not the one
    // the values were written with, and the run writes nothing at all.
    const planned = await reseal(db, keys, 'plan', { ...opts, probed: true });
    if (!planned.ok) return { ...planned, mode };
  }

  const fields: FieldReport[] = [];
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const f of SEALED_FIELDS) {
    const report: FieldReport = { field: name(f), byKey: await countByKey(db, f), moved: 0, failed: [] };
    fields.push(report);
    if (mode === 'verify') {
      for (const row of (await selectRows(db, f)).rows) {
        const c = await check(targetOnly, f, row, String(row[f.column]));
        if ('reason' in c) report.failed.push({ id: row.id, reason: c.reason });
      }
      continue;
    }
    const pending = (await selectRows(db, f, sql`and split_part(${sql.ref(f.column)}, '.', 2) <> ${keys.target.keyId}`)).rows;
    for (const row of pending) {
      if (mode === 'plan') {
        const c = await check(withSources, f, row, String(row[f.column]));
        if ('reason' in c) report.failed.push({ id: row.id, reason: c.reason });
        continue;
      }
      if (budget <= 0) break;
      try {
        const moved = await db.transaction().execute(async (tx) => {
          await sql`set local inrp2p.reseal = 'on'`.execute(tx);
          // The row as it is now, locked: a run that raced another, or resumed, sees the latest value.
          const current = (await sql<Row>`select ${sql.join([sql.ref('id'), sql.ref(f.column), ...f.with.map((c) => sql.ref(c)), ...(f.hmac ? [sql.ref(f.hmac.column)] : [])])}
            from ${sql.table(f.table)} where id = ${row.id} for update`.execute(tx)).rows[0];
          const old = current?.[f.column];
          if (!current || typeof old !== 'string' || sealedKeyId(old) === keys.target.keyId) return false;
          const before = await check(withSources, f, current, old);
          if ('reason' in before) throw new Error(before.reason);
          const next = await rewrapSealed(old, keys.sources, keys.target);
          const after = await check(targetOnly, f, current, next);
          if ('reason' in after) throw new Error(`after the move it ${after.reason}`);
          if (after.value !== before.value) throw new Error('after the move it opens to something else');
          const updated = await sql`update ${sql.table(f.table)} set ${sql.ref(f.column)} = ${next} where id = ${row.id} and ${sql.ref(f.column)} = ${old}`.execute(tx);
          if (Number(updated.numAffectedRows ?? 0) !== 1) throw new Error('the row changed while it was being moved');
          await appendAuditDirect(tx, {
            actorType: 'SYSTEM', actorId: null, surface: 'SYSTEM', action: 'field.resealed', entityType: f.table, entityId: row.id,
            after: { column: f.column, from_key: sealedKeyId(old), to_key: keys.target.keyId, by: 'scripts/reseal-fields.ts' },
            correlationId: `reseal:${f.table}:${row.id}`,
          });
          return true;
        });
        if (moved) {
          report.moved++;
          budget--;
          log(`moved ${name(f)} ${row.id}`);
        }
      } catch (e) {
        report.failed.push({ id: row.id, reason: (e as Error).message });
        log(`not moved ${name(f)} ${row.id}: ${(e as Error).message}`);
      }
    }
  }

  let remaining = 0;
  for (const f of SEALED_FIELDS) {
    const now = await countByKey(db, f);
    remaining += Object.entries(now).filter(([k]) => k !== keys.target.keyId).reduce((s, [, n]) => s + n, 0);
  }
  const failed = fields.some((r) => r.failed.length > 0);
  const ok = !failed && (mode === 'plan' || remaining === 0);
  return { mode, target: keys.target.keyId, fields, remaining, ok };
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== 'plan' && mode !== 'apply' && mode !== 'verify') {
    console.error('usage: node scripts/reseal-fields.ts plan | apply [--limit N] | verify');
    process.exit(2);
  }
  const at = process.argv.indexOf('--limit');
  const limit = at > 0 ? Number.parseInt(process.argv[at + 1] ?? '', 10) : undefined;
  if (at > 0 && !(Number.isInteger(limit) && limit! > 0)) {
    console.error('--limit takes a positive whole number');
    process.exit(2);
  }
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    console.error('DATABASE_MIGRATOR_URL is required (the schema owner)');
    process.exit(2);
  }
  const pool = createPool({ connectionString: url, applicationName: 'inrp2p-reseal', max: 2 });
  try {
    const report = await reseal(createDb(pool), resealKeysFromEnv(process.env), mode, { ...(limit ? { limit } : {}), log: (l) => console.log(l) });
    for (const f of report.fields) {
      const keys = Object.entries(f.byKey).map(([k, n]) => `${k}=${n}`).join(', ') || 'no values';
      console.log(`${f.field}: ${keys}${mode === 'apply' ? `; moved ${f.moved}` : ''}${f.failed.length ? `; FAILED ${f.failed.length}` : ''}`);
      for (const x of f.failed) console.log(`  ${x.id}: ${x.reason}`);
    }
    console.log(`${mode}: target ${report.target}; values under another key now: ${report.remaining}; ${report.ok ? 'OK' : 'NOT OK'}`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}
