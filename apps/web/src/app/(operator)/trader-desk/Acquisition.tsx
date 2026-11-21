import Link from 'next/link';
import type { FunnelCounts, FunnelGrouping, FunnelStage, TraderFunnel } from '../../../server/acquisition-funnel.ts';
import { Sheet } from '../_book/parts.tsx';
import { KpiBand, Notice, Segmented } from '../_desk/ui.tsx';
import s from '../_desk/desk.module.css';

/** The stages after the first, as the table heads them. */
const STAGES: readonly { readonly key: FunnelStage; readonly label: string }[] = [
  { key: 'chose', label: 'Chose a side' },
  { key: 'clicked', label: 'Pressed apply' },
  { key: 'entered', label: 'Reached sign-in' },
  { key: 'signedIn', label: 'Signed in' },
  { key: 'applied', label: 'Applied' },
  { key: 'approved', label: 'Approved' },
  { key: 'reserved', label: 'Reserve held' },
  { key: 'active', label: 'First deal' },
];

const PERIODS = [7, 30, 90] as const;
const GROUPINGS: readonly { readonly by: FunnelGrouping; readonly label: string }[] = [
  { by: 'campaign', label: 'Campaign' },
  { by: 'ref', label: 'Referral code' },
  { by: 'segment', label: 'Side' },
];
const SIDE: Record<string, string> = { USDT: 'Holds USDT', INR: 'Has rupees', OTC: 'OTC desk' };
const STATUS: Record<string, string> = { UNDER_REVIEW: 'Under review', APPROVED: 'Approved', PAUSED: 'Paused', REJECTED: 'Rejected' };

const pct = (n: number, of: number): string => (of > 0 ? `${Math.round((n / of) * 1000) / 10}%` : '—');

/** A count, and under it its share of the group's visitors. */
function Cell({ n, of }: { n: number; of: number }) {
  return (
    <td data-align="right" className={s.num}>
      <b>{n}</b>
      {n > 0 ? <span className={s.secondary}> · {pct(n, of)}</span> : null}
    </td>
  );
}

function Counts({ c }: { c: FunnelCounts }) {
  return (
    <>
      <td data-align="right" className={s.num}>
        <b>{c.visitors}</b>
      </td>
      {STAGES.map((st) => (
        <Cell key={st.key} n={c[st.key]} of={c.visitors} />
      ))}
    </>
  );
}

const href = (days: number, by: FunnelGrouping) => `/trader-desk?view=acquisition&days=${days}&by=${by}`;

/**
 * The Traders page's Acquisition view (migration 0053): how many visitors `inrp2p.com/traders` had, where they came from,
 * and how far each got — to an application, an approval, a reserve and a first deal. A visitor is counted once, in the
 * period and the group of its first touch. Nothing here is a person's detail beyond what the trader list already shows.
 */
