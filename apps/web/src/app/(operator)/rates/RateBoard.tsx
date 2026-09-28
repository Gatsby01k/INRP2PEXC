'use client';

import { useState } from 'react';
import { Rate } from '@inrp2p/kernel';
import type { RateHistoryRow, StripRoute } from '@inrp2p/desk';
import { Button } from '@inrp2p/ui';
import { publishRouteRateAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { Ago, useDeskNow } from '../_desk/clock.tsx';
import { RateField } from '../_desk/fields.tsx';
import { ROUTE_RATE_STALE_SECONDS, pair, rate, rateDelta, usdt } from '../_desk/format.ts';
import { Chip, Notice } from '../_desk/ui.tsx';

import d from '../_desk/desk.module.css';
import r from './rates.module.css';

/** A move of this many basis points or more asks to be confirmed: a mistyped rate prices every quote after it. */
const CONFIRM_MOVE_BPS = 200n;

/**
 * The dealer's control surface for route rates (brief, "Rates page"): per route and direction, the rate in force,
 * the one it replaced, how old it is against the quoting policy, and a publish field right there. A rate is one
 * command (`rates.publish_route`); a large move is not refused — markets move — but it is shown as a percentage and
 * needs a second press, because a slipped digit would otherwise price every quote that follows.
 */
export function RateBoard({ routes, history, canPublish }: { routes: readonly StripRoute[]; history: readonly RateHistoryRow[]; canPublish: boolean }) {
  const byRoute = new Map<string, { name: string; mode: StripRoute['executionMode']; available: string; sides: StripRoute[] }>();
  for (const x of routes) {
    const e = byRoute.get(x.routeId) ?? { name: x.routeName, mode: x.executionMode, available: x.availableUsdt, sides: [] };
    e.sides.push(x);
    byRoute.set(x.routeId, e);
  }
  if (byRoute.size === 0) return <Notice tone="warning">No active desk route. Routes are configured by the owner.</Notice>;
  return (
    <div className={r.board}>
      {[...byRoute.entries()].map(([id, route]) => (
        <section key={id} className={r.route} aria-label={route.name}>
          <header className={r.routeHead}>
            <div className={d.stackTight} style={{ gap: 2 }}>
              <h2 className={r.routeName}>{route.name}</h2>
              <span className={d.meta}>
                {route.mode === 'DIRECT_TO_CLIENT' ? 'Pays clients directly' : 'Settles with the exchange'} · takes up to {usdt(route.available)}
              </span>
            </div>
            <Chip tone={route.mode === 'DIRECT_TO_CLIENT' ? 'brand' : 'neutral'}>{route.mode === 'DIRECT_TO_CLIENT' ? 'Direct to client' : 'To exchange'}</Chip>
          </header>
          <div className={r.sides}>
            {(['SELL_USDT', 'BUY_USDT'] as const).map((dir) => {
              const side = route.sides.find((x) => x.direction === dir);
              if (!side) return null;
              const previous = history.find((h) => h.routeId === id && h.direction === dir)?.previous ?? null;
              return <RateSide key={dir} side={side} previous={previous} canPublish={canPublish} />;
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function RateSide({ side, previous, canPublish }: { side: StripRoute; previous: string | null; canPublish: boolean }) {
  const cmd = useCommand();
  const now = useDeskNow();
  const [next, setNext] = useState('');
  const [armed, setArmed] = useState(false);
  const stale = !side.publishedAt || now - new Date(side.publishedAt).getTime() > ROUTE_RATE_STALE_SECONDS * 1000;
  const change = side.rate && previous ? rateDelta(side.rate, previous) : null;

  let move: { bps: bigint; pct: string; text: string } | null = null;
  if (side.rate && next !== '' && !next.endsWith('.')) {
    try {
      const a = Rate.parse(next, 'ROUTE').micro;
      const b = Rate.parse(side.rate, 'ROUTE').micro;
      const diff = a - b;
      const bps = ((diff < 0n ? -diff : diff) * 10000n) / b;
      const pct = `${diff < 0n ? '−' : '+'}${bps / 100n}.${String(bps % 100n).padStart(2, '0')}%`;
      move = { bps, pct, text: `${rateDelta(next, side.rate).text} (${pct}) vs the rate in force` };
    } catch {
      move = null;
    }
  }
  const big = move !== null && move.bps >= CONFIRM_MOVE_BPS;
  const valid = next !== '' && !next.endsWith('.') && (move !== null || !side.rate);

  const publish = () => {
    if (!valid || cmd.busy) return;
    if (big && !armed) {
      setArmed(true);
      return;
    }
    void cmd.run(`Publish ${rate(next)} on ${side.routeName} · ${pair(side.direction)}`, (k) => publishRouteRateAction({ routeId: side.routeId, direction: side.direction, rate: next }, k)).then((out) => {
      if (out.ok) {
        setNext('');
        setArmed(false);
      }
      return out;
    });
  };

  return (
    <div className={r.side} data-testid={`rate-${side.routeName}-${side.direction}`}>
      <span className={r.sideLabel}>
        {pair(side.direction)} <span className={d.muted}>· client {side.direction === 'SELL_USDT' ? 'sells' : 'buys'} USDT</span>
      </span>
      <div className={r.current}>
        <span className={r.currentValue} {...(stale ? { 'data-stale': '' } : {})}>
          {side.rate ? rate(side.rate) : '—'}
        </span>
        {change ? (
          <span className={r.change} data-sign={change.sign}>
            {change.text}
          </span>
        ) : null}
      </div>
      <span className={r.sideMeta}>
        {previous ? `previous ${rate(previous)} · ` : ''}
        {side.publishedAt ? (
          <>
            updated <Ago at={side.publishedAt} />
          </>
        ) : (
          'never published'
        )}
        {stale ? <span className={r.staleTag}>stale — quotes are refused</span> : null}
      </span>
      {canPublish ? (
        <div className={r.publish}>
          <RateField
            label="New rate"
            value={next}
            onChange={(v) => {
              setNext(v);
              setArmed(false);
            }}
            onEnter={publish}
            {...(move ? { hint: move.text } : {})}
          />
          <Button intent={armed ? 'danger' : 'primary'} size="sm" disabled={!valid || cmd.busy} loading={cmd.busy} onClick={publish}>
            {armed ? `Publish ${rate(next)} anyway` : 'Publish'}
          </Button>
        </div>
      ) : null}
      {armed && move ? (
        <Notice tone="warning" icon="exceptions">
          That moves the rate by {move.pct}. Press again if it is right; every quote priced on this route uses it from now on.
        </Notice>
      ) : null}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
