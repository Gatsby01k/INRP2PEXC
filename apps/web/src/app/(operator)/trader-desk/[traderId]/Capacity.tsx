import type { DeskTraderDetail } from '@inrp2p/traders';
import { formatIstTime } from '@inrp2p/ui/format';
import { Coin } from '../../../../components/Coin.tsx';
import { inr, rate, share, usdt } from '../../_desk/format.ts';
import { Chip } from '../../_desk/ui.tsx';
import { Facts, MiniMeter, Sheet, bookStyles as b } from '../../_book/parts.tsx';
import { offset } from '../words.tsx';

/**
 * The trader's own two sides, as routing sees them: the rate it stands behind, how much of its capacity open orders hold,
 * and the terms of an order. Set by the trader; the desk reads them here and never edits them.
 */
export function Capacity({ detail }: { detail: DeskTraderDetail }) {
  return (
    <Sheet title="Prices and capacity" hint="Set by the trader. What is held is promised to open orders." label="Prices and capacity">
      {detail.blocks.length === 0 ? <p className={b.quiet}>Opened when the trader is approved.</p> : null}
      {detail.blocks.map((x) => {
        const buy = x.side === 'BUY_USDT';
        const amount = (v: string) => (buy ? inr(v) : usdt(v));
        const held = share(x.held, x.capacity, buy ? 'INR' : 'USDT');
        return (
          <div key={x.side} className={b.sideBlock}>
            <div className={b.sideHead}>
              <Coin currency={buy ? 'INR' : 'USDT'} size={30} />
              <span className={b.rowMain}>
                <span className={b.rowTitle}>
                  <span>{buy ? 'Buys USDT' : 'Sells USDT'}</span>
                  <Chip tone={x.status === 'ACTIVE' ? 'success' : 'muted'}>{x.status === 'ACTIVE' ? 'live' : x.status.toLowerCase()}</Chip>
                </span>
                <span className={b.rowSub}>{buy ? 'pays the client’s INR' : 'brings USDT, takes INR'}</span>
              </span>
              <span className={b.sideRate}>{x.rate ? rate(x.rate) : '—'}</span>
            </div>
            <MiniMeter value={held} tone="brand" label={`${amount(x.held)} of ${amount(x.capacity)} held`} />
            <div className={b.sideCaption}>
              <span>{amount(x.held)} held</span>
              <span>of {amount(x.capacity)}</span>
            </div>
            <Facts
              items={[
                {
                  label: 'Price',
                  value: x.market ? `market ${offset(x.market.offsetBps)}${x.market.limit ? `, never ${buy ? 'above' : 'below'} ${rate(x.market.limit)}` : ''}` : x.rate ? 'fixed by the trader' : 'not set',
                },
                { label: 'Per order', value: x.minOrder && x.maxOrder ? `${amount(x.minOrder)} – ${amount(x.maxOrder)}` : 'not set' },
                { label: 'Instant orders', value: x.firm ? (x.firm.until ? `on until ${formatIstTime(new Date(x.firm.until))}` : 'on until turned off') : 'off' },
              ]}
            />
          </div>
        );
      })}
    </Sheet>
  );
}
