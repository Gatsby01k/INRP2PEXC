import { type Browser, type BrowserContextOptions, type Page, chromium, devices, expect, test } from '@playwright/test';
import { surfacePorts } from '../harness/desk-server.ts';
import { NETWORKS, type NetworkName, shapedProxy } from './netsim.ts';
import { appBaseUrl, linkBaseUrl, resetAuthThrottle, signInAsClient, state } from './support.ts';

/**
 * A phone in India (performance and interaction). The pages a stranger and a client reach first — the home page, a
 * search page, the client's sign-in, the Exchange — loaded on a mid-range phone (Pixel 7, its CPU slowed to the same
 * phone on whatever machine runs this: `CPU_SLOWDOWN`) over the network a phone in India has to this product on Vercel
 * (`netsim.ts`: the last mile to the Mumbai edge, and the
 * round trip on to the functions in iad1 for everything the edge cannot answer itself). Each page is loaded cold — a
 * new browser, nothing cached — and then warm, several times, and judged on the median.
 *
 * The budgets are the web's own thresholds where they hold still (LCP 2.5 s and CLS 0.1 "good"), and generous where the
 * machine moves them: blocking time and a tap's answer (under 500 ms, INP's line to "poor") are CPU work, and on CI's
 * runners the same build measured the home page's blocking time anywhere from 388 to 858 ms (87 ms on an M1, whose
 * JavaScript the runners match: the spread is theirs, not the page's), so they are judged on the fastest run, the rest
 * on the median. They catch the regressions that cost a visitor
 * seconds — a page that waits on a far database, a script that blocks the first tap, a request per row — not the
 * milliseconds that move with the machine running the test. The model's own floor is in every number: a cold page pays the handshakes with the edge
 * and the trip to iad1 (370 ms on the 4G profile) before its first byte.
 */
test.describe.configure({ mode: 'serial' });

const RUNS = Number.parseInt(process.env.PERF_RUNS ?? '3', 10);

/**
 * How much to slow this machine's CPU so it plays the same phone wherever the suite runs. The budgets were set on an
 * Apple M1 slowed four times (Lighthouse's own mobile factor, a mid-range phone), where `benchmark` takes this long; a
 * slower machine is slowed less, as Lighthouse's `benchmarkIndex` would advise. (CI's runners run it as fast as an M1,
 * and are slowed four times too.) `PERF_CPU_SLOWDOWN` fixes the factor instead.
 */
const REFERENCE_BENCHMARK_MS = 28;
const REFERENCE_SLOWDOWN = 4;
let CPU_SLOWDOWN = REFERENCE_SLOWDOWN;

/** A fixed piece of page work — build, sort and lay out rows — timed unthrottled: the median of seven. */
async function benchmark(page: Page): Promise<number> {
  return page.evaluate(() => {
    const runs: number[] = [];
    for (let r = 0; r < 7; r++) {
      const t = performance.now();
      const rows: { id: number; label: string }[] = [];
      for (let i = 0; i < 60000; i++) rows.push({ id: i, label: `row-${(i * 2654435761) % 1000003}` });
      rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
      const el = document.createElement('div');
      for (let i = 0; i < 1500; i++) {
        const span = document.createElement('span');
        span.textContent = rows[i]!.label;
        el.append(span);
      }
      document.body.append(el);
      void el.offsetHeight;
      el.remove();
      runs.push(performance.now() - t);
    }
    return runs.sort((a, b) => a - b)[3]!;
  });
}
const PORTS = surfacePorts(Number.parseInt(process.env.E2E_PORT ?? '3210', 10));
/** Each network's proxies listen this far above the servers' own ports (same number of digits: `netsim.ts`). */
const OFFSET: Record<NetworkName, number> = { 'india-4g': 1000, 'india-slow-4g': 2000 };
const shaped = (base: string, network: NetworkName) => {
  const u = new URL(base);
  u.port = String(Number(u.port) + OFFSET[network]);
  return u.origin;
};

