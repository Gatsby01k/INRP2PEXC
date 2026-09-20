import { expect, test } from '@playwright/test';
import { sql } from 'kysely';
import {
  acceptAsClient,
  appDb,
  clientSendsUsdt,
  deliverNotifications,
  deskPaysOut,
  deskSendsQuoteWithLink,
  expireStepUp,
  signIn,
  state,
  stepUp,
  tradeState,
} from './support.ts';

/**
 * Phase 8 end to end: the finance outputs an operator and a client actually leave with.
 *
 * One trade is settled through the real commands, and then everything this phase added is used the way it will
 * be used — the P&L is read and checked against the ledger, the exports are downloaded, the receipt is fetched
 * twice and compared byte for byte, and a bank statement is imported through the INR screen. The last one is the
 * only control in this system that can tell the difference between a payment we recorded and a payment the bank
 * actually made, so it is worth driving through the product rather than only through its command.
 *
 * It is one signed-in session with four steps rather than four tests: signing in four times would prove nothing
 * the first sign-in has not already proved, and the desk's own sign-in throttle would rightly start refusing.
 */
test('the finance outputs of a settled trade', async ({ page }) => {
  test.slow();
  const s = state();
  await signIn(page, s.owner);

  let tradeRef = '';
  let day = '';

  await test.step('a settled trade produces a P&L the ledger agrees with', async () => {
    const quote = await deskSendsQuoteWithLink({ amount: '10000', clientRate: '102.000000' });
    const trade = await acceptAsClient(quote.quoteId);
    tradeRef = trade.tradeRef;
    await clientSendsUsdt(trade.tradeId, '10000');
    await deskPaysOut(trade.tradeId, '1020000.00');
    expect(await tradeState(trade.tradeId)).toBe('COMPLETED');
    // The receipt is issued by the worker, from the event completion enqueued — not by the page that shows it.
    await deliverNotifications();

    const today = await sql<{ day: string }>`select to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day`.execute(appDb());
    day = today.rows[0]!.day;

    await page.goto('/pnl');
    await expect(page.getByRole('heading', { name: 'P&L' })).toBeVisible();
    await expect(page.getByTestId('ledger-check')).toContainText('Ledger and trades agree on realized margin');
    await expect(
      page
        .getByRole('table', { name: /Trades/ })
        .or(page.getByRole('table'))
        .first(),
    ).toContainText(tradeRef);
  });

  await test.step('finance exports download as CSV, with the hash the audit trail recorded', async () => {
    for (const kind of ['trades', 'ledger', 'receipts'] as const) {
      const res = await page.request.get(`/api/exports/${kind}?from=${day}&to=${day}`);
      expect(res.status(), `${kind} export`).toBe(200);
      expect(res.headers()['content-type']).toContain('text/csv');
      expect(res.headers()['content-disposition']).toContain(`${kind}-${day}`);
      expect(res.headers()['x-inrp2p-sha256']).toMatch(/^[0-9a-f]{64}$/);
      const body = await res.text();
      // CRLF and a header row: the file is read by a spreadsheet, not by us.
      expect(body).toContain('\r\n');
      expect(body.split('\r\n')[0]).toBeTruthy();
    }

    // A period is required. "Everything" is not a period, and a finance file nobody can bound reconciles nothing.
    expect((await page.request.get('/api/exports/trades')).status()).toBe(400);
    expect((await page.request.get(`/api/exports/nonsense?from=${day}&to=${day}`)).status()).toBe(404);

    const audits = await appDb().selectFrom('audit_event').select('id').where('action', '=', 'export.generated').execute();
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  await test.step('the receipt is the same document every time it is asked for', async () => {
    const first = await page.request.get(`/api/receipts/${tradeRef}?format=json`);
    expect(first.status()).toBe(200);
    const hash = first.headers()['x-inrp2p-sha256'];
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const again = await page.request.get(`/api/receipts/${tradeRef}?format=json`);
    expect(again.headers()['x-inrp2p-sha256']).toBe(hash);
    expect(await again.text()).toBe(await first.text());

    const csv = await page.request.get(`/api/receipts/${tradeRef}?format=csv`);
    expect(csv.headers()['content-disposition']).toContain(`receipt-${tradeRef}.csv`);

    // The printable document, which is what a client without a PDF renderer still gets.
    const html = await page.request.get(`/api/receipts/${tradeRef}`);
    expect(html.headers()['content-type']).toContain('text/html');
    const document = await html.text();
    expect(document).toContain('Settlement receipt');
    // Nothing about the route, the desk's margin or who remitted: a receipt is a client document (SECURITY §5,
    // S14). Read from the document's body, since the print stylesheet legitimately sets CSS margins.
    const visible = document.slice(document.indexOf('<body'));
    expect(visible).not.toMatch(/margin|route|provider|custody|dealer/i);

    // This harness has no browser to print with, and says so rather than serving something that is not a PDF.
    const pdf = await page.request.get(`/api/receipts/${tradeRef}?format=pdf`);
    expect(pdf.status()).toBe(503);
    expect(await pdf.json()).toMatchObject({ error: 'PDF_RENDERER_NOT_CONFIGURED' });

    expect((await page.request.get('/api/receipts/IX-000000-0000')).status()).toBe(404);
    expect((await page.request.get(`/api/receipts/${tradeRef}?format=exe`)).status()).toBe(400);
  });

  await test.step('a bank statement is imported through the INR screen and reconciles', async () => {
    const confirmed = await sql<{ utr: string; amount: string }>`
    select distinct f.utr, (f.amount_minor / 100.0)::numeric(20,2)::text as amount
    from fiat_transfer f
    join transfer_allocation a on a.fiat_transfer_id = f.id and a.voided_at is null
    join settlement_leg l on l.id = a.settlement_leg_id
    where f.status = 'CONFIRMED' and l.inr_account_id = ${s.inrAccountId}
    order by f.utr`.execute(appDb());
    expect(confirmed.rows.length).toBeGreaterThan(0);

    // Every payment the desk confirmed, plus one line that is the bank's own charge. The charge is not ours and
    // does not open a case; a real statement is full of them and burying the real cases is the failure mode.
    const lines = [
      'value_date,direction,amount,reference,description',
      ...confirmed.rows.map((r) => `${day},DEBIT,${r.amount},${r.utr},NEFT OUTWARD`),
      `${day},DEBIT,236.00,BANKCHG${day.replace(/-/g, '')},MONTHLY CHARGES`,
    ].join('\r\n');

    await page.goto('/inr');
    const panel = page.getByTestId('statement-import');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Period from').fill(day);
    await panel.getByLabel('Period to').fill(day);
    await panel
      .getByLabel('Statement file (CSV)')
      .setInputFiles({ name: 'hdfc-statement.csv', mimeType: 'text/csv', buffer: Buffer.from(lines, 'utf8') });

    await expireStepUp();
    await panel.getByRole('button', { name: /Import statement/ }).click();
    await stepUp(page, s.owner);

    const outcome = page.getByTestId('statement-outcome');
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText(`${confirmed.rows.length} matched`);
    await expect(outcome).toContainText('1 not ours');
    await expect(outcome).toContainText('0 confirmed payments the statement does not show');
    await expect(outcome).toContainText('No case opened');

    // The same file is the same evidence, not new evidence. No second prompt: the verification just given is
    // still inside its window, which is the rule the desk applies to every ⧗ action.
    await panel
      .getByLabel('Statement file (CSV)')
      .setInputFiles({ name: 'hdfc-statement.csv', mimeType: 'text/csv', buffer: Buffer.from(lines, 'utf8') });
    await panel.getByRole('button', { name: /Import statement/ }).click();
    await expect(panel.getByRole('alert')).toContainText('already been imported');

    // And the import itself is on the record, by its hash rather than its contents.
    const audit = await appDb().selectFrom('audit_event').select('id').where('action', '=', 'statement.imported').execute();
    expect(audit).toHaveLength(1);
  });
});
