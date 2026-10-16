import { allows, deskNow, networkView } from '@inrp2p/desk';
import { notFound } from 'next/navigation';
import { operatorPage } from '../../../server/operator.ts';
import { age, dateTime } from '../_desk/format.ts';
import { Chip, KpiBand, Notice, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { optionalEnv } from '../../../server/env.ts';
import { trx } from '../_desk/network.ts';
import { DepositForm, FundersTable, RegisterHdWallet, SendsTable, SignerSwitch, TradesNetworkTable, TrxPriceForm, WithdrawalsTable } from './NetworkPanels.tsx';
import d from '../_desk/desk.module.css';

export const dynamic = 'force-dynamic';

/**
 * Network budget (ADR 0017): the TRX the exchange's own signer burns, who prefunded it and what of it is free; what the
 * chain charges and what a TRX is worth now; every USDT and TRX send with its transactions and the actions a person
 * may take on it; and what each trade's transfers really cost against the fee its price carried.
 */
export default async function NetworkPage() {
  const ctx = await operatorPage();
  if (!allows(ctx.actor, 'network:view')) notFound();
  const [view, now] = await Promise.all([networkView(ctx.db), deskNow(ctx.db)]);
  const nowMs = new Date(now).getTime();
  const platform = view.funders.find((f) => f.funder === 'PLATFORM')!;
  const traders = view.funders.filter((f) => f.funder !== 'PLATFORM');
  const sum = (key: 'available' | 'held') => traders.reduce((s, f) => s + BigInt(f[key].replace('.', '').replace('-', '')) * (f[key].startsWith('-') ? -1n : 1n), 0n);
  const fmt = (sun: bigint) => `${sun < 0n ? '-' : ''}${(sun < 0n ? -sun : sun) / 1_000_000n}.${((sun < 0n ? -sun : sun) % 1_000_000n).toString().padStart(6, '0')}`;
  const live = view.sends.filter((s) => !['CONFIRMED', 'CANCELLED'].includes(s.status));
  const waiting = live.filter((s) => s.status === 'AWAITING_APPROVAL').length;
  const blocked = live.filter((s) => s.status === 'BLOCKED').length;
  const feesStale = !view.fees || view.fees.ageSeconds > 3600;
  const priceStale = !view.trxRate || view.trxRate.ageSeconds > 86_400;
  const mismatch = view.budgetWallet?.difference && view.budgetWallet.difference.startsWith('-') && view.budgetWallet.difference !== '-0.000000';

  return (
    <Page>
      <PageHeader
        title="Network budget"
        meta={view.hdAccount ? <>Deal addresses from {view.hdAccount.provider} · budget wallet <span className={d.mono}>{view.hdAccount.feeWallet}</span></> : 'No HD account recorded: deposit addresses are not issued by the exchange’s own wallet yet.'}
        badge={<SignerSwitch on={view.policy.autoSend} canSet={allows(ctx.actor, 'settings:network_fees')} />}
      />
      <PageBody>
        <KpiBand
          label="Network budget"
          items={[
            { key: 't', label: 'Traders’ deposits free', value: trx(fmt(sum('available'))), sub: `${trx(fmt(sum('held')))} held for open trades`, size: 'lg' },
            { key: 'p', label: 'Platform budget free', value: trx(platform.available), sub: 'desk routes and the platform’s own mistakes', ...(platform.available.startsWith('-') ? { tone: 'danger' as const } : {}) },
            { key: 's', label: 'Sends in flight', value: String(live.length), sub: `${waiting} need approval · ${blocked} blocked`, ...(blocked > 0 ? { tone: 'danger' as const } : waiting > 0 ? { tone: 'warning' as const } : {}) },
            {
              key: 'f', label: 'One transfer costs', value: view.fees ? trx(view.fees.perSendQuotedTrx) : '—',
              sub: view.fees ? `priced · ${trx(view.fees.perSendHeldTrx)} held · energy ${view.fees.energyPriceSun} sun` : 'the chain has not been read',
              ...(feesStale ? { tone: 'warning' as const } : {}),
            },
            { key: 'r', label: 'TRX price', value: view.trxRate ? `${view.trxRate.usdtPerTrx} USDT` : '—', sub: view.trxRate ? `${age(view.trxRate.effectiveAt, nowMs)} old · ${view.trxRate.source}` : 'publish one below', ...(priceStale ? { tone: 'warning' as const } : {}) },
          ]}
        />

        {!view.hdAccount && allows(ctx.actor, 'custody:configure') ? (
          <Section title="Register the exchange’s HD wallet" hint="Once, before the first trade on the exchange’s own rails: run scripts/custody-seed.ts new (RUNBOOKS custody-seed), put the sealed seed in the worker’s secret and the account key in the web app’s environment, then register the two addresses it printed.">
            <RegisterHdWallet xpub={optionalEnv('INRP2P_CUSTODY_XPUB') ?? null} />
          </Section>
        ) : null}

        {!view.policy.autoSend ? (
          <Notice tone="danger" icon="lock" role="status">
            <strong>The signer is stopped.</strong> Nothing new is signed; transactions already on chain are still followed to their end. {view.policy.reason}
          </Notice>
        ) : null}
        {feesStale || priceStale ? (
          <Notice tone="warning" icon="exceptions">
            <strong>{!view.fees ? 'The chain’s fees have never been read.' : priceStale ? 'The TRX price is missing or old.' : 'The chain’s fees were read over an hour ago.'}</strong> No quote is sent and no trade accepted while what a transfer costs cannot be stated.
          </Notice>
        ) : null}
        {mismatch ? (
          <Notice tone="danger" icon="exceptions" role="alert">
            <strong>The budget wallet holds {trx(view.budgetWallet!.onChainTrx!)} on chain; the records say {trx(view.budgetWallet!.recordedTrx)}.</strong> Top-ups beyond what the chain shows are refused until this is understood.
          </Notice>
        ) : null}

        <Section title="Sends" count={live.length} hint="Every transfer the signer makes, with its transactions and the TRX it may draw. A send is signed once and its bytes are stored before broadcast; another is signed only after the chain proves the first can never land. A transfer that would draw more TRX than its cap waits for a person." flush>
          <SendsTable sends={view.sends} canApprove={allows(ctx.actor, 'chain_send:approve')} canCancel={allows(ctx.actor, 'chain_send:cancel')} canManage={allows(ctx.actor, 'network:manage')} me={ctx.actor.userId} />
        </Section>

        <Section title="Funders" count={view.funders.length} hint="TRX is prefunded: a trader’s deposit pays the transfers of its orders and is paid back in INR with its rewards when the client paid for them; the platform budget only desk routes and its own mistakes." flush>
          <FundersTable funders={view.funders} />
        </Section>

        <Section title="Trades" hint="What the client’s price carried for the network against what the transfers actually burned, and what each trade leaves after the trader’s reward." flush>
          <TradesNetworkTable trades={view.trades} />
        </Section>

        {view.withdrawals.length > 0 ? (
          <Section title="Withdrawals" count={view.withdrawals.length} flush>
            <WithdrawalsTable withdrawals={view.withdrawals} canDecide={allows(ctx.actor, 'network_withdrawal:decide')} />
          </Section>
        ) : null}

        {allows(ctx.actor, 'network:manage') ? (
          <>
            <Section title="TRX price" hint="What one TRX is worth in USDT. Quotes price the network fee with it; a trader is paid back at the price its trade was quoted with.">
              <TrxPriceForm current={view.trxRate?.usdtPerTrx ?? null} />
            </Section>
            <Section title="Record a TRX deposit" hint={view.budgetWallet ? `A transfer into ${view.budgetWallet.address}. From a trader’s registered wallet it is that trader’s deposit; otherwise only the platform’s own top-up, said explicitly.` : 'No budget wallet is registered.'}>
              <DepositForm />
            </Section>
          </>
        ) : null}

        {view.budgetWallet ? (
          <p className={d.meta}>
            Budget wallet on chain: {view.budgetWallet.onChainTrx ? trx(view.budgetWallet.onChainTrx) : 'not read yet'}
            {view.budgetWallet.observedAt ? ` (${dateTime(view.budgetWallet.observedAt)})` : ''} · records {trx(view.budgetWallet.recordedTrx)} · policy set {dateTime(view.policy.setAt)} <Chip tone="neutral">min net {view.policy.minNetMargin} INR</Chip>
          </p>
        ) : null}
      </PageBody>
    </Page>
  );
}