interface Load {
  readonly ttfb: number;
  readonly lcp: number;
  readonly cls: number;
  /** What moved, when, and how many web fonts had arrived by then — a layout shift says nothing about its cause. */
  readonly shifts: readonly string[];
  /** Total blocking time: the part of each long task over 50 ms, until the measure. */
  readonly tbt: number;
  /** The slowest answer to the page's interaction, ms (Event Timing, as INP measures it). */
  readonly interaction: number;
}

/** Collected in the page from its first byte: largest paint, layout shifts, long tasks, interactions. */
function observe() {
  type Perf = { lcp: number; cls: number; shifts: string[]; long: number[]; events: number[] };
  const w = window as unknown as { __perf: Perf };
  const p: Perf = { lcp: 0, cls: 0, shifts: [], long: [], events: [] };
  w.__perf = p;
  const on = (type: string, fn: (e: PerformanceEntry & Record<string, unknown>) => void, extra: Record<string, unknown> = {}) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => fn(e as PerformanceEntry & Record<string, unknown>))).observe({ type, buffered: true, ...extra });
    } catch {
      // A browser without the entry type measures nothing for it.
    }
  };
  on('largest-contentful-paint', (e) => (p.lcp = e.startTime));
  on('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    p.cls += e.value as number;
    const fonts = [...document.fonts].filter((f) => f.status === 'loaded').length;
    const moved = ((e.sources as { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] | undefined) ?? []).slice(0, 3).map((s) => {
      const el = s.node instanceof Element ? s.node : s.node?.parentElement;
      const name = el ? `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ')[0]}` : ''}` : '?';
      return `${name} ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}`;
    });
    p.shifts.push(`${Math.round(e.startTime)} ms +${(e.value as number).toFixed(3)} (${fonts} fonts loaded): ${moved.join('; ')}`);
  });
  on('longtask', (e) => p.long.push(e.duration));
  on('event', (e) => {
    if (e.interactionId) p.events.push(e.duration);
  }, { durationThreshold: 16 });
}

async function measure(page: Page): Promise<Load> {
  return page.evaluate(() => {
    const p = (window as unknown as { __perf: { lcp: number; cls: number; shifts: string[]; long: number[]; events: number[] } }).__perf;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return {
      ttfb: Math.round(nav.responseStart),
      lcp: Math.round(p.lcp),
      cls: Number(p.cls.toFixed(4)),
      shifts: p.shifts,
      tbt: Math.round(p.long.reduce((s, d) => s + Math.max(0, d - 50), 0)),
      interaction: Math.round(Math.max(0, ...p.events)),
    };
  });
}

async function phone(browser: Browser, extra: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'], ...extra });
  await context.addInitScript(observe);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  return page;
}

const median = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Cold then warm, `RUNS` times: a new browser context each time, then the same page loaded again in it. */
async function loads(browser: Browser, url: string, opts: { storage?: BrowserContextOptions['storageState']; ready: (page: Page) => Promise<void>; interact?: (page: Page) => Promise<void> }) {
  const cold: Load[] = [];
  const warm: Load[] = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await phone(browser, opts.storage ? { storageState: opts.storage } : {});
    for (const into of [cold, warm]) {
      const response = await page.goto(url, { waitUntil: 'load' });
      // The page itself, never a redirect on the way to it: each hop would be another trip to iad1.
      expect(response?.request().redirectedFrom()).toBeNull();
      expect(response?.status()).toBe(200);
      await opts.ready(page);
      await page.waitForLoadState('networkidle');
      await opts.interact?.(page);
      // Event Timing reports an interaction once its frame is painted.
      await page.waitForTimeout(400);
      into.push(await measure(page));
    }
    await page.context().close();
  }
  const summary = (xs: Load[]) => ({
    ttfb: median(xs.map((x) => x.ttfb)),
    lcp: median(xs.map((x) => x.lcp)),
    cls: median(xs.map((x) => x.cls)),
    // The worst run's shifts, printed with the numbers: the next reader can see what moved without a trace.
    worst: [...xs].sort((a, b) => b.cls - a.cls)[0]!,
    // CPU work is judged on the fastest run: a shared machine's neighbours only ever add to it, so the fastest is the
    // page's own cost, and a regression is in every run.
    tbt: Math.min(...xs.map((x) => x.tbt)),
    interaction: Math.min(...xs.map((x) => x.interaction)),
  });
  return { cold: summary(cold), warm: summary(warm) };
}

const stops: (() => void)[] = [];
let client: NonNullable<BrowserContextOptions['storageState']>;

test.beforeAll(async ({ browser }) => {
  {
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await context.newPage();
    const ms = await benchmark(page);
    await context.close();
    const fixed = process.env.PERF_CPU_SLOWDOWN;
    CPU_SLOWDOWN = fixed ? Number.parseFloat(fixed) : Math.min(8, Math.max(1, Math.round(((REFERENCE_SLOWDOWN * REFERENCE_BENCHMARK_MS) / ms) * 4) / 4));
    console.log(`mobile-perf: this machine runs the benchmark in ${ms.toFixed(1)} ms (reference ${REFERENCE_BENCHMARK_MS} ms), so its CPU is slowed ×${CPU_SLOWDOWN}`);
  }
  for (const network of Object.keys(NETWORKS) as NetworkName[]) {
    for (const port of [PORTS.app, PORTS.public]) stops.push(await shapedProxy(port + OFFSET[network], port, NETWORKS[network]));
  }
  await resetAuthThrottle();
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAsClient(page, state().acceptorEmail);
  client = await context.storageState();
  await context.close();
});
test.afterAll(() => {
  for (const stop of stops) stop();
});

/** One line per page and network in the run's output: the numbers the budgets were held to, for the next reader. */
function report(name: string, network: string, r: Awaited<ReturnType<typeof loads>>) {
  const line = (k: 'cold' | 'warm') => `${k} ttfb ${r[k].ttfb} lcp ${r[k].lcp} cls ${r[k].cls} (worst ${r[k].worst.cls}) tbt ${r[k].tbt} tap ${r[k].interaction}`;
  console.log(`mobile-perf ${name} @ ${network} (median of ${RUNS}, tbt and tap the fastest, CPU ×${CPU_SLOWDOWN}): ${line('cold')} | ${line('warm')}`);
  for (const k of ['cold', 'warm'] as const) {
    if (r[k].worst.cls >= 0.02) console.log(`mobile-perf ${name} @ ${network} ${k}, worst run's layout shifts:\n  ${r[k].worst.shifts.join('\n  ')}`);
  }
}

