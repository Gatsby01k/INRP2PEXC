'use client';

import { StateRing } from '../_workspace/StateRing.tsx';
import { marketMid, useMarket } from '../_workspace/useMarket.ts';
import stage from './stage.module.css';

/**
 * The phone's stage before a request (mock-up v3): "Live market", one USDT, and what it goes for now, large, beside
 * the robot. It is the market's rate, not a price — the request below asks the desk for a firm one. Set as plain
 * text, never faded in, so the phone's first paint is the figure itself.
 */
export function LiveMarket() {
  const market = useMarket();
  const mid = marketMid(market);
  const [whole = '', fraction = ''] = mid === null ? [] : mid.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split('.');
  return (
    <div className={stage.mini}>
      <span className={stage.miniChip}>
        <StateRing state="live" />
        Live market
      </span>
      <p className={stage.miniLabel}>1 USDT</p>
      <p className={stage.miniFigure} title="The market’s rate now. Your firm price comes from the desk.">
        {mid === null ? (
          <span className={stage.miniWait}>Firm prices on request</span>
        ) : (
          <>
            <span data-part="cur">₹</span>
            {whole}
            <span data-part="fraction">.{fraction}</span>
          </>
        )}
      </p>
    </div>
  );
}
