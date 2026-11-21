import { describe, expect, it } from 'vitest';
import {
  type Attribution, type Touch, arrive, carry, decodeAttribution, deviceOf, encodeAttribution, hasSignal, refCode, referrerHost, segmentOf, touchOf, traderEntryHref,
  word,
} from '../src/server/acquisition.ts';
import { ACQUISITION_EVENT_PATH, TRADERS_PAGE_PATH, gateFor, isPublicSitePath, isWorkspacePath } from '../src/server/surface.ts';

/**
 * Where a trader came from (migration 0053). Everything this module reads is somebody's input — a URL, a `Referer`, a
 * cookie, a link's token — so these hold it to the one promise it makes: what comes out is a campaign's word, a code, a
 * network's name, a host, a time and a random id, or nothing at all. Never an address, a path or anything else.
 */

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const at = Math.floor(NOW / 1000);
const VISITOR = '0a367040-ed41-4bf8-b7a6-b4277c3547aa';
const direct = (t = at): Touch => ({ source: null, medium: null, campaign: null, content: null, term: null, ref: null, click: null, clickId: null, referrer: null, at: t });

describe('what a campaign may say', () => {
  it('keeps a campaign’s words lower-cased, spaces as hyphens, in a small alphabet', () => {
    expect(word('Telegram')).toBe('telegram');
    expect(word('  Launch Day  ')).toBe('launch-day');
    expect(word('otc_desks.v2')).toBe('otc_desks.v2');
    for (const bad of ['<script>', 'a@b.com', 'x'.repeat(65), '', '   ', 'ok?x=1', 42, null]) expect(word(bad), String(bad)).toBeNull();
  });

  it('takes a referral code, and nothing shaped like anything else', () => {
    expect(refCode('Partner-1')).toBe('partner-1');
    expect(refCode('a b')).toBeNull();
    expect(refCode('x'.repeat(41))).toBeNull();
  });

  it('reads the touch from the address: utm words, a referral code, the first ad click there is', () => {
    const t = touchOf(new URLSearchParams('utm_source=LinkedIn&utm_medium=cpc&utm_campaign=otc&utm_content=a&utm_term=usdt&ref=r1&fbclid=F_1&gclid=G-1'), 'lnkd.in', NOW);
    expect(t).toEqual({ source: 'linkedin', medium: 'cpc', campaign: 'otc', content: 'a', term: 'usdt', ref: 'r1', click: 'GOOGLE', clickId: 'G-1', referrer: 'lnkd.in', at });
    expect(hasSignal(t)).toBe(true);
    expect(hasSignal(touchOf(new URLSearchParams('for=inr&x=1'), null, NOW))).toBe(false);
    // A click id outside its alphabet is no click at all.
    expect(touchOf(new URLSearchParams('gclid=<x>'), null, NOW).click).toBeNull();
  });

  it('reads a referrer as its host — never its path or query — and drops INRP2P’s own', () => {
    const own = ['inrp2p.com', 'app.inrp2p.com:443', 'desk.inrp2p.com'];
    expect(referrerHost('https://www.linkedin.com/feed/update/urn:li:activity:1?token=secret', own)).toBe('linkedin.com');
    expect(referrerHost('https://t.me/INR_P2P_USDT/42', own)).toBe('t.me');
    expect(referrerHost('https://inrp2p.com/usdt-to-inr', own)).toBeNull();
    expect(referrerHost('https://app.inrp2p.com/traders', own)).toBeNull();
    expect(referrerHost('not a url', own)).toBeNull();
    expect(referrerHost(null, own)).toBeNull();
  });

  it('knows the three sides and nothing else', () => {
    expect(segmentOf('USDT')).toBe('usdt');
    expect(segmentOf(' otc ')).toBe('otc');
    expect(segmentOf('btc')).toBeNull();
    expect(segmentOf(undefined)).toBeNull();
  });

  it('keeps a kind of device, never the agent', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148')).toBe('MOBILE');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe('MOBILE');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('TABLET');
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15')).toBe('DESKTOP');
    expect(deviceOf(null)).toBeNull();
  });
});

