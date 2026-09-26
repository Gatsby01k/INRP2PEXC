import { expect, test } from '@playwright/test';
import { CLIP_MEASUREMENTS } from '../src/app/(public)/_landing/voice/clips/measurements.ts';
import { AUDIENCE, BUSINESS, CLOSING, DESK, SITE_PAGES, SITE_PATHS } from '../src/content/site.ts';
import { appBaseUrl, deskSendsQuoteWithLink, linkBaseUrl, operatorBaseUrl } from './support.ts';

/**
 * The public site and the headers that protect every surface (PRODUCT §7.4, SECURITY §7).
 *
 * The public host is the only origin here that a stranger can reach, so what it publishes and what it refuses
 * are both worth asserting against the built app rather than against the function that decides it. The header
 * assertions run on all three hosts, because the point of the policy is that it does not get weaker on the host
 * somebody thinks of as "just marketing".
 */
test.describe.configure({ mode: 'serial' });

test('the six routes are published, each with its own words', async ({ page }) => {
  for (const site of SITE_PAGES) {
    const url = `${linkBaseUrl()}${site.path === '/' ? '' : site.path}`;
    const response = await page.goto(url);
    expect(response?.status(), site.path).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: site.h1 })).toBeVisible();
    await expect(page).toHaveTitle(site.title);
    // The canonical URL is built from configuration, never from the Host header that happened to arrive.
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute('href', new RegExp(`${site.path === '/' ? '/?$' : site.path.replace(/\//g, '\\/')}$`));
  }
});

test('the home page is served at / and has no second address', async ({ page }) => {
  const home = await page.goto(linkBaseUrl());
  expect(home?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Buy & sell USDT in India' })).toBeVisible();

  // `/home` is where the page lives in the route tree. Asked for directly it redirects, permanently, to the
  // one address the page has — so nothing links to it, indexes it, or serves the same words twice.
  const direct = await page.request.get(`${linkBaseUrl()}/home`, { maxRedirects: 0 });
  expect(direct.status()).toBe(308);
  expect(new URL(direct.headers()['location']!, linkBaseUrl()).pathname).toBe('/');
});

test('the home page ends with one call to action, and its footer links only to what exists', async ({ page }) => {
  await page.goto(linkBaseUrl());
  for (const heading of [AUDIENCE.heading, DESK.heading, BUSINESS.heading, CLOSING.heading]) {
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
  }
  // The old reading column is gone: the home page says everything in its own sections, once.
  await expect(page.getByRole('heading', { name: 'A desk, not an order book' })).toHaveCount(0);

  // One action at the end, into the client app — not a second pair of Buy and Sell buttons. The harness sets no
  // desk address, so the new-client note carries no link rather than a placeholder one.
  const closing = page.getByRole('region', { name: CLOSING.heading });
  const actions = closing.getByRole('link');
  await expect(actions).toHaveCount(1);
  await expect(actions).toHaveText(CLOSING.cta.label);
  await expect(actions).toHaveAttribute('href', `${appBaseUrl()}${CLOSING.cta.appPath}`);

  // Every footer link is a published page, a section of the home page that is there, or the client app.
  const footer = page.getByRole('contentinfo');
  const hrefs = await footer.getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
  expect(hrefs.length).toBeGreaterThan(SITE_PATHS.length);
  for (const href of hrefs) {
    if (href.startsWith('/#')) await expect(page.locator(href.slice(1)), href).toHaveCount(1);
    else if (href.startsWith('/')) expect(SITE_PATHS, href).toContain(href);
    else expect(href.startsWith(appBaseUrl()), href).toBe(true);
  }
  expect(hrefs.some((h) => h.startsWith('mailto:')), 'no address is published that is not configured').toBe(false);
});

test('the public host still refuses everything it does not publish', async ({ page }) => {
  for (const path of ['/exchange', '/orders', '/pnl', '/sign-in', '/api/receipts/IX-000000-0000']) {
    const res = await page.request.get(`${linkBaseUrl()}${path}`, { maxRedirects: 0 });
    expect(res.status(), path).toBe(401);
  }
});

test('crawlers are told the truth on every host', async ({ page }) => {
  const publicRobots = await page.request.get(`${linkBaseUrl()}/robots.txt`);
  expect(publicRobots.status()).toBe(200);
  const robots = await publicRobots.text();
  expect(robots).toContain('Allow: /');
  // A quote link is private to whoever was sent it.
  expect(robots).toContain('Disallow: /q/');
  expect(robots).toMatch(/Sitemap: https?:\/\/[^\s]+\/sitemap\.xml/);

  const sitemap = await page.request.get(`${linkBaseUrl()}/sitemap.xml`);
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('application/xml');
  const xml = await sitemap.text();
  for (const path of SITE_PATHS) {
    const suffix = path === '/' ? '/' : path;
    expect(xml, path).toContain(`<loc>`);
    expect(xml, path).toContain(suffix);
  }
  expect((xml.match(/<url>/g) ?? []).length).toBe(SITE_PATHS.length);

  // The private surfaces ask not to be crawled at all, and publish no sitemap of their own pages.
  for (const base of [operatorBaseUrl(), appBaseUrl()]) {
    const res = await page.request.get(`${base}/robots.txt`);
    expect(await res.text(), base).toContain('Disallow: /');
    expect((await page.request.get(`${base}/sitemap.xml`)).status(), base).toBe(404);
  }
});

test('the structured data describes the page and invents no figure', async ({ page }) => {
  await page.goto(linkBaseUrl());
  const raw = await page.locator('script[type="application/ld+json"]').innerText();
  const data = JSON.parse(raw) as { '@graph': { '@type': string }[] };
  const types = data['@graph'].map((n) => n['@type']);
  expect(types).toContain('Organization');
  expect(types).toContain('WebSite');
  expect(types).toContain('WebPage');
  // The markup a landing page reaches for when it wants to look established, and cannot have here. Matched as
  // JSON keys rather than as words: the page's own prose says "price" often, and should.
  for (const forbidden of ['aggregateRating', 'review', 'ratingValue', 'reviewCount', 'offers', 'price', 'priceRange']) {
    expect(raw, forbidden).not.toContain(`"${forbidden}":`);
  }
  // It is served inline, so it must carry the nonce of the very response that delivered it. Read from the raw
  // HTML rather than the DOM: browsers deliberately hide the nonce attribute after parsing, so a DOM assertion
  // would pass on a page whose nonce was wrong and fail on one whose nonce was right.
  const served = await page.request.get(linkBaseUrl());
  const html = await served.text();
  const cspNonce = served.headers()['content-security-policy']!.match(/'nonce-([^']+)'/)![1]!;
  const tag = html.match(/<script type="application\/ld\+json" nonce="([^"]+)"/);
  expect(tag, 'the structured data is served with a nonce').not.toBeNull();
  expect(tag![1]).toBe(cspNonce);
});

