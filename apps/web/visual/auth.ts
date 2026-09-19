import path from 'node:path';
import { readFile } from 'node:fs/promises';
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

export const CLIENT_AUTH_FILE = path.join(import.meta.dirname, '.auth-client.json');

/**
 * The same, for the client product: the real sign-in form, with the code taken from the run's own sink file.
 * A forged session cookie would skip the one thing this proves — that the product issues the session the client
 * pages are then captured under.
 */
export async function signInClientAndSave(baseURL: string, email: string, sinkFile: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto('/sign-in');
    await page.getByLabel('Work email').fill(email);
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await page.getByLabel('Six-digit code').fill(await codeFromSink(sinkFile, email));
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Exact: the sign-in page's own heading is "INRP2P Exchange", which a substring match would happily accept.
    await expect(page.getByRole('heading', { name: 'Exchange', exact: true })).toBeVisible();
    await context.storageState({ path: CLIENT_AUTH_FILE });
    await context.close();
  } finally {
    await browser.close();
  }
}

async function codeFromSink(sinkFile: string, email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const lines = (await readFile(sinkFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    const last = lines.map((l) => JSON.parse(l) as { email: string; otp: string }).filter((m) => m.email === email).at(-1);
    if (last) return last.otp;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no sign-in code was written for ${email}`);
}
