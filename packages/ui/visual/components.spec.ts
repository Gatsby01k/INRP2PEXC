import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { loadStories, viewportFor } from './stories.ts';

const stories = loadStories();

/** Fixture clock (src/fixtures.ts NOW): countdowns and "time ago" text render the same on every run. */
const FIXED_TIME = new Date('2026-09-16T10:41:00.000Z');
const FONT_FACES = ["400 15px 'Geist'", "500 15px 'Geist'", "600 15px 'Geist'", "400 15px 'Geist Mono'", "500 15px 'Geist Mono'"];

async function openStory(page: Page, id: string, reducedMotion: 'reduce' | 'no-preference') {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.emulateMedia({ reducedMotion, colorScheme: 'light' });
  // a11y.manual stops the Storybook a11y addon from running its own axe pass concurrently.
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=a11y.manual:!true`);
  const root = page.locator('#storybook-root');
  await expect(root).not.toBeEmpty();
  // Fonts load lazily per weight: request every face, then wait for document.fonts.ready.
  await page.evaluate(async (faces) => {
    await Promise.all(faces.map((f) => document.fonts.load(f)));
    await document.fonts.ready;
  }, FONT_FACES);
  await expect.poll(() => page.evaluate((faces) => document.fonts.status === 'loaded' && faces.every((f) => document.fonts.check(f)), FONT_FACES)).toBe(true);
  // Let layout settle after font swap: two animation frames.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  return page.getByTestId('story-surface');
}

/**
 * Every rendered glyph must come from the bundled Geist faces. A system-font fallback (a character
 * missing from Geist) renders differently on every machine and makes baselines non-portable.
 */
async function platformFontsOutsideGeist(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '#storybook-root *' });
  const offenders = new Set<string>();
  for (const nodeId of nodeIds) {
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    for (const f of fonts) if (!f.isCustomFont || !/^Geist( Mono)?( (Regular|Medium|SemiBold))?$/.test(f.familyName)) offenders.add(`${f.familyName}${f.isCustomFont ? '' : ' (system font)'}`);
  }
  await cdp.detach();
  return [...offenders];
}

test.describe('every story: accessibility (axe, WCAG 2.2 AA) and visual baseline', () => {
  for (const story of stories) {
    test(`${story.title} › ${story.name}`, async ({ page }) => {
      await page.setViewportSize(viewportFor(story));
      // Baseline = default experience; Playwright freezes CSS animations/transitions for the capture.
      const surface = await openStory(page, story.id, 'no-preference');

      const axe = await new AxeBuilder({ page })
        .include('#storybook-root')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);

      expect(await platformFontsOutsideGeist(page), 'text rendered with a non-bundled fallback font').toEqual([]);

      await expect(surface).toHaveScreenshot(`${story.id}.png`);
    });
  }
});

test.describe('reduced motion variants', () => {
  const motionStories = stories.filter((s) => s.tags.includes('motion'));

  test('motion-bearing stories exist', () => {
    expect(motionStories.length).toBeGreaterThan(0);
  });

  for (const story of motionStories) {
    test(`${story.title} › ${story.name} stops motion when reduced motion is requested`, async ({ page }) => {
      await page.setViewportSize(viewportFor(story));
      await openStory(page, story.id, 'reduce');
      const moving = await page.evaluate(() => {
        const offenders: string[] = [];
        for (const el of Array.from(document.querySelectorAll('#storybook-root *'))) {
          const cs = getComputedStyle(el);
          const anim = cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01 && cs.animationIterationCount === 'infinite';
          const trans = cs.transitionProperty !== 'none' && cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0.01);
          if (anim || trans) offenders.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} anim=${cs.animationName}/${cs.animationDuration} trans=${cs.transitionDuration}`);
        }
        return offenders;
      });
      expect(moving).toEqual([]);
      // UX_FLOWS §4: the quote countdown falls back to text only.
      for (const arc of await page.locator('[data-motion="countdown-arc"]').all()) await expect(arc).toBeHidden();
      await expect(page.getByTestId('story-surface')).toHaveScreenshot(`${story.id}--reduced-motion.png`);
    });

    test(`${story.title} › ${story.name} animates when motion is allowed`, async ({ page }) => {
      await openStory(page, story.id, 'no-preference');
      const animated = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#storybook-root *')).some((el) => {
          const cs = getComputedStyle(el);
          return (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01) || cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0.01);
        }),
      );
      expect(animated).toBe(true);
    });
  }
});
