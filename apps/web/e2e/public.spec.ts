import { expect, test } from '@playwright/test';
import { SITE_PAGES, SITE_PATHS } from '../src/content/site.ts';
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
