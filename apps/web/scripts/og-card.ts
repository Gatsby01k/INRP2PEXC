import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { HERO, SITE_NAME, TAGLINE } from '../src/content/site.ts';

/**
 * Renders the public site's share card: what a link to any public page shows when it is pasted into a messenger
 * or a feed.
 *
 *   pnpm --filter @inrp2p/web og:card
 *
 * It is the hero, reduced to a card — the supplied mark, the headline and the tagline in their own words
 * (content/site.ts, under the copy guard), and the robot's still image — so a preview never says anything the
 * page does not. Nothing in it is a figure. Re-run it after a change to any of those, and commit the image.
 *
 * Rendered by Chromium from the bundled Geist faces at the size the Open Graph protocol asks for, and written as
 * a JPEG: a card is a photograph of the robot more than it is type, and a messenger downloads it on mobile data.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(APP, '../..');
const OUT = path.join(APP, 'src/app/(public)/_landing/og/card.jpg');
const WIDTH = 1200;
const HEIGHT = 630;

const dataUrl = (file: string, type: string): string => `data:${type};base64,${readFileSync(file).toString('base64')}`;
const FONTS = path.join(REPO, 'packages/ui/fonts');
const face = (weight: number, file: string) =>
  `@font-face{font-family:Geist;font-weight:${weight};src:url(${dataUrl(path.join(FONTS, file), 'font/woff2')}) format('woff2')}`;
const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

const html = `<!doctype html>
<html>
<head>
<style>
  ${face(400, 'Geist-Regular.woff2')}
  ${face(500, 'Geist-Medium.woff2')}
  ${face(600, 'Geist-SemiBold.woff2')}
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative;
    font-family: Geist, sans-serif; color: #121317;
    background:
      radial-gradient(ellipse 34% 70% at 78% 42%, rgb(255 255 255 / 0.95), transparent 100%),
      #F7F5F0;
  }
  .copy { position: absolute; left: 72px; top: 64px; bottom: 64px; width: 660px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
  .brand img { width: 44px; height: 44px; border-radius: 50%; }
  .eyebrow { margin: auto 0 22px; font-size: 15px; font-weight: 500; letter-spacing: 0.16em; text-transform: uppercase; color: #C8401A; }
  h1 { margin: 0; font-size: 86px; font-weight: 600; line-height: 1.0; letter-spacing: -0.045em; }
  h1 > span { display: block; white-space: nowrap; }
  .accent { color: #F04E23; }
  .tagline { margin: 30px 0 0; padding-top: 26px; border-top: 1px solid #E8E4DC; font-size: 26px; line-height: 1.35; color: #656A73; letter-spacing: -0.01em; }
  .robot { position: absolute; right: -2px; bottom: 6px; width: 520px; height: 520px; }
  .rule { position: absolute; left: 0; right: 0; bottom: 0; height: 10px; background: #0e1522; }
</style>
</head>
<body>
  <div class="copy">
    <div class="brand"><img src="${dataUrl(path.join(REPO, 'brand/inrp2p-mark.png'), 'image/png')}" alt="">${escape(SITE_NAME)}</div>
    <p class="eyebrow">${escape(HERO.eyebrow)}</p>
    <h1><span>${escape(HERO.headline.lead)}</span><span><span class="accent">${escape(HERO.headline.accent)}</span> ${escape(HERO.headline.tail)}</span></h1>
    <p class="tagline">${escape(TAGLINE)}</p>
  </div>
  <img class="robot" src="${dataUrl(path.join(APP, 'src/app/(public)/_landing/robot/poster/robot-1080.webp'), 'image/webp')}" alt="">
  <div class="rule"></div>
</body>
</html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const bytes = await page.screenshot({ type: 'jpeg', quality: 88 });
  writeFileSync(OUT, bytes);
  console.log(`${path.relative(REPO, OUT)}  ${WIDTH}x${HEIGHT}  ${Math.round(bytes.length / 1024)} KB`);
} finally {
  await browser.close();
}