export function Acquisition({ funnel, publicOrigin }: { funnel: TraderFunnel; publicOrigin: string }) {
  const { total, days, by } = funnel;
  const heads = by === 'campaign' ? ['Source', 'Medium', 'Campaign'] : by === 'ref' ? ['Referral code'] : ['Side'];
  return (
    <>
      <KpiBand
        label="Trader acquisition"
        items={[
          { key: 'v', label: 'Visitors', value: String(total.visitors), sub: `new on the trader page in ${days} days` },
          { key: 'c', label: 'Pressed apply', value: String(total.clicked), sub: `${pct(total.clicked, total.visitors)} of visitors` },
          { key: 'a', label: 'Applied', value: String(total.applied), sub: `${pct(total.applied, total.visitors)} of visitors`, ...(total.applied === 0 ? { tone: 'muted' as const } : {}) },
          { key: 'r', label: 'Approved with a reserve', value: String(total.reserved), sub: `${total.approved} approved in all` },
          { key: 'd', label: 'First deal done', value: String(total.active), sub: 'active liquidity providers', ...(total.active > 0 ? { tone: 'success' as const } : { tone: 'muted' as const }) },
        ]}
      />

      <Sheet
        title="Where they came from"
        hint="Each visitor once, in the group of their first touch. Shares are of the group’s visitors."
        actions={
          <>
            <Segmented label="Group by" items={GROUPINGS.map((g) => ({ href: href(days, g.by), label: g.label, current: g.by === by }))} />
            <Segmented label="Period" items={PERIODS.map((d) => ({ href: href(d, by), label: `${d} days`, current: d === days }))} />
          </>
        }
        flush
      >
        <div className={s.tableWrap}>
          <table className={s.table}>
            <caption>Trader page visitors by {by === 'campaign' ? 'campaign' : by === 'ref' ? 'referral code' : 'side'}, and how far they got</caption>
            <thead>
              <tr>
                {heads.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
                <th scope="col" data-align="right">
                  Visitors
                </th>
                {STAGES.map((st) => (
                  <th key={st.key} scope="col" data-align="right">
                    {st.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {funnel.rows.length === 0 ? (
                <tr>
                  <td colSpan={heads.length + 1 + STAGES.length} className={s.secondary}>
                    No visitors in these {days} days yet.
                  </td>
                </tr>
              ) : (
                funnel.rows.map((r) => (
                  <tr key={r.key.join('|')}>
                    {r.key.map((k, i) => (
                      <td key={i} className={k ? undefined : s.secondary}>
                        {k ? (by === 'segment' ? (SIDE[k] ?? k) : k) : i === 0 ? (by === 'campaign' ? 'Direct' : 'None') : '—'}
                      </td>
                    ))}
                    <Counts c={r} />
                  </tr>
                ))
              )}
            </tbody>
            {funnel.rows.length > 1 ? (
              <tfoot>
                <tr>
                  <th scope="row" colSpan={heads.length} style={{ textAlign: 'left' }}>
                    All
                  </th>
                  <Counts c={total} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </Sheet>

      <Sheet title="Applications that came through the page" count={funnel.applicants.length} hint={`Applied in the last ${days} days, with where each first came from.`} flush>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <caption>Applications from the trader page</caption>
            <thead>
              <tr>
                <th scope="col">Trader</th>
                <th scope="col">Applied</th>
                <th scope="col">Came from</th>
                <th scope="col">Side</th>
                <th scope="col">Status</th>
                <th scope="col">Reserve</th>
                <th scope="col">First deal</th>
              </tr>
            </thead>
            <tbody>
              {funnel.applicants.length === 0 ? (
                <tr>
                  <td colSpan={7} className={s.secondary}>
                    No application has come through the page in these {days} days yet.
                  </td>
                </tr>
              ) : (
                funnel.applicants.map((a) => (
                  <tr key={a.traderId}>
                    <td>
                      <Link href={`/trader-desk/${a.traderId}`}>{a.name}</Link> <span className={s.secondary}>{a.ref}</span>
                    </td>
                    <td className={s.num}>{a.appliedAt.toISOString().slice(0, 10)}</td>
                    <td>
                      {[a.source, a.medium, a.campaign].filter(Boolean).join(' / ') || 'Direct'}
                      {a.referral ? <span className={s.secondary}> · ref {a.referral}</span> : null}
                    </td>
                    <td>{a.segment ? (SIDE[a.segment] ?? a.segment) : '—'}</td>
                    <td>{STATUS[a.status] ?? a.status}</td>
                    <td>{a.reserved ? 'Held' : '—'}</td>
                    <td>{a.active ? 'Done' : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Sheet>

      <Notice tone="brand">
        Tag every link to the trader page so it lands in the right row:{' '}
        <code>
          {publicOrigin}/traders?utm_source=telegram&amp;utm_medium=post&amp;utm_campaign=name&amp;ref=code&amp;for=usdt
        </code>
        . <code>for</code> opens the page on one side — <code>usdt</code>, <code>inr</code> or <code>otc</code>; <code>ref</code> is a partner’s or a trader’s own code.
      </Notice>
    </>
  );
}
