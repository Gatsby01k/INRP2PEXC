import { readFileSync } from 'node:fs';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { sql } from 'kysely';
import { type Db, createDb, createPool } from '@inrp2p/db';
import { FROZEN_IST_DAY, FROZEN_NOW, STATE_FILE, type VisualState } from './world.ts';

export const state = (): VisualState => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as VisualState;

let db: Db | undefined;
export function fixtureDb(): Db {
  if (!db) db = createDb(createPool({ connectionString: state().databaseUrl, applicationName: 'inrp2p-visual-harness' }));
  return db;
}

const FONT_FACES = ["400 15px 'Geist'", "500 15px 'Geist'", "600 15px 'Geist'", "400 15px 'Geist Mono'", "500 15px 'Geist Mono'"];

/** The browser's clock, matching the frozen business clock so anything counted down in the page agrees with it. */
export const FIXED_TIME = new Date(FROZEN_NOW);

/** Ages every step-up verification past its window, so a ⧗ action raises the dialog the capture needs. */
export async function expireStepUp(): Promise<void> {
  await fixtureDb()
    .updateTable('step_up_verification')
    .set({ verified_at: new Date(Date.now() - 3_600_000) })
    .execute();
}

/**
 * The one piece of text the frozen business clock does not reach.
 *
 * The settlement day is a **wall-clock** concept by design (`istToday` reads `statement_timestamp()`, so a desk
 * cannot pay out of yesterday's capacity by freezing a clock). The fixture therefore prints the day the baseline
 * happened to be captured on, which would make every run after midnight a diff. Rewriting only this — an exact
 * `YYYY-MM-DD IST` — keeps every other pixel under comparison.
 */
async function pinWallClockText(page: Page): Promise<void> {
  await page.evaluate((day) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const pattern = /^\s*\d{4}-\d{2}-\d{2} IST\s*$/;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue && pattern.test(node.nodeValue)) node.nodeValue = `${day} IST`;
    }
  }, FROZEN_IST_DAY);
}

/** Fonts requested and loaded, layout settled, wall-clock text pinned: everything a stable capture needs. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async (faces) => {
    await Promise.all(faces.map((f) => document.fonts.load(f)));
    await document.fonts.ready;
  }, FONT_FACES);
  await expect
    .poll(() => page.evaluate((faces) => document.fonts.status === 'loaded' && faces.every((f) => document.fonts.check(f)), FONT_FACES))
    .toBe(true);
  await pinWallClockText(page);
  // Two animation frames, so layout has settled after the font swap.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/**
 * Every rendered glyph must come from the bundled Geist faces. A system-font fallback (a character missing from
 * Geist) renders differently on every machine and makes baselines non-portable.
 */
export async function platformFontsOutsideGeist(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'body *' });
  const offenders = new Set<string>();
  for (const nodeId of nodeIds) {
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    const bad = fonts.filter((f) => !f.isCustomFont || !/^Geist( Mono)?( (Regular|Medium|SemiBold))?$/.test(f.familyName));
    if (bad.length === 0) continue;
    // Naming the text makes the failure actionable: the fix is an SVG for that glyph, never a looser rule.
    const { object } = await cdp.send('DOM.resolveNode', { nodeId });
    let sample = '';
    if (object.objectId) {
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function () { return (this.textContent || "").trim().slice(0, 40); }',
        returnByValue: true,
      });
      sample = String(result.value ?? '');
    }
    for (const f of bad) offenders.add(`${f.familyName}${f.isCustomFont ? '' : ' (system font)'} — "${sample}"`);
  }
  await cdp.detach();
  return [...offenders];
}

/**
 * Captures one operator state. The name is annotated so the update reporter can drop baselines for captures that
 * no longer exist, the same way the component suite drops baselines for deleted stories.
 */
export async function capture(page: Page, name: string, target?: Locator): Promise<void> {
  test.info().annotations.push({ type: 'capture', description: name });
  await settle(page);
  expect(await platformFontsOutsideGeist(page), 'text rendered with a non-bundled fallback font').toEqual([]);
  if (target) await expect(target).toHaveScreenshot(`${name}.png`);
  else await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
}

/** Opens a desk panel the way the queue does: by naming the row and the section on the desk's own URL. */
export async function openPanel(page: Page, rowId: string, section: string): Promise<void> {
  await page.goto(`/?row=${encodeURIComponent(rowId)}&do=${section}`);
}

export async function closeFixtureDb(): Promise<void> {
  if (db) await db.destroy();
  db = undefined;
}

export { sql };