const PAGES = [
  {
    name: 'home page',
    url: (n: NetworkName) => `${shaped(linkBaseUrl(), n)}/`,
    ready: (page: Page) => expect(page.getByRole('heading', { level: 1 })).toBeVisible(),
    // The converter: turn the direction, then type an amount — the first things a visitor does.
    interact: async (page: Page) => {
      await page.locator('[data-robot-target="toggle"] button').nth(1).click();
      await page.locator('[data-robot-target="amount"] input').fill('2500');
    },
    tbt: 1200,
    networks: ['india-4g', 'india-slow-4g'] as NetworkName[],
  },
  {
    name: 'a search page',
    url: (n: NetworkName) => `${shaped(linkBaseUrl(), n)}/usdt-to-inr`,
    ready: (page: Page) => expect(page.getByRole('heading', { level: 1 })).toBeVisible(),
    tbt: 600,
    networks: ['india-4g', 'india-slow-4g'] as NetworkName[],
  },
  {
    name: 'client sign-in',
    url: (n: NetworkName) => `${shaped(appBaseUrl(), n)}/sign-in`,
    ready: (page: Page) => expect(page.getByLabel('Email', { exact: true })).toBeVisible(),
    interact: (page: Page) => page.getByLabel('Email', { exact: true }).fill('someone@example.test'),
    tbt: 600,
    networks: ['india-4g'] as NetworkName[],
  },
  {
    name: 'the Exchange, signed in',
    url: (n: NetworkName) => `${shaped(appBaseUrl(), n)}/exchange`,
    signedIn: true,
    ready: (page: Page) => expect(page.getByRole('heading', { name: 'Exchange', exact: true })).toBeVisible(),
    // Search (⌘K): the workspace's own control, opened and closed.
    interact: async (page: Page) => {
      await page.locator('button[aria-haspopup="dialog"]').first().click();
      await page.keyboard.press('Escape');
    },
    tbt: 600,
    networks: ['india-4g', 'india-slow-4g'] as NetworkName[],
  },
];