test('every surface sends the same policy, and a fresh nonce each time', async ({ page }) => {
  const targets = [
    { name: 'public', url: `${linkBaseUrl()}/usdt-otc-india` },
    { name: 'client', url: `${appBaseUrl()}/sign-in` },
    { name: 'desk', url: `${operatorBaseUrl()}/sign-in` },
  ];
  const nonces = new Set<string>();
  for (const target of targets) {
    const res = await page.request.get(target.url, { maxRedirects: 0 });
    const csp = res.headers()['content-security-policy'];
    expect(csp, target.name).toBeTruthy();
    expect(csp, target.name).toContain("frame-ancestors 'none'");
    expect(csp, target.name).toContain("object-src 'none'");
    expect(csp, target.name).toContain("base-uri 'none'");
    expect(csp, target.name).toContain("'strict-dynamic'");
    const script = csp!.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))!;
    expect(script, target.name).not.toContain("'unsafe-inline'");
    expect(script, target.name).not.toContain("'unsafe-eval'");
    nonces.add(script.match(/'nonce-([^']+)'/)![1]!);

    expect(res.headers()['x-frame-options'], target.name).toBe('DENY');
    expect(res.headers()['x-content-type-options'], target.name).toBe('nosniff');
    expect(res.headers()['referrer-policy'], target.name).toBe('no-referrer');
    expect(res.headers()['permissions-policy'], target.name).toContain('camera=()');
    // This harness is plain http, so the one header that must never be sent over http is not sent.
    expect(res.headers()['strict-transport-security'], target.name).toBeUndefined();
  }
  expect(nonces.size, 'every request gets its own nonce').toBe(targets.length);
});

test('the probes answer on every host, and the one with figures in it does not', async ({ page }) => {
  for (const base of [linkBaseUrl(), appBaseUrl(), operatorBaseUrl()]) {
    const live = await page.request.get(`${base}/api/health/live`);
    expect(live.status(), `${base} live`).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });

    const ready = await page.request.get(`${base}/api/health/ready`);
    expect(ready.status(), `${base} ready`).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    // Neither probe says anything about the business — that is what lets them be open.
    expect(JSON.stringify(await ready.json()).length).toBeLessThan(40);

    // The full picture carries capacity, holds and scanner lag, so it is refused without a token or a session.
    const status = await page.request.get(`${base}/api/health/status`, { maxRedirects: 0 });
    expect(status.status(), `${base} status`).toBe(401);
  }
});

test('a page under the policy loads without the browser refusing anything', async ({ page }) => {
  const violations: string[] = [];
  const errors: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(text)) violations.push(text);
    else if (message.type() === 'error') errors.push(text);
  });
  await page.goto(linkBaseUrl());
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The quote link is the one public page that runs JavaScript of its own — a countdown against a firm price.
  // If the policy blocked its scripts the countdown would simply never move, which is not something a person
  // notices until a client says the price expired while they were reading it.
  const quote = await deskSendsQuoteWithLink({ amount: '1000', clientRate: '102.000000' });
  await page.goto(`${linkBaseUrl()}/q/${quote.token}`);
  await expect(page.getByLabel('Firm quote')).toBeVisible();
  // The client sign-in page is the strongest check available without a session: it is a React island that only
  // works if the framework's own scripts ran, which under `strict-dynamic` means they were nonced correctly.
  // The client sign-in page is the strongest check available without a session: its button is disabled until
  // React sees what was typed. If `strict-dynamic` had blocked the framework's scripts the page would still
  // render — server-rendered HTML always does — and the button would stay disabled forever.
  await page.goto(`${appBaseUrl()}/sign-in`);
  const submit = page.getByRole('button').first();
  await expect(submit).toBeDisabled();
  await page.getByRole('textbox').first().fill('someone@example.test');
  await expect(submit).toBeEnabled();
  expect(violations, violations.join('\n')).toEqual([]);
  // Any console error at all on a public page is worth failing for: it is what Lighthouse reports as a
  // best-practices failure, and on these pages there is nothing that should be logging one.
  expect(errors, errors.join('\n')).toEqual([]);
});

