import { inrView } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { inr, inrCompact } from '../_desk/format.ts';
import { KpiBand, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { InrAccounts } from './InrAccounts.tsx';
import { StatementImport } from './StatementImport.tsx';

export const dynamic = 'force-dynamic';

/**
 * INR accounts (UX_FLOWS §2, brief "INR Accounts"): an operational capacity screen. Today's totals across the active
 * accounts, every account with its capacity used, reserved and free, and the bank statements that check what the
 * desk recorded against what the bank moved.
 */
export default async function InrPage() {
  const ctx = await operatorPage();
  const view = await inrView(ctx.db);
  const active = view.accounts.filter((a) => a.status === 'ACTIVE').length;
  const lastImport = view.statements[0];

  return (
    <Page>
      <PageHeader
        title="INR accounts"
        meta={
          <>
            {/* The day on its own text node: the visual suite pins exactly this wall-clock text before capturing. */}
            <span>{`${view.istDay} IST`}</span> · {active} of {view.accounts.length} accounts active
          </>
        }
      />
      <PageBody>
        <KpiBand
          label="Today across active accounts"
          items={[
            { key: 'a', label: 'Available today', value: inr(view.totals.available), sub: 'what the desk can still pay', size: 'lg' },
            { key: 'c', label: 'Working capacity', value: inrCompact(view.totals.capacity), sub: inr(view.totals.capacity) },
            { key: 'u', label: 'Used', value: inrCompact(view.totals.used), sub: 'payouts sent today' },
            { key: 'r', label: 'Reserved', value: inrCompact(view.totals.reserved), sub: 'legs not yet sent' },
            {
              key: 's',
              label: 'Last reconciliation',
              value: lastImport ? `${lastImport.periodTo}` : 'never',
              sub: lastImport ? `${lastImport.matched} matched · ${lastImport.missing} missing` : 'import a statement below',
              ...(lastImport ? (lastImport.missing > 0 || lastImport.mismatched > 0 ? { tone: 'danger' as const } : {}) : { tone: 'warning' as const }),
            },
          ]}
        />
        <Section title="Settlement accounts" count={view.accounts.length} hint="Capacity is the desk’s promise about what it can pay today. Every change is step-up and carries a reason." flush>
          <InrAccounts accounts={view.accounts} canChange={can(ctx, 'capacity:change')} />
        </Section>
        <Section title="Bank statement reconciliation" hint="What the bank says it moved, against what this desk recorded. A payment we confirmed that the statement does not show opens a blocking case on its trade.">
          <StatementImport accounts={view.accounts} statements={view.statements} canImport={can(ctx, 'statement:import')} />
        </Section>
      </PageBody>
    </Page>
  );
}
