import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { HERO, SITE_NAME, SITE_PAGES, TAGLINE, TRADER_TERMS, type SitePage, withTerms } from '../src/content/site.ts';
import { TRADERS_PAGE } from '../src/content/traders.ts';
import { onRows, strip } from '../src/app/(public)/_landing/led/font.ts';

/**
 * Renders the public site's share cards: what a link to each public page shows when it is pasted into WhatsApp,
 * Telegram or a feed — one card per page, written beside the page's own metadata (`(public)/metadata.ts`).
 *
 *   pnpm --filter @inrp2p/web og:card
 *
 * Each card is the page reduced to a picture in the site's own room: the mark and name, the page's headline and lede
 * in their own words (content/site.ts, under the copy guard), the robot on its sun saying the page's word on its visor
 * in its LEDs, and the tagline along the foot. Nothing in it is a figure. Re-run it after a change to any
 * of those, and commit the images.
 *
 * Rendered by Chromium from the bundled faces at the size the Open Graph protocol asks for, and written as JPEG: a
 * messenger downloads it on mobile data.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(APP, '../..');
const OG = path.join(APP, 'src/app/(public)/_landing/og');
const WIDTH = 1200;
const HEIGHT = 630;

const dataUrl = (file: string, type: string): string => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const FONTS = path.join(REPO, 'packages/ui/fonts');
const font = (family: string, weight: string, file: string) =>
  `@font-face{font-family:'${family}';font-weight:${weight};src:url(${dataUrl(path.join(FONTS, file), 'font/woff2')}) format('woff2')}`;
const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

/** Words as LEDs: one SVG of dots, lit ones in the robot's orange with their glow, dark ones as faint embers. */
function leds(text: string, rows: number, cols: number, pitch: number): string {
  const bitmap = onRows(strip(text), rows);
  const width = bitmap[0]!.length;
  const left = Math.floor((cols - width) / 2);
  let dots = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const on = bitmap[y]?.[x - left] === '#';
      const cx = (x + 0.5) * pitch;
      const cy = (y + 0.5) * pitch;
      dots += on
        ? `<circle cx="${cx}" cy="${cy}" r="${pitch * 0.36}" fill="#ff8a5c" filter="url(#glow)"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${pitch * 0.2}" fill="rgba(255,255,255,0.07)"/>`;
    }
  }
  return `<svg width="${cols * pitch}" height="${rows * pitch}" viewBox="0 0 ${cols * pitch} ${rows * pitch}">
    <defs><filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${pitch * 0.35}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    ${dots}</svg>`;
}

/** What a card says: a page of the site, or the trader page (`inrp2p.com/traders`, ADR 0031). */
interface CardWords {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede: string;
  readonly say: string;
  readonly foot: string;
  readonly size: number;
}

function siteWords(page: SitePage): CardWords {
  const home = page.path === '/';
  return {
    eyebrow: HERO.eyebrow,
    title: home
      ? `<span>${escape(HERO.headline.lead)}</span><span><span class="accent">${escape(HERO.headline.accent)}</span> ${escape(HERO.headline.tail)}</span>`
      : `<span>${escape(withTerms(page.h1))}</span>`,
    lede: home ? HERO.lede.split('. ')[0]! + '.' : withTerms(page.lede),
    say: page.led ?? 'HI!',
    foot: TAGLINE,
    size: home ? 84 : withTerms(page.h1).length > 24 ? 64 : 88,
  };
}

/** The trader page's card: the page's headline, the programme's terms, the robot wearing the typical margin. */
function traderWords(): CardWords {
  const { hero } = TRADERS_PAGE;
  return {
    eyebrow: hero.eyebrow,
    title: `<span>${escape(hero.title.lead)}</span><span class="accent second">${escape(hero.title.accent)}</span>`,
    lede: withTerms(TRADERS_PAGE.meta.card),
    say: `+${TRADER_TERMS.margin.typical}%`,
    foot: `inrp2p.com/traders · ${TRADERS_PAGE.sticky.note}`,
    size: 76,
  };
}