describe('arriving, again and again', () => {
  const telegram: Touch = { ...direct(at - 3600), source: 'telegram', campaign: 'launch' };

  it('gives a first visit an id, and its touch as both first and last', () => {
    const { attribution, changed } = arrive(null, telegram, 'usdt', () => VISITOR);
    expect(changed).toBe(true);
    expect(attribution).toEqual({ visitor: VISITOR, first: telegram, last: telegram, segment: 'usdt' });
  });

  it('keeps the first touch for good; a direct visit changes nothing, a campaign becomes the last touch', () => {
    const seen: Attribution = { visitor: VISITOR, first: telegram, last: telegram, segment: null };
    expect(arrive(seen, direct(), null, () => 'never')).toEqual({ attribution: seen, changed: false });
    const linkedin: Touch = { ...direct(), source: 'linkedin' };
    const next = arrive(seen, linkedin, 'otc', () => 'never');
    expect(next.changed).toBe(true);
    expect(next.attribution).toEqual({ visitor: VISITOR, first: telegram, last: linkedin, segment: 'otc' });
  });

  it('on the app’s host, the earlier first touch wins with its visitor, and the carried last touch is the latest', () => {
    const older: Attribution = { visitor: '11111111-1111-4111-8111-111111111111', first: { ...telegram, at: at - 86_400 }, last: telegram, segment: null };
    const carried: Attribution = { visitor: VISITOR, first: { ...direct(at - 60), source: 'x' }, last: { ...direct(at - 60), source: 'x' }, segment: 'inr' };
    expect(carry(older, carried)).toEqual({ ...older, last: carried.last, segment: 'inr' });
    expect(carry(null, carried)).toEqual(carried);
  });
});

describe('the cookie and the link', () => {
  const a: Attribution = {
    visitor: VISITOR,
    first: { ...direct(at - 60), source: 'telegram', ref: 'abc', click: 'META', clickId: 'F_1', referrer: 't.me' },
    last: { ...direct(at), source: 'linkedin', campaign: 'otc-desks' },
    segment: 'otc',
  };

  it('round-trips, URL-safe', () => {
    const encoded = encodeAttribution(a);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAttribution(encoded, NOW)).toEqual(a);
  });

  it('reads anything that is not an attribution as none — and cleans what it does read', () => {
    const json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    expect(decodeAttribution('', NOW)).toBeNull();
    expect(decodeAttribution('%%%', NOW)).toBeNull();
    expect(decodeAttribution(json({ v: 'not-a-uuid', f: [], l: [] }), NOW)).toBeNull();
    // From the future, or from before the site existed: not a touch.
    const packed = (t: number) => [null, null, null, null, null, null, null, null, null, t];
    expect(decodeAttribution(json({ v: VISITOR, f: packed(at + 2 * 86_400), l: packed(at) }), NOW)).toBeNull();
    expect(decodeAttribution(json({ v: VISITOR, f: packed(Date.UTC(2025, 0, 1) / 1000), l: packed(at) }), NOW)).toBeNull();
    // A value outside its alphabet is dropped, the rest kept; a click id without a network is no click.
    const dirty = decodeAttribution(json({ v: VISITOR, s: 'btc', f: ['<b>', 'Post', null, null, null, null, 'NOPE', 'x', 'evil.com/path', at], l: packed(at) }), NOW)!;
    expect(dirty.first).toMatchObject({ source: null, medium: 'post', click: null, clickId: null, referrer: null });
    expect(dirty.segment).toBeNull();
  });

  it('puts the attribution and the side into the trader sign-in’s address, and nothing else', () => {
    expect(traderEntryHref('https://app.inrp2p.com', '/become-a-trader', 'abc', 'inr')).toBe('https://app.inrp2p.com/become-a-trader?t=abc&for=inr');
    expect(traderEntryHref('https://app.inrp2p.com', '/become-a-trader', null, null)).toBe('https://app.inrp2p.com/become-a-trader');
  });
});

describe('where the page and its count are served', () => {
  it('serves the page’s inside and the count on the public host only', () => {
    expect(isPublicSitePath(TRADERS_PAGE_PATH)).toBe(true);
    expect(gateFor('PUBLIC', TRADERS_PAGE_PATH)).toBe('PUBLIC');
    expect(gateFor('PUBLIC', ACQUISITION_EVENT_PATH)).toBe('PUBLIC');
    expect(gateFor('CLIENT', ACQUISITION_EVENT_PATH)).toBe('CLIENT_SESSION');
    expect(gateFor('OPERATOR', ACQUISITION_EVENT_PATH)).toBe('OPERATOR_SESSION');
    expect(gateFor('CLIENT', TRADERS_PAGE_PATH)).toBe('CLIENT_SESSION');
  });

  it('leaves everything under `/traders` the workspace’s', () => {
    for (const path of ['/traders', '/traders/orders', '/traders/apply']) expect(isWorkspacePath(path), path).toBe(true);
  });
});
