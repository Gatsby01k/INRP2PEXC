import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { type VisualState, totpFor } from './world.ts';

export const AUTH_FILE = path.join(import.meta.dirname, '.auth.json');

/**
 * Signs in once for the whole suite and saves the session, because signing in is rate limited on purpose:
 * `/two-factor/verify-totp` allows five attempts per five minutes (SECURITY §2.2), and eleven captures each
 * signing in would trip the desk's own protection. The sign-in itself is the real form — password, then the
 * authenticator code — so the saved session is one the product actually issues.
 */
export async function signInAndSave(baseURL: string, state: VisualState): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto('/sign-in');
    await page.getByLabel('Work email').fill(state.owner.email);
    await page.getByLabel('Password').fill(state.owner.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Authenticator code').fill(await totpFor(state.owner.totpSecret));
    await page.getByRole('button', { name: 'Verify and open the desk' }).click();
    await expect(page.getByRole('heading', { name: 'Desk', exact: true })).toBeVisible();
    await context.storageState({ path: AUTH_FILE });
    await context.close();
  } finally {
    await browser.close();
  }
}