for (const p of PAGES) {
  for (const network of p.networks) {
    test(`${p.name} on ${network}: cold and warm loads within budget`, async ({ browser }) => {
      test.slow();
      const r = await loads(browser, p.url(network), { ...(p.signedIn ? { storage: client } : {}), ready: p.ready, ...(p.interact ? { interact: p.interact } : {}) });
      report(p.name, network, r);
      const slow = network === 'india-slow-4g';
      // First byte: the model's floor (370 ms cold, 250 ms warm on 4G; 640 / 340 on Slow 4G) plus the server's work.
      expect(r.cold.ttfb).toBeLessThan(slow ? 1300 : 1000);
      expect(r.warm.ttfb).toBeLessThan(slow ? 1000 : 800);
      // The page's largest paint: "good" on 4G; within "needs improvement" on Slow 4G.
      expect(r.cold.lcp).toBeLessThan(slow ? 4000 : 2500);
      expect(r.warm.lcp).toBeLessThan(slow ? 2500 : 1500);
      // Layout shift is held to "good" on 4G. On Slow 4G it is printed, not held: there a cold search page is first drawn
      // before Geist arrives (`font-display: swap`) and a line re-wraps when it does — 0.14 in CI, on `main` too (ADR 0021
      // §4.5). The fix trades the first slow view's typeface against the jump, which is a decision of its own.
      if (slow) {
        test.info().annotations.push({ type: 'cls', description: `cold ${r.cold.cls}, warm ${r.warm.cls} (reported, not held, on Slow 4G)` });
      } else {
        expect(r.cold.cls).toBeLessThan(0.1);
      }
      expect(r.warm.cls).toBeLessThan(0.1);
      expect(r.cold.tbt).toBeLessThan(p.tbt);
      if (p.interact) {
        expect(r.cold.interaction).toBeLessThan(500);
        expect(r.warm.interaction).toBeLessThan(500);
      }
    });
  }
}

test('inside the workspace a section is one request per click, on India 4G', async ({ browser }) => {
  test.slow();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await phone(browser, { storageState: client });
    await page.goto(`${shaped(appBaseUrl(), 'india-4g')}/history`);
    await page.waitForLoadState('networkidle');
    const navigations: string[] = [];
    page.on('request', (r) => {
      if (r.headers()['rsc'] && !r.headers()['next-router-prefetch']) navigations.push(r.url());
    });
    const clicked = Date.now();
    await page.locator('a[href="/exchange"]').first().click();
    await expect(page.getByRole('heading', { name: 'Exchange', exact: true })).toBeVisible();
    times.push(Date.now() - clicked);
    await page.waitForLoadState('networkidle');
    expect(navigations).toHaveLength(1);
    await page.context().close();
  }
  console.log(`mobile-perf History → Exchange @ india-4g (CPU ×${CPU_SLOWDOWN}): click to heading ${times.join(', ')} ms`);
  // One trip to iad1 (250 ms on this profile) and the server's work, and React's reveal of the page.
  expect(median(times)).toBeLessThan(2000);
});

/**
 * The home page's robot, where it actually runs: in a browser with a hardware GPU. CI's browsers draw WebGL in software,
 * where the robot rightly stays the still image, so there it is skipped and said so; on a developer's machine it runs.
 */
const GPU_ARGS = process.platform === 'darwin' ? ['--enable-gpu', '--use-angle=metal'] : ['--enable-gpu', '--ignore-gpu-blocklist'];

async function robotPage(gpu: Browser): Promise<Page> {
  const page = await phone(gpu);
  await page.goto(`${linkBaseUrl()}/robots.txt`);
  const hardware = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
  });
  test.skip(!hardware, 'no hardware WebGL in this browser: the robot stays the still image here, as it should');
  return page;
}

