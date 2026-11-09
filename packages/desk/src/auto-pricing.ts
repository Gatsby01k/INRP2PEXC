import { sql } from 'kysely';
import { Money, Rate } from '@inrp2p/kernel';
import type { DirectionValue, Executor } from '@inrp2p/db';
import { currentPricingPolicy, currentReferenceRate } from '@inrp2p/pricing';

/**
 * What the desk sees of automatic pricing (ADR 0025): the policy in force, the market references it bounds prices by and
 * how old they are, and what the last day did — prices given and accepted, what they left, price requests and how they
 * ended. Figures of record only; nothing here prices anything.
 */
export interface AutoPricingView {
  readonly policy: {
    readonly id: string;
    readonly autoQuote: boolean;
    readonly rfq: boolean;
    readonly referenceMaxAgeSeconds: number;
    readonly maxPremiumBps: number;
    readonly binBps: number;
    readonly learningDays: number;
    readonly rfqWindowSeconds: number;
    readonly rfqMaxTraders: number;
    readonly setBy: string;
    readonly setAt: string;
    readonly reason: string;
  };
  readonly references: readonly { readonly direction: DirectionValue; readonly rate: string | null; readonly source: string | null; readonly ageSeconds: number | null; readonly fresh: boolean }[];
  readonly lastDay: {
    readonly quoted: number;
    readonly accepted: number;
    readonly fromRfq: number;
    /** INRP2P's net USDT margin on the automatic quotes clients accepted. */
    readonly acceptedNetUsdt: string;
    readonly rfqOpened: number;
    readonly rfqAwarded: number;
    readonly rfqNoPrice: number;
    /** ADR 0028: requests nothing priced honestly, closed with a plain answer to the client — by why. */
    readonly unpriced: number;
    readonly unpricedBy: Readonly<Partial<Record<'NO_MARKET' | 'NETWORK_UNKNOWN' | 'NO_OFFER' | 'NOT_COMPETITIVE' | 'NO_BID', number>>>;
  };
}

export async function autoPricingView(ex: Executor): Promise<AutoPricingView> {
  const policy = await currentPricingPolicy(ex);
  const references = [];
  for (const direction of ['SELL_USDT', 'BUY_USDT'] as const) {
    const r = await currentReferenceRate(ex, direction);
    references.push({
      direction, rate: r ? Rate.ofMicro(r.rate.micro, 'REFERENCE').toDecimalString() : null, source: r?.source ?? null, ageSeconds: r?.ageSeconds ?? null,
      fresh: r !== null && r.ageSeconds <= policy.referenceMaxAgeSeconds,
    });
  }
  const day = await sql<{ quoted: number; accepted: number; from_rfq: number; net: string; rfq_opened: number; rfq_awarded: number; rfq_no_price: number }>`
    select (select count(*) from auto_quote a where a.created_at >= inrp2p_now() - interval '1 day')::int as quoted,
           (select count(*) from auto_quote a join quote q on q.id = a.quote_id where a.created_at >= inrp2p_now() - interval '1 day' and q.status = 'ACCEPTED')::int as accepted,
           (select count(*) from auto_quote a where a.created_at >= inrp2p_now() - interval '1 day' and a.source = 'RFQ')::int as from_rfq,
           (select coalesce(sum(a.net_margin_usdt_minor), 0) from auto_quote a join quote q on q.id = a.quote_id where a.created_at >= inrp2p_now() - interval '1 day' and q.status = 'ACCEPTED')::text as net,
           (select count(*) from rfq where opened_at >= inrp2p_now() - interval '1 day')::int as rfq_opened,
           (select count(*) from rfq where opened_at >= inrp2p_now() - interval '1 day' and status = 'AWARDED')::int as rfq_awarded,
           (select count(*) from rfq where opened_at >= inrp2p_now() - interval '1 day' and status = 'NO_PRICE')::int as rfq_no_price`.execute(ex);
  const d = day.rows[0]!;
  const unpriced = await sql<{ reason: 'NO_MARKET' | 'NETWORK_UNKNOWN' | 'NO_OFFER' | 'NOT_COMPETITIVE' | 'NO_BID'; n: number }>`
    select no_price_reason as reason, count(*)::int as n from trade_request
     where no_price_reason is not null and closed_at >= inrp2p_now() - interval '1 day' group by no_price_reason`.execute(ex);
  // Who set the policy, as a person reads it: the operator's name or email; a system actor as it is written.
  const setter = await ex.selectFrom('auth_user').select(['name', 'email']).where('id', '=', policy.setBy).executeTakeFirst().catch(() => undefined);
  return {
    policy: {
      id: policy.id, autoQuote: policy.autoQuote, rfq: policy.rfq, referenceMaxAgeSeconds: policy.referenceMaxAgeSeconds, maxPremiumBps: policy.maxPremiumBps, binBps: policy.binBps,
      learningDays: policy.learningDays, rfqWindowSeconds: policy.rfqWindowSeconds, rfqMaxTraders: policy.rfqMaxTraders, setBy: setter ? (setter.name || setter.email) : policy.setBy, setAt: policy.setAt.toISOString(), reason: policy.reason,
    },
    references,
    lastDay: {
      quoted: d.quoted, accepted: d.accepted, fromRfq: d.from_rfq, acceptedNetUsdt: Money.ofMinor(BigInt(d.net), 'USDT').toDecimalString(),
      rfqOpened: d.rfq_opened, rfqAwarded: d.rfq_awarded, rfqNoPrice: d.rfq_no_price,
      unpriced: unpriced.rows.reduce((sum, r) => sum + r.n, 0), unpricedBy: Object.fromEntries(unpriced.rows.map((r) => [r.reason, r.n])),
    },
  };
}