/**
 * The robot's voice: three recorded lines, each after something the visitor did and never before (the hero's
 * `voice/controller.ts`). Real Web Audio, under the site's real policy; what is recorded is every clip the page
 * starts, when, and every clip it fetches — so "at once" and "from memory" are measured, not assumed.
 */
test('the robot speaks from memory, at once, only three lines — and never once muted', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    // What the page's audio does, as it does it: every clip started, when, and in what state the audio was.
    const log = { played: [] as { duration: number; at: number; state: string }[], pressedAt: 0 };
    (window as unknown as { voiceLog: typeof log }).voiceLog = log;
    window.addEventListener('pointerdown', () => (log.pressedAt = performance.now()), { capture: true });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<typeof start>) {
      const duration = this.buffer?.duration ?? 0;
      // The single silent frame that unlocks audio is not a line.
      if (duration > 0.05) log.played.push({ duration, at: performance.now(), state: this.context.state });
      return start.apply(this, args);
    };
  });
  const page = await context.newPage();
  const clipRequests: { url: string; afterFirstPress: boolean }[] = [];
  let pressed = false;
  page.on('request', (request) => {
    if (/\/_next\/static\/media\/(ready|received|check)\./.test(request.url())) clipRequests.push({ url: request.url(), afterFirstPress: pressed });
  });
  const log = () => page.evaluate(() => (window as unknown as { voiceLog: { played: { duration: number; at: number; state: string }[]; pressedAt: number } }).voiceLog);
  const lines = async () => (await log()).played.map((p) => p.duration);

  await page.goto(linkBaseUrl());
  const control = page.getByRole('button', { name: 'Voice' });
  // The control appears once every clip is loaded and decoded — before anything could need one.
  await expect(control).toHaveAttribute('data-available', 'true');
  await expect(control).toHaveAttribute('aria-pressed', 'true');
  expect(clipRequests, 'one format of each of the three clips').toHaveLength(3);

  // Nothing on arrival, however long the page is left open.
  await page.waitForTimeout(1500);
  expect(await lines()).toEqual([]);

  // The first move in the quote module is answered at once — started inside the same press, from memory. The
  // pointer arrives first, as a visitor's does: that is when the audio device is prepared, off the press.
  const amount = page.getByLabel('You sell');
  await amount.hover();
  await page.waitForTimeout(400);
  pressed = true;
  await amount.click();
  await expect.poll(lines).toHaveLength(1);
  const greeting = await log();
  expect(greeting.played[0]!.duration).toBeCloseTo(CLIP_MEASUREMENTS.ready.duration, 1);
  expect(greeting.played[0]!.at - greeting.pressedAt, 'started within the press').toBeLessThan(50);
  expect(greeting.played[0]!.state).not.toBe('closed');

  // Amounts and directions are shown, never spoken.
  await amount.press('End');
  await amount.press('Backspace');
  await amount.press('5');
  await page.getByRole('radio', { name: 'Buy USDT' }).click();
  await page.waitForTimeout(1500);
  expect(await lines()).toHaveLength(1);

  // A request without an amount stays here, says why next to the field, and is answered once.
  const buying = page.getByLabel('You buy');
  await buying.fill('');
  const cta = page.getByRole('link', { name: 'Request quote' });
  const here = page.url();
  await cta.click();
  await expect(page.getByText('Enter an amount to request a quote.')).toBeVisible();
  await expect(buying).toBeFocused();
  expect(page.url()).toBe(here);
  await expect.poll(lines).toHaveLength(2);
  expect((await lines())[1]).toBeCloseTo(CLIP_MEASUREMENTS.check.duration, 1);
  await page.waitForTimeout(1500);
  await cta.click();
  await page.waitForTimeout(600);
  expect(await lines(), 'said once per visit').toHaveLength(2);
  await buying.fill('250000');
  await expect(page.getByText('Enter an amount to request a quote.')).toHaveCount(0);
  expect(clipRequests.filter((r) => r.afterFirstPress), 'no request when the robot speaks').toEqual([]);

  // Muted, it says nothing — and stays muted on the next visit.
  await control.click();
  await expect(control).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  const again = page.getByRole('button', { name: 'Voice' });
  await expect(again).toHaveAttribute('data-available', 'true');
  await expect(again).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('You sell').click();
  await page.waitForTimeout(1200);
  expect(await lines()).toEqual([]);
  await context.close();
});
