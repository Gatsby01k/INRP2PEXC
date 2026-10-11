import { expect, test } from '@playwright/test';
import { appDb, deskAddsBankAccount, expireStepUp, signIn, state, stepUp } from './support.ts';

/**
 * D-18: the desk retires one of a client's bank accounts — the way production's two test accounts are retired, since a
 * trader-only client cannot reach its own Destinations page. A reason and the authenticator; afterwards the account is
 * gone from the list, archived, and on the record under the person who did it. Nothing in this is decrypted.
 */
test('the desk archives a client bank account with a reason and its authenticator', async ({ page }) => {
  const s = state();
  const accountId = await deskAddsBankAccount('000405009876');
  await signIn(page, s.owner);
  await page.goto(`/clients/${s.clientId}`);

  const row = page.locator('dd').filter({ hasText: '••••9876' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Archive' }).click();
  const archive = page.getByRole('button', { name: /Archive this account/ });
  await expect(archive).toBeDisabled(); // no reason yet
  await page.getByLabel('Why ••••9876 is archived').fill('Random test details, never a real account (D-18)');
  await expireStepUp();
  await archive.click();
  await stepUp(page, s.owner);

  await expect(page.locator('dd').filter({ hasText: '••••9876' })).toHaveCount(0);
  await expect(page.locator('dd').filter({ hasText: 'HDFC Bank' }).first()).toBeVisible(); // the client's other account stays

  const db = appDb();
  expect((await db.selectFrom('bank_account').select('status').where('id', '=', accountId).executeTakeFirstOrThrow()).status).toBe('ARCHIVED');
  const owner = await db.selectFrom('auth_user').select('id').where('email', '=', s.owner.email).executeTakeFirstOrThrow();
  const trail = await db.selectFrom('audit_event').select(['action', 'actor_id', 'after']).where('entity_id', '=', accountId).orderBy('seq').execute();
  expect(trail.map((a) => a.action)).toEqual(['client_bank.added', 'client_bank.archived']);
  expect(trail[1]!.actor_id).toBe(owner.id);
  expect(JSON.stringify(trail[1]!.after)).toContain('Random test details');
  expect(JSON.stringify(trail)).not.toContain('000405009876');
});
