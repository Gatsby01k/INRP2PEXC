'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { DeskPriceView } from '@inrp2p/traders';
import { CopyButton } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { createDeskDealLinkAction } from '../../../../server/actions/desks.ts';
import { Field, Segmented } from '../../_workspace/Field.tsx';
import { ChatIcon, CheckIcon, LinkIcon, PlusIcon, SendIcon, ShareIcon } from '../../_workspace/icons.tsx';
import { Sheet } from '../../_workspace/Sheet.tsx';
import { previewDeal, percent, rate as rateText, inr, sentence, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../desk.module.css';

type Direction = 'SELL_USDT' | 'BUY_USDT';

/** "104.600000" → "104.60": the rate as a person types it. */
function plainRate(r: string | undefined): string {
  if (!r) return '';
  const [whole = '0', fraction = ''] = r.split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

const VALIDITY = [
  { minutes: 15, label: '15 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 1440, label: '1 day' },
  { minutes: 10080, label: '7 days' },
] as const;

/**
 * A deal for one client, made in one sheet and sent as a link: which way, how much, at what rate, for how long — with
 * what each side sends and receives, and INRP2P's fee, worked out as the quote will price it. Then the link, ready to
 * paste into the chat the client is already in.
 */
export function NewDealSheet({
  deskName,
  feeBps,
  prices,
  status,
  canCommit,
  variant = 'primary',
}: {
  deskName: string;
  feeBps: number;
  prices: Readonly<Record<Direction, DeskPriceView | null>>;
  status: string;
  canCommit: boolean;
  variant?: 'primary' | 'secondary';
}) {
  const live = status === 'LIVE';
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>(prices.SELL_USDT ? 'SELL_USDT' : 'BUY_USDT');
  const [fixedSide, setFixedSide] = useState<'BASE' | 'QUOTE'>('BASE');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState(plainRate(prices[direction]?.rate));
  const [minutes, setMinutes] = useState<number>(60);
  const [note, setNote] = useState('');
  const [made, setMade] = useState<{ url: string; ref: string; expiresAt: string } | null>(null);
  const { run, busy, error, clearError, dialog } = useCommand();

  const deal = useMemo(() => previewDeal({ direction, fixedSide, amount, rate, feeBps }), [direction, fixedSide, amount, rate, feeBps]);
  const priced = deal !== null && typeof deal !== 'string' ? deal : null;
  const sells = direction === 'SELL_USDT';

  const reset = () => {
    setMade(null);
    setAmount('');
    setNote('');
    clearError();
  };

  const pickDirection = (next: Direction) => {
    setDirection(next);
    setRate(prices[next] ? plainRate(prices[next]!.rate) : rate);
  };

  const submit = async () => {
    if (!priced) return;
    const out = await run(`Deal link for ${note || 'a client'}`, (key) =>
      createDeskDealLinkAction({ direction, fixedSide, amount: amount.trim(), rate: rate.trim(), validMinutes: minutes, note: note.trim() || null }, key),
    );
    if (out.ok) setMade(out.result);
  };

  const message = priced && made
    ? `${deskName}: ${sells ? `you sell ${usdt(priced.base.toDecimalString())} and receive ${inr(priced.clientInr.toDecimalString())}` : `you buy ${usdt(priced.base.toDecimalString())} for ${inr(priced.clientInr.toDecimalString())}`} at ${rateText(rate)} per USDT. Open the link to accept: ${made.url}`
    : '';

  const shareNative = async () => {
    if (!made) return;
    if (typeof navigator.share === 'function') {
      await navigator.share({ title: `Deal with ${deskName}`, text: message }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(message).catch(() => {});
    }
  };

  const trigger =
    variant === 'primary' ? (
      <button type="button" className={shell.action} data-size="sm" data-tone="ink" onClick={() => setOpen(true)}>
        <PlusIcon className={shell.actionIcon} />
        New deal
      </button>
    ) : (
      <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => setOpen(true)}>
        <LinkIcon />
        New deal link
      </button>
    );

  return (
    <>
      {trigger}
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        locked={busy}
        eyebrow="New deal"
        title={made ? 'Your link is ready' : 'A deal for one client'}
        description={made ? undefined : 'Set the terms, then send the link. The first client to open it and sign in takes the deal at exactly this rate.'}
        footer={
          made ? (
            <button type="button" className={`${shell.secondaryAction} ${shell.wide}`} onClick={reset}>
              Make another
            </button>
          ) : (
            <button type="button" className={`${shell.action} ${shell.wide}`} disabled={!priced || busy || !live || !canCommit} aria-busy={busy || undefined} onClick={() => void submit()}>
              {busy ? 'Making the link…' : 'Create link'}
            </button>
          )
        }
      >
        {status === 'SUSPENDED' ? (
          <p className={shell.info} data-tone="warning">INRP2P has suspended your desk: no new deal link until INRP2P lifts it.</p>
        ) : !live ? (
          <p className={shell.info} data-tone="warning">
            Take your desk live before you send deal links. <Link className={shell.textAction} href="/desk/settings">Go to Page</Link>
          </p>
        ) : !canCommit ? (
          <p className={shell.info} data-tone="warning">Deal links commit your desk to a price — someone who can accept quotes for your account makes them.</p>
        ) : null}

        {made && priced ? (
          <div className={styles.share}>
            <div className={styles.shareHero}>
              <span className={styles.shareIcon} data-brand="done" aria-hidden="true">
                <CheckIcon />
              </span>
              <p className={styles.shareBody}>
                {made.ref} · valid until {formatIstDateTime(new Date(made.expiresAt))}. This is the only time the link is shown — copy it now.
              </p>
            </div>
            <div className={styles.linkBox}>
              <span className={styles.linkText}>{made.url}</span>
              <CopyButton value={made.url} label="deal link" />
            </div>
            <div className={styles.shareButtons}>
              <a className={styles.shareButton} href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
                <span className={styles.shareIcon} data-brand="whatsapp" aria-hidden="true">
                  <ChatIcon />
                </span>
                WhatsApp
              </a>
              <a className={styles.shareButton} href={`https://t.me/share/url?url=${encodeURIComponent(made.url)}&text=${encodeURIComponent(message.replace(` ${made.url}`, ''))}`} target="_blank" rel="noreferrer">
                <span className={styles.shareIcon} data-brand="telegram" aria-hidden="true">
                  <SendIcon />
                </span>
                Telegram
              </a>
              <button type="button" className={styles.shareButton} onClick={() => void shareNative()}>
                <span className={styles.shareIcon} aria-hidden="true">
                  <ShareIcon />
                </span>
                More
              </button>
            </div>
            <dl className={styles.preview}>
              <div className={styles.previewRow}>
                <dt>{sells ? 'Client sends' : 'Client pays you'}</dt>
                <dd>{sells ? usdt(priced.base.toDecimalString()) : inr(priced.clientInr.toDecimalString())}</dd>
              </div>
              <div className={styles.previewRow}>
                <dt>{sells ? 'You pay the client' : 'Client receives'}</dt>
                <dd>{sells ? inr(priced.clientInr.toDecimalString()) : usdt(priced.base.toDecimalString())}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className={styles.form}>
            <Segmented<Direction>
              legend="The client"
              value={direction}
              onChange={pickDirection}
              options={[
                { value: 'SELL_USDT', label: 'Sells USDT', detail: prices.SELL_USDT ? `Your price ${rateText(prices.SELL_USDT.rate)}` : 'You buy' },
                { value: 'BUY_USDT', label: 'Buys USDT', detail: prices.BUY_USDT ? `Your price ${rateText(prices.BUY_USDT.rate)}` : 'You sell' },
              ]}
            />
            <div className={styles.row2}>
              <Field
                label={fixedSide === 'BASE' ? 'Amount in USDT' : 'Amount in rupees'}
                inputMode="decimal"
                autoComplete="off"
                placeholder={fixedSide === 'BASE' ? '1,000' : '1,00,000'}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                adornment={fixedSide === 'BASE' ? 'USDT' : '₹'}
                action={
                  <button type="button" className={shell.textAction} onClick={() => setFixedSide(fixedSide === 'BASE' ? 'QUOTE' : 'BASE')}>
                    {fixedSide === 'BASE' ? 'in ₹' : 'in USDT'}
                  </button>
                }
                data-autofocus=""
              />
              <Field label="Rate, ₹ per USDT" inputMode="decimal" autoComplete="off" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ''))} adornment="₹" />
            </div>
            <div className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Link valid for</span>
              <div className={styles.choices}>
                {VALIDITY.map((v) => (
                  <button key={v.minutes} type="button" className={styles.choice} aria-pressed={minutes === v.minutes} onClick={() => setMinutes(v.minutes)}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Who it is for" hint="Only your desk sees this." maxLength={140} placeholder="Ravi, Telegram" value={note} onChange={(e) => setNote(e.target.value)} />

            {typeof deal === 'string' ? <p className={shell.error}>{deal}</p> : null}
            {priced ? (
              <dl className={styles.preview} aria-label="The deal">
                <div className={styles.previewRow}>
                  <dt>{sells ? 'Client sends' : 'Client pays you'}</dt>
                  <dd>{sells ? usdt(priced.base.toDecimalString()) : inr(priced.clientInr.toDecimalString())}</dd>
                </div>
                <div className={styles.previewRow}>
                  <dt>{sells ? 'You pay the client' : 'Client receives'}</dt>
                  <dd>{sells ? inr(priced.clientInr.toDecimalString()) : usdt(priced.base.toDecimalString())}</dd>
                </div>
                <div className={styles.previewRow} data-strong="">
                  <dt>{sells ? 'You receive' : 'You put in escrow'}</dt>
                  <dd>{usdt(priced.routeBase!.toDecimalString())}</dd>
                </div>
                <div className={styles.previewRow} data-quiet="">
                  <dt>INRP2P fee · {percent(feeBps)}</dt>
                  <dd>{usdt(priced.platformFeeBase.toDecimalString())}</dd>
                </div>
              </dl>
            ) : null}
            {error ? (
              <p className={shell.error} role="alert">
                {sentence(error)}
              </p>
            ) : null}
          </div>
        )}
      </Sheet>
      {dialog}
    </>
  );
}