function card(words: CardWords): string {
  const { say, title } = words;
  const word = strip(say)[0]!.length;
  // A short word sits still in the middle of the visor; a longer one is shown from its start, as it begins to run.
  const visor = leds(word > 24 ? `${say}` : say, 14, Math.max(26, word + 2), 9);
  return `<!doctype html><html><head><style>
  ${font('Geist', '400', 'Geist-Regular.woff2')}
  ${font('Geist', '600', 'Geist-SemiBold.woff2')}
  ${font('Geist Mono', '500', 'GeistMono-Medium.woff2')}
  ${font('Sora', '100 800', 'Sora-Variable-Latin.woff2')}
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative;
    font-family: Geist, sans-serif; color: #121317;
    background:
      radial-gradient(640px 420px at 92% -8%, rgb(255 116 58 / 0.42), transparent 70%),
      radial-gradient(560px 360px at 64% -14%, rgb(255 184 116 / 0.4), transparent 70%),
      radial-gradient(760px 420px at 12% -20%, rgb(255 222 192 / 0.7), transparent 72%),
      linear-gradient(180deg, #fff 0, #faf8f5 520px);
  }
  .copy { position: absolute; left: 64px; top: 52px; width: 640px; bottom: 110px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 14px; font-family: Sora; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
  .brand img { width: 46px; height: 46px; border-radius: 50%; box-shadow: 0 6px 14px -6px rgb(240 78 35 / 0.7); }
  .eyebrow { margin: auto 0 18px; font-family: 'Geist Mono'; font-size: 15px; letter-spacing: 0.16em; text-transform: uppercase; color: #C8401A; }
  h1 { margin: 0; font-family: Sora; font-size: ${words.size}px; font-weight: 600; line-height: 0.98; letter-spacing: -0.05em; }
  h1 > span { display: block; }
  .accent { color: #F04E23; }
  .second { margin-top: 14px; font-size: 0.6em; letter-spacing: -0.04em; }
  .lede { margin: 22px 0 0; font-size: 24px; line-height: 1.35; color: #3c4048; letter-spacing: -0.01em; max-width: 30ch; }
  .stage { position: absolute; right: 20px; bottom: 0; width: 520px; height: 520px; }
  .sun { position: absolute; left: 50%; top: -4%; width: 92%; aspect-ratio: 1; transform: translateX(-50%); border-radius: 50%;
    background: radial-gradient(circle at 34% 28%, #f7835d 0%, transparent 46%), radial-gradient(circle, #F04E23 0%, #F04E23 52%, #C8401A 100%);
    box-shadow: 0 40px 90px -30px rgb(240 78 35 / 0.7); }
  .robot { position: absolute; inset: 0; width: 100%; height: 100%; }
  .visor { position: absolute; top: 20.4%; left: 25.1%; width: 49.8%; height: 38.4%; border-radius: 21% / 27%; overflow: hidden;
    background: radial-gradient(130% 110% at 30% -10%, #26282f 0, #111215 45%, #050506 100%); display: grid; place-items: center; }
  .visor svg { width: 88%; height: auto; }
  .visor::after { content: ''; position: absolute; top: 6%; right: 9%; width: 26%; height: 16%; border-radius: 50%; background: radial-gradient(closest-side, rgb(255 255 255 / 0.5), transparent); }
  .foot { position: absolute; left: 64px; bottom: 40px; margin: 0; padding-top: 18px; width: 560px; border-top: 1px solid rgb(18 19 23 / 0.1);
    font-family: 'Geist Mono'; font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b6f77; }
</style></head><body>
  <div class="copy">
    <div class="brand"><img src="${dataUrl(path.join(REPO, 'brand/inrp2p-mark.png'), 'image/png')}" alt="">${escape(SITE_NAME)}</div>
    <p class="eyebrow">${escape(words.eyebrow)}</p>
    <h1>${title}</h1>
    <p class="lede">${escape(words.lede)}</p>
  </div>
  <div class="stage">
    <span class="sun"></span>
    <img class="robot" src="${dataUrl(path.join(APP, 'src/app/(client)/_assistant/stills/robot-none.webp'), 'image/webp')}" alt="">
    <span class="visor">${visor}</span>
  </div>
  <p class="foot">${escape(words.foot)}</p>
</body></html>`;
}

/** Where a page's card is written: the home page's is `card.jpg`, a guide's is named for its path. */
export const cardFile = (p: SitePage): string => (p.path === '/' ? 'card.jpg' : `card-${p.path.slice(1)}.jpg`);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  // `--only=traders` (or a guide's path) draws one card and leaves the others as they are.
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null;
  const cards: { file: string; words: CardWords; key: string }[] = [
    ...SITE_PAGES.map((p) => ({ file: cardFile(p), words: siteWords(p), key: p.path === '/' ? 'home' : p.path.slice(1) })),
    { file: 'card-traders.jpg', words: traderWords(), key: 'traders' },
  ];
  for (const site of cards.filter((c) => only === null || c.key === only)) {
    await page.setContent(card(site.words), { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const bytes = await page.screenshot({ type: 'jpeg', quality: 86 });
    const out = path.join(OG, site.file);
    writeFileSync(out, bytes);
    console.log(`${path.relative(REPO, out)}  ${WIDTH}x${HEIGHT}  ${Math.round(bytes.length / 1024)} KB`);
  }
} finally {
  await browser.close();
}
