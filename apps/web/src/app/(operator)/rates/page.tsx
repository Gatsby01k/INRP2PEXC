import { autoPricingView } from '@inrp2p/desk';
import { Money } from '@inrp2p/kernel';
import { peerBookSummary } from '@inrp2p/quotes';
import { can, operatorPage } from '../../../server/operator.ts';
import { Notice, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { AutoPricing } from './AutoPricing.tsx';
import { PeerMatching } from './PeerMatching.tsx';

export const dynamic = 'force-dynamic';

/**
 * Rates (ADR 0025): every P2P deal is priced from its trader's own rate (ADR 0019), so what the desk sets here is how
 * clients are priced automatically — on or off, the market reference it is bounded by, and its guard-rails.
 */
export default async function RatesPage() {
  const ctx = await operatorPage();
  const economics = ctx.access.economics;
  const [auto, peer] = economics ? await Promise.all([autoPricingView(ctx.db), peerBookSummary(ctx.db)]) : [null, null];

  return (
    <Page>
      <PageHeader title="Rates" meta={economics ? 'how clients are priced · traders’ rates are never shown to a client' : 'Rates are hidden for your role'} />
      <PageBody>
        {!economics || !auto ? (
          <Notice icon="lock">Rates are economics. Your role does not include economics:view.</Notice>
        ) : (
          <>
            <Section id="automatic-prices" title="Automatic prices" hint="Clients get a firm price at once from the traders’ firm offers, bounded by the market and the minimum net margin (ADR 0025).">
              <AutoPricing view={auto} canSet={can(ctx, 'pricing:configure')} />
            </Section>
            {peer ? (
              <Section id="client-meetings" title="Clients meet clients" hint="Two waiting clients meet without a trader: the same P2P deal and escrow, INRP2P’s fee inside the rate, the network split (ADR 0033).">
                <PeerMatching
                  view={{
                    enabled: peer.policy.enabled, feeBps: peer.policy.feeBps, minDealUsdt: Money.ofMinor(peer.policy.minDealUsdtMinor, 'USDT').toDecimalString().replace(/\.?0+$/, ''),
                    live: peer.live, started7d: peer.started7d, ended7d: peer.ended7d,
                  }}
                  canSet={can(ctx, 'pricing:configure')}
                />
              </Section>
            ) : null}
          </>
        )}
      </PageBody>
    </Page>
  );
}
