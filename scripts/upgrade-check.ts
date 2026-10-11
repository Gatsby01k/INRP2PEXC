/**
 * The upgrade from the release at schema 23 (`d0cc778`, the last release before the production hardening) to this
 * one: data a release at 23 wrote must come through this release's migrations whole.
 *
 * Each database named here was written by the release at 23 itself — in CI, its fixture world and its own end-to-end
 * run, so trades, legs, journals, audit events and seals exist in the states that release produced. This release's
 * `migrate` brings each to SCHEMA_VERSION, and then:
 *   - every migration after 23 applied, in order, and a second run changes nothing;
 *   - nothing was lost: trades, settlement legs, journals, entries, audit events and seals all still there — and
 *     there are seals: CI has the release at 23 seal its log first, as its worker does;
 *   - the books still hold: every journal balances, the ledger nets to zero, the audit seal chain recomputes, every
 *     completed trade is fully settled (the restore checks);
 *   - this release continues the seal chain the release at 23 left: a new event, sealed on top of the last old seal,
 *     and the whole chain still recomputes;
 *   - every trade has exactly one funding model, and every trade that existed before is `LEGACY_EXCHANGE_FUNDED` —
 *     a trade accepted under the old rules is never reinterpreted as counterparty-funded (migration 0025);
 *   - this release reads the upgraded database: the full operations status computes, no restore fence holds and new
 *     business is open;
 *   - with the keys the release at 23 sealed with (`UPGRADE_FIELD_KEYS`, JSON by database name: `{keyId, kekBase64,
 *     hmacBase64}`), every sealed value it wrote moves to a KMS key (`scripts/reseal-fields.ts`, migration 0036 — here an
 *     in-memory KMS) and opens under that key alone with its lookup HMAC unchanged: production's move off `prod-v1`.
 *
 * Run as a superuser against databases at 23 (it migrates them). Usage:
 *   node scripts/upgrade-check.ts <database url> [<database url> …]
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { AwsKmsKeyEncryptionKey, LocalKeyEncryptionKey } from '@inrp2p/adapters';
import { fakeKms } from '@inrp2p/adapters/testing';
import { appendAuditDirect, sealAudit, verifyAuditSeals } from '@inrp2p/audit';
import { SCHEMA_VERSION, createDb, createPool } from '@inrp2p/db';
import { migrate } from '@inrp2p/db/migrate';
import { installQueue } from '@inrp2p/outbox';
import { operationsStatus } from '@inrp2p/desk';
import { newBusinessState, payoutsHeld } from '@inrp2p/trades';
import { type RestoreCounts, countDifferences, restoreCounts, restoreProblems } from './restore-checks.ts';
import { reseal } from './reseal-fields.ts';

const FROM = 23;
const fieldKeys = JSON.parse(process.env.UPGRADE_FIELD_KEYS ?? '{}') as Record<string, { keyId: string; kekBase64: string; hmacBase64: string } | undefined>;
const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('usage: node scripts/upgrade-check.ts <database url> [<database url> …]');
  process.exit(2);
}

let failed = 0;
for (const url of urls) {
  const name = new URL(url).pathname.replace(/^\//, '');
  const pool = createPool({ connectionString: url, applicationName: 'inrp2p-upgrade-check', max: 3 });
  const db = createDb(pool);
  const problems: string[] = [];
  const note = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  try {
    const before: RestoreCounts = await restoreCounts(db);
    const legsBefore = (await sql<{ n: string }>`select count(*)::text as n from settlement_leg`.execute(db)).rows[0]!.n;
    note(before.migration === String(FROM), `the database is at ${before.migration}, not ${FROM}`);
    note(Number(before.trades) > 0, 'the release at 23 wrote no trade here; there is nothing to carry over');
    note(Number(before.auditSeals) > 0, 'the release at 23 sealed nothing here, so no seal chain crosses the upgrade');
    const problemsBefore = await restoreProblems(db);
    note(problemsBefore.length === 0, `already inconsistent at ${FROM}: ${problemsBefore.join('; ')}`);

    const applied = await migrate(pool);
    await installQueue(pool);
    const expected = Array.from({ length: SCHEMA_VERSION - FROM }, (_, i) => FROM + 1 + i);
    note(JSON.stringify(applied) === JSON.stringify(expected), `applied ${applied.join(', ')}; expected ${expected.join(', ')}`);
    note((await migrate(pool)).length === 0, 'a second run of the migrations changed something');

    const after = await restoreCounts(db);
    note(after.migration === String(SCHEMA_VERSION), `the database is at ${after.migration} after the upgrade`);
    // The migration number is meant to move; everything else must be exactly what the release at 23 left.
    problems.push(...countDifferences({ ...before, migration: after.migration }, after));
    const legsAfter = (await sql<{ n: string }>`select count(*)::text as n from settlement_leg`.execute(db)).rows[0]!.n;
    note(legsAfter === legsBefore, `settlement legs ${legsBefore} before, ${legsAfter} after`);
    problems.push(...(await restoreProblems(db)).map((p) => `after the upgrade: ${p}`));

    // Production's move off its locally held key, on the values the release at 23 sealed itself.
    let resealed: { values: number; target: string } | null = null;
    const old = fieldKeys[name];
    if (old) {
      const kms = fakeKms();
      const keys = {
        target: new AwsKmsKeyEncryptionKey({
          keyId: 'kms-upgrade', keyArn: 'arn:aws:kms:us-east-1:111122223333:key/0f0e0d0c-0b0a-4908-8706-050403020100',
          credentials: async () => ({ accessKeyId: 'ASIAUPGRADECHECK', secretAccessKey: 'not-a-secret', sessionToken: 'upgrade-check' }),
          fetchImpl: kms.fetchImpl, endpoint: 'https://kms.upgrade-check.invalid/',
        }),
        sources: [LocalKeyEncryptionKey.fromBase64(old.keyId, old.kekBase64)],
        hmacKey: Buffer.from(old.hmacBase64, 'base64'),
      };
      const accountsBefore = (await sql<{ n: string }>`select count(*)::text as n from bank_account`.execute(db)).rows[0]!.n;
      const plan = await reseal(db, keys, 'plan');
      note(plan.ok, `re-seal plan: ${plan.fields.flatMap((f) => f.failed.map((x) => `${f.field} ${x.id}: ${x.reason}`)).join('; ')}`);
      note(plan.remaining > 0, `the release at 23 sealed nothing under ${old.keyId} here; there is nothing to move`);
      const moved = await reseal(db, keys, 'apply');
      note(moved.ok && moved.remaining === 0, `re-seal apply: ${moved.remaining} values still under another key`);
      note(moved.fields.reduce((n, f) => n + f.moved, 0) === plan.remaining, 'the re-seal did not move every value the plan counted');
      const verified = await reseal(db, keys, 'verify');
      note(verified.ok, `re-seal verify: ${verified.fields.flatMap((f) => f.failed.map((x) => `${f.field} ${x.id}: ${x.reason}`)).join('; ')}`);
      const accountsAfter = (await sql<{ n: string }>`select count(*)::text as n from bank_account`.execute(db)).rows[0]!.n;
      note(accountsAfter === accountsBefore, `bank accounts ${accountsBefore} before the re-seal, ${accountsAfter} after`);
      resealed = { values: plan.remaining, target: keys.target.keyId };
    }

    const funding = (await sql<{ trades: string; funded: string; legacy: string; doubled: string }>`
      select (select count(*) from trade)::text as trades,
             (select count(distinct trade_id) from trade_funding)::text as funded,
             (select count(*) from trade_funding where model = 'LEGACY_EXCHANGE_FUNDED')::text as legacy,
             (select count(*) from (select trade_id from trade_funding group by trade_id having count(*) > 1) d)::text as doubled`.execute(db)).rows[0]!;
    note(funding.funded === funding.trades && funding.doubled === '0', `funding models: ${funding.funded} of ${funding.trades} trades, ${funding.doubled} with more than one`);
    note(funding.legacy === before.trades, `${funding.legacy} trades are legacy exchange-funded; the release at 23 wrote ${before.trades}`);

    // This release continues the chain the release at 23 left: one new event, sealed on top of the last old seal.
    const lastOld = await db.selectFrom('audit_seal').select(['seal_hash']).orderBy('to_seq', 'desc').limit(1).executeTakeFirst();
    await appendAuditDirect(db, { actorType: 'SYSTEM', actorId: null, surface: 'SYSTEM', action: 'upgrade_check.continue_chain', entityType: 'audit_seal', correlationId: randomUUID() });
    const continued = await sealAudit(db, { settleSeconds: 0 });
    const newest = await db.selectFrom('audit_seal').select(['prev_seal_hash']).orderBy('to_seq', 'desc').limit(1).executeTakeFirst();
    note(continued.sealed && lastOld !== undefined && newest?.prev_seal_hash === lastOld.seal_hash, 'this release did not seal on top of the chain the release at 23 left');
    const chain = await verifyAuditSeals(db);
    note(chain.ok, `the seal chain breaks at seal ${String(chain.firstInvalidSealId)} once this release has sealed on top of it`);

    const status = await operationsStatus(db);
    note(status.checks.length > 0, 'the operations status did not compute');
    note(!(await payoutsHeld(db)).held, 'outgoing payments are held on the upgraded database');
    note(!(await newBusinessState(db)).paused, 'new business is paused on the upgraded database');

    console.log(JSON.stringify({ database: name, from: before.migration, to: after.migration, applied, counts: after, legs: legsAfter, funding, resealed, seals: { before: before.auditSeals, afterContinuing: chain.checkedSeals }, health: status.state, problems }, null, 2));
  } catch (e) {
    problems.push(`the upgrade did not complete: ${(e as Error).message}`);
    console.log(JSON.stringify({ database: name, problems }, null, 2));
  } finally {
    await db.destroy();
  }
  if (problems.length > 0) {
    failed += 1;
    for (const p of problems) console.error(`FAIL  ${name}: ${p}`);
  } else {
    console.log(`PASS  ${name}: ${FROM} → ${SCHEMA_VERSION}, nothing lost, the books hold, this release reads it`);
  }
}
if (failed > 0) process.exitCode = 1;
