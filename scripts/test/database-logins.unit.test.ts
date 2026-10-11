import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOGINS, loginProblems, loginUrl, neonPooledHost, prepareStrings, readEnvFile, scramVerifier, writeEnvFile } from '../database-logins.ts';

const MIGRATOR = 'postgresql://neondb_owner:owner-secret@ep-proud-leaf-avub33vw.c-11.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const [web, worker] = LOGINS as [typeof LOGINS[0], typeof LOGINS[0]];

describe('database logins for the web app and the worker', () => {
  it('connect the web app through Neon’s pooler and the worker directly, as their own roles, never the owner', () => {
    expect(neonPooledHost('ep-proud-leaf-avub33vw.c-11.us-east-1.aws.neon.tech')).toBe('ep-proud-leaf-avub33vw-pooler.c-11.us-east-1.aws.neon.tech');
    expect(neonPooledHost('ep-proud-leaf-avub33vw-pooler.c-11.us-east-1.aws.neon.tech')).toBe('ep-proud-leaf-avub33vw-pooler.c-11.us-east-1.aws.neon.tech');
    expect(neonPooledHost('db.internal')).toBeNull();

    const w = new URL(loginUrl(MIGRATOR, web, 'p@ss/word'));
    expect([w.username, decodeURIComponent(w.password), w.hostname, w.pathname, w.searchParams.get('sslmode')])
      .toEqual(['inrp2p_app_login', 'p@ss/word', 'ep-proud-leaf-avub33vw-pooler.c-11.us-east-1.aws.neon.tech', '/neondb', 'require']);
    const k = new URL(loginUrl(MIGRATOR.replace('avub33vw.', 'avub33vw-pooler.'), worker, 'x'));
    expect([k.username, k.hostname]).toEqual(['inrp2p_worker_login', 'ep-proud-leaf-avub33vw.c-11.us-east-1.aws.neon.tech']);
    expect(new URL(loginUrl('postgres://o:p@db.internal:5432/inrp2p', web, 'x', 'pgbouncer.internal')).hostname).toBe('pgbouncer.internal');
  });

  it('send PostgreSQL a SCRAM-SHA-256 verifier, never the password', () => {
    const v = scramVerifier('correct horse battery staple');
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(v).not.toContain('correct horse');
    expect(scramVerifier('same', Buffer.alloc(16, 1))).toBe(scramVerifier('same', Buffer.alloc(16, 1)));
    expect(scramVerifier('same')).not.toBe(scramVerifier('same')); // a fresh salt each time
  });

  it('keep a string already prepared, and write the env file for its owner only, leaving every other line', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'logins-')), 'neon.env');
    writeFileSync(file, '# comment\nDATABASE_MIGRATOR_URL=keep-me\n');
    const env = readEnvFile(file);
    const first = prepareStrings(env, MIGRATOR, 'REHEARSAL_');
    writeEnvFile(file, new Map([...env].filter(([k]) => k.startsWith('REHEARSAL_'))));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('# comment\nDATABASE_MIGRATOR_URL=keep-me\n')).toBe(true);
    const again = prepareStrings(readEnvFile(file), MIGRATOR, 'REHEARSAL_');
    expect(again).toEqual(first);
    expect(first.get('inrp2p_app_login')).not.toBe(first.get('inrp2p_worker_login'));
    expect(first.get('inrp2p_app_login')!.length).toBeGreaterThanOrEqual(43);
  });

  it('refuse a login with privileges or other memberships rather than quietly use it', () => {
    expect(loginProblems({ role: 'inrp2p_app_login', exists: true, canLogin: true, privileged: [], memberOf: ['inrp2p_app'] }, web)).toEqual([]);
    expect(loginProblems({ role: 'inrp2p_app_login', exists: true, canLogin: true, privileged: ['bypassrls'], memberOf: ['inrp2p_app', 'neon_superuser'] }, web)).toEqual([
      'inrp2p_app_login has bypassrls: a process login must have none',
      'inrp2p_app_login is also a member of neon_superuser: it must belong to inrp2p_app only',
    ]);
  });
});