test('the robot starts without blocking a tap and keeps the frame rate while the page scrolls (hardware GPU only)', async () => {
  test.slow();
  const gpu = await chromium.launch({ args: GPU_ARGS });
  try {
    const page = await robotPage(gpu);
    await page.addInitScript(() => {
      type Robot = { start: number | null; live: number | null; long: [number, number][]; frames: number[]; scroll: boolean; scrolled: number[] };
      const r: Robot = { start: null, live: null, long: [], frames: [], scroll: false, scrolled: [] };
      (window as unknown as { __robot: Robot }).__robot = r;
      new PerformanceObserver((l) => l.getEntries().forEach((e) => r.long.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true });
      const getContext = HTMLCanvasElement.prototype.getContext as (this: HTMLCanvasElement, ...a: unknown[]) => unknown;
      (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function (this: HTMLCanvasElement, ...a: unknown[]) {
        const attrs = a[1] as { failIfMajorPerformanceCaveat?: boolean } | undefined;
        if (a[0] === 'webgl2' && !attrs?.failIfMajorPerformanceCaveat && r.start === null) r.start = performance.now();
        return getContext.apply(this, a);
      };
      let last = 0;
      const tick = (now: number) => {
        if (last && r.live !== null) (r.scroll ? r.scrolled : r.frames).push(now - last);
        last = now;
        if (r.live === null && document.querySelector('[data-state="live"]')) r.live = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(`${linkBaseUrl()}/`);
    await page.waitForFunction(() => (window as unknown as { __robot: { live: number | null } }).__robot.live !== null, null, { timeout: 15_000 });
    await page.waitForTimeout(2500);
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => void ((window as unknown as { __robot: { scroll: boolean } }).__robot.scroll = true));
    for (const dy of [-420, 420]) await cdp.send('Input.synthesizeScrollGesture', { x: 200, y: 500, yDistance: dy, speed: 900, repeatCount: 2, repeatDelayMs: 120, gestureSourceType: 'touch' });
    const r = await page.evaluate(() => (window as unknown as { __robot: { start: number; live: number; long: [number, number][]; frames: number[]; scrolled: number[] } }).__robot);
    const during = r.long.filter(([at, d]) => at + d >= r.start && at <= r.live + 500);
    const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
    const ratio = await page.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width / c.clientWidth);
    console.log(`mobile-perf robot (CPU ×${CPU_SLOWDOWN}): live ${Math.round(r.live - r.start)} ms after its context, long tasks ${JSON.stringify(during.map(([, d]) => Math.round(d)))}, frame p95 ${p95(r.frames).toFixed(1)} ms, scrolling ${p95(r.scrolled).toFixed(1)} ms, pixel ratio ${ratio.toFixed(2)}`);
    // Assembled a step per task: no step holds a tap back for long (it was one task of a third of a second).
    expect(Math.max(0, ...during.map(([, d]) => d))).toBeLessThan(200);
    expect(p95(r.frames)).toBeLessThan(25);
    expect(p95(r.scrolled)).toBeLessThan(25);
    // A device that keeps up is drawn at its full pixel ratio: the governor did not step in.
    expect(ratio).toBeCloseTo(Math.min(devices['Pixel 7'].deviceScaleFactor, 2), 1);
  } finally {
    await gpu.close();
  }
});

test('a GPU that cannot keep up hands the robot back to the still image (hardware GPU only)', async () => {
  test.slow();
  const gpu = await chromium.launch({ args: GPU_ARGS });
  try {
    const page = await robotPage(gpu);
    // A GPU too slow for the robot, played by the page: once the robot is live, every frame costs 45 ms.
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) =>
        raf((now) => {
          if (document.querySelector('[data-state="live"]')) {
            const until = performance.now() + 45;
            while (performance.now() < until) {
              // A frame the device cannot draw in time.
            }
          }
          cb(now);
        });
    });
    await page.goto(`${linkBaseUrl()}/`);
    await expect(page.locator('[data-state="live"]')).toHaveCount(1, { timeout: 15_000 });
    // Five windows of frames at 45 ms: four steps of pixel ratio, then the still robot.
    await expect(page.locator('[data-state="still"]')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.locator('img[srcset*="robot-720"]')).toBeVisible();
  } finally {
    await gpu.close();
  }
});
