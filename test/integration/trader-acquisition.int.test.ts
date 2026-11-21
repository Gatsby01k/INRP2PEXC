import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { createTestClientLogin } from '@inrp2p/identity/testing';
import type { Attribution, Touch } from '../../apps/web/src/server/acquisition.ts';
import { linkAcquisition, recordAcquisitionEvent } from '../../apps/web/src/server/acquisition-record.ts';
import { traderFunnel } from '../../apps/web/src/server/acquisition-funnel.ts';
import { type TradersWorld, configureProgram, createTradersWorld, liveTrader, traderClient } from './traders-world.ts';

/**
 * Where traders come from (migration 0053), end to end in the database: what `inrp2p.com/traders` and the trader sign-in
 * record about a visitor, tied to who they become — and the desk's funnel reading the rest from the business itself:
 * the application, its approval, the Security Reserve on the ledger.
 */

let w: TradersWorld;
beforeAll(async () => {
  w = await createTradersWorld('trader_acquisition');
  await configureProgram(w, { reserve: '500' });
});
afterAll(async () => w.close());

const now = () => Math.floor(Date.now() / 1000);
const touch = (t: Partial<Touch>): Touch => ({ source: null, medium: null, campaign: null, content: null, term: null, ref: null, click: null, clickId: null, referrer: null, at: now() - 60, ...t });
const visitor = (first: Partial<Touch>, segment: Attribution['segment'] = null): Attribution => ({ visitor: crypto.randomUUID(), first: touch(first), last: touch(first), segment });
const ctx = { country: 'IN', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' };

describe('a campaign followed from a Telegram post to a trader holding a reserve', () => {
  const telegram = visitor({ source: 'telegram', medium: 'post', campaign: 'launch', ref: 'abc' }, 'usdt');
  const linkedin = visitor({ source: 'linkedin', click: 'LINKEDIN', clickId: 'li-123' });
  const referred = visitor({ referrer: 't.me' });
  let traderId: string;

  beforeAll(async () => {
    // The Telegram visitor sees the page, picks a side, presses apply, reaches the sign-in, signs in — and becomes a live trader.
    for (const kind of ['VIEW', 'SEGMENT', 'CTA'] as const) await recordAcquisitionEvent(w.app, telegram, { kind, page: 'TRADERS', ...(kind === 'CTA' ? { placement: 'hero' } : {}) }, ctx);
    await recordAcquisitionEvent(w.app, telegram, { kind: 'ENTRY', page: 'BECOME_A_TRADER' }, ctx);
    const setup = await traderClient(w, 'Launch Traders');
    await linkAcquisition(w.app, telegram, setup.admin.userId, ctx);
    ({ traderId } = await liveTrader(w, setup, { sell: { capacity: '20000', rate: '97.00', min: '100', max: '20000' } }));
    // The LinkedIn visitor only looks.
    await recordAcquisitionEvent(w.app, linkedin, { kind: 'VIEW', page: 'TRADERS' }, ctx);
    // Someone referred from a Telegram channel presses apply and signs in, but has not applied.
    await recordAcquisitionEvent(w.app, referred, { kind: 'CTA', page: 'TRADERS', placement: 'sticky' }, ctx);
    const login = await createTestClientLogin(w.t.owner, { emailVerified: true });
    await linkAcquisition(w.app, referred, login.userId, ctx);
    // Linking twice is the same link.
    await linkAcquisition(w.app, referred, login.userId, ctx);
  });

  it('keeps the visitor once, with its first touch, and nothing about the person', async () => {
    const row = await w.app.selectFrom('acquisition_visitor').selectAll().where('id', '=', telegram.visitor).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ source: 'telegram', medium: 'post', campaign: 'launch', ref: 'abc', segment: 'USDT', country: 'IN', device: 'MOBILE', click_kind: null });
    const li = await w.app.selectFrom('acquisition_visitor').select(['click_kind', 'click_id']).where('id', '=', linkedin.visitor).executeTakeFirstOrThrow();
    expect(li).toEqual({ click_kind: 'LINKEDIN', click_id: 'li-123' });
    const events = await w.app.selectFrom('acquisition_event').select(['kind', 'page', 'placement']).where('visitor_id', '=', telegram.visitor).orderBy('at').execute();
    expect(events.map((e) => e.kind)).toEqual(['VIEW', 'SEGMENT', 'CTA', 'ENTRY']);
    expect(events.find((e) => e.kind === 'CTA')?.placement).toBe('hero');
  });

  it('reads the whole funnel per campaign, the business part from the business itself', async () => {
    const f = await traderFunnel(w.app, { days: 30, by: 'campaign' });
    const row = (k: string) => f.rows.find((r) => r.key[0] === k);
    expect(row('telegram')).toMatchObject({ key: ['telegram', 'post', 'launch'], visitors: 1, chose: 1, clicked: 1, entered: 1, signedIn: 1, applied: 1, approved: 1, reserved: 1, active: 0 });
    expect(row('linkedin')).toMatchObject({ visitors: 1, clicked: 0, signedIn: 0, applied: 0 });
    expect(row('via t.me')).toMatchObject({ visitors: 1, clicked: 1, signedIn: 1, applied: 0 });
    expect(f.total).toMatchObject({ visitors: 3, clicked: 2, signedIn: 2, applied: 1, approved: 1, reserved: 1 });

    expect((await traderFunnel(w.app, { days: 30, by: 'ref' })).rows.find((r) => r.key[0] === 'abc')).toMatchObject({ visitors: 1, applied: 1 });
    expect((await traderFunnel(w.app, { days: 30, by: 'segment' })).rows.find((r) => r.key[0] === 'USDT')).toMatchObject({ visitors: 1, reserved: 1 });
    expect(f.applicants).toEqual([expect.objectContaining({ traderId, name: 'Launch Traders', status: 'APPROVED', source: 'telegram', campaign: 'launch', referral: 'abc', reserved: true, active: false })]);
  });

  it('is a record, not a log to edit', async () => {
    const changed = await sql`update acquisition_event set placement = 'forged' where visitor_id = ${telegram.visitor}`.execute(w.app).then(
      () => null,
      (e: unknown) => pgErrorCode(e),
    );
    expect(changed).not.toBeNull();
    await expect(sql`update acquisition_visitor set source = 'forged' where id = ${telegram.visitor}`.execute(w.app)).rejects.toThrow();
  });

  it('never stands between a visitor and a page: a record the database refuses is dropped, not thrown', async () => {
    // A visitor id that is not one — the database refuses it; the recorder logs and returns.
    const broken = { ...visitor({ source: 'x' }), visitor: 'not-a-uuid' };
    await expect(recordAcquisitionEvent(w.app, broken, { kind: 'VIEW', page: 'TRADERS' }, ctx)).resolves.toBeUndefined();
    await expect(linkAcquisition(w.app, broken, crypto.randomUUID(), ctx)).resolves.toBeUndefined();
  });
});
