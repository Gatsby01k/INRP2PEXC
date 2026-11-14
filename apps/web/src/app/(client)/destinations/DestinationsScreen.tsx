'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClientBankAccount, ClientDestinations, ClientWallet } from '@inrp2p/portal';
import { CopyButton } from '@inrp2p/ui';
import { shortenAddress } from '@inrp2p/ui/format';
import { BankMark, ImpsMark, RailMark, TronMark, UpiMark, UsdtOnTron, bankTint } from '../../../components/PayMarks.tsx';
import { MarkArt } from '../../../components/MarkArt.tsx';
import { readiness } from '../_assistant/model.ts';
import { ArchiveIcon, ArrowDownLeftIcon, ArrowUpRightIcon, CheckIcon, ChevronDownIcon, LockIcon, PlusIcon, ShieldIcon } from '../_workspace/icons.tsx';
import { SecondFactor } from '../_workspace/SecondFactor.tsx';
import type { Protection } from '../../../server/client.ts';
import { Sheet } from '../_workspace/Sheet.tsx';
import { AddDestination, type DestinationKind } from './AddDestination.tsx';
import { UpiIdsCard } from './UpiIds.tsx';
import { ArchiveDialog, type ArchiveTarget } from './ArchiveDialog.tsx';
import { AddTile, CardMenu, Group, Instrument, InstrumentTop, NoneYet, Tag } from './parts.tsx';
import shell from '../shell.module.css';
import styles from './destinations.module.css';

/** Tether's green, the wash in a wallet card's corner. */
const USDT_TINT = '#26a17b';

/** The order a client reads the rails in: the fastest first. */
const RAIL_ORDER = ['UPI', 'IMPS', 'NEFT', 'RTGS'];

const live = (s: ClientWallet['status']) => s === 'ACTIVE' || s === 'PENDING_REVIEW';

/**
 * Bank & wallets: where this client's money is allowed to go, and so which directions they can trade.
 *
 * It answers first, on the mark's orange, the question a client actually has — can I sell, can I buy, where does the
 * money land and by which rails — then shows each account, UPI ID and wallet as a card with its own sign: the bank's
 * colours, UPI's mark, Tether's coin on TRON. An administrator adds one from the tile at the end of each list and
 * archives one from its menu, each change confirmed by a factor other than the one they signed in with (ADR 0026,
 * D-08); anyone else sees them and is told who can. Archived ones are kept, folded away — destinations are archived,
 * never edited (S8), so the archived ones are how a client recognises an account they used to be paid into. The
 * account number a client gave is never shown back: the server seals it and keeps the last four (D-09).
 */
export function DestinationsScreen({
  destinations,
  clientName,
  email,
  isAdmin,
  protection,
}: {
  destinations: ClientDestinations;
  clientName: string;
  email: string;
  isAdmin: boolean;
  protection: Protection;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState<DestinationKind | null>(null);
  const [lastKind, setLastKind] = useState<DestinationKind>('bank');
  const [archiving, setArchiving] = useState<ArchiveTarget | null>(null);
  const [securing, setSecuring] = useState(false);
  const ready = readiness(destinations);
  const banks = destinations.banks.filter((b) => live(b.status));
  const wallets = destinations.wallets.filter((w) => live(w.status));
  const archivedBanks = destinations.banks.filter((b) => !live(b.status));
  const archivedWallets = destinations.wallets.filter((w) => !live(w.status));

  const add = (kind: DestinationKind) => {
    setLastKind(kind);
    setAdding(kind);
  };

  return (
    <>
      <main className={shell.main}>
        <Routes destinations={destinations} ready={ready} isAdmin={isAdmin} onAdd={add} />

        <Group id="banks-title" title="Bank accounts" count={banks.length} note="INR from the USDT you sell is paid to these.">
          {banks.map((b) => (
            <BankCard key={b.id} bank={b} {...(isAdmin && b.status === 'ACTIVE' ? { onArchive: () => setArchiving({ kind: 'bank', id: b.id, name: `${b.bankName} •••• ${b.last4}` }) } : {})} />
          ))}
          {isAdmin ? (
            <AddTile
              title="Add bank account"
              note={banks.length === 0 ? 'No bank account yet. Add one to sell USDT for INR.' : 'Paid by IMPS, NEFT or RTGS.'}
              marks={banks.length === 0 ? <RailMarks rails={['IMPS', 'NEFT', 'RTGS']} /> : undefined}
              onClick={() => add('bank')}
            />
          ) : banks.length === 0 ? (
            <NoneYet>No bank account yet. An administrator of {clientName} can add one.</NoneYet>
          ) : null}
        </Group>

        <UpiIdsCard upiIds={destinations.upiIds} isAdmin={isAdmin} holderName={banks.find((b) => b.status === 'ACTIVE')?.holderName ?? clientName} clientName={clientName} />

        <Group id="wallets-title" title="USDT wallets" count={wallets.length} note="TRC20 wallets the USDT you buy is delivered to.">
          {wallets.map((w) => (
            <WalletCard key={w.id} wallet={w} {...(isAdmin && w.status === 'ACTIVE' ? { onArchive: () => setArchiving({ kind: 'wallet', id: w.id, name: w.label }) } : {})} />
          ))}
          {isAdmin ? (
            <AddTile
              title="Add wallet"
              note={wallets.length === 0 ? 'No wallet yet. Add one to buy USDT.' : 'A TRC20 address on TRON.'}
              marks={wallets.length === 0 ? <UsdtOnTron size={36} /> : undefined}
              onClick={() => add('wallet')}
            />
          ) : wallets.length === 0 ? (
            <NoneYet>No wallet yet. An administrator of {clientName} can add one.</NoneYet>
          ) : null}
        </Group>

        {archivedBanks.length + archivedWallets.length > 0 ? (
          <details className={styles.archived}>
            <summary>
              <ChevronDownIcon className={styles.archivedChevron} />
              Archived <span className={styles.count}>{archivedBanks.length + archivedWallets.length}</span>
            </summary>
            <ul className={styles.rows}>
              {archivedBanks.map((b) => (
                <li key={b.id} className={styles.row}>
                  <BankMark ifsc={b.ifsc} name={b.bankName} size={36} />
                  <span className={styles.rowMain}>
                    <span className={styles.rowName}>
                      {b.bankName} <span className="ix-num">•••• {b.last4}</span>
                    </span>
                    <span className={styles.rowMeta}>
                      {b.holderName} · <span className="ix-num">{b.ifsc}</span>
                    </span>
                  </span>
                  <Tag tone="muted">{b.status === 'REJECTED' ? 'Not verified' : 'Archived'}</Tag>
                </li>
              ))}
              {archivedWallets.map((w) => (
                <li key={w.id} className={styles.row}>
                  <UsdtOnTron size={36} />
                  <span className={styles.rowMain}>
                    <span className={styles.rowName}>{w.label}</span>
                    <span className={`${styles.rowMeta} ix-num`}>{shortenAddress(w.address, 6, 6)}</span>
                  </span>
                  <Tag tone="muted">{w.status === 'REJECTED' ? 'Not verified' : 'Archived'}</Tag>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </main>

      <aside className={shell.aside}>
        <section className={styles.protect} data-on={protection.canConfirm || undefined} aria-labelledby="security-title">
          <div className={styles.protectHead}>
            <span className={styles.protectIcon} aria-hidden="true">
              {protection.canConfirm ? <ShieldIcon /> : <LockIcon />}
            </span>
            <div className={styles.protectText}>
              <h2 id="security-title" className={styles.asideTitle}>
                {protection.canConfirm ? 'Changes are protected' : 'Add a second way to confirm'}
              </h2>
              <p className={styles.asideBody}>
                {protection.canConfirm
                  ? `Every change on this page is confirmed with a code from ${confirmWords(protection)}.`
                  : isAdmin
                    ? 'Connect Telegram or an authenticator app to add or archive accounts. It takes a minute.'
                    : 'A second way to confirm protects the changes you can make.'}
              </p>
            </div>
          </div>
          {protection.canConfirm ? null : (
            <button type="button" className={shell.action} data-size="sm" data-tone="ink" onClick={() => setSecuring(true)}>
              Set up
            </button>
          )}
          <ul className={styles.trustList} aria-label="How your accounts are protected">
            <li>
              <CheckIcon />
              <span>Money from your trades goes only to the accounts and wallets listed here.</span>
            </li>
            <li>
              <CheckIcon />
              <span>Account numbers are encrypted when saved; only the last four digits are ever shown.</span>
            </li>
            <li>
              <CheckIcon />
              <span>Every addition or archive is confirmed by an administrator a second time — never with only what they signed in with — and every administrator is told.</span>
            </li>
          </ul>
        </section>

        <section className={styles.ways} aria-labelledby="ways-title">
          <h2 id="ways-title" className={styles.asideTitle}>
            How the money moves
          </h2>
          <dl className={styles.waysList}>
            <div>
              <dt>
                <span className={styles.wayMark} data-rail="UPI" aria-hidden="true">
                  <UpiMark />
                </span>
                <span className="ix-visually-hidden">UPI</span>
              </dt>
              <dd>In seconds, up to ₹100,000 a payment.</dd>
            </div>
            <div>
              <dt>
                <span className={styles.wayMark} data-rail="IMPS" aria-hidden="true">
                  <ImpsMark />
                </span>
                <span className="ix-visually-hidden">IMPS</span>
              </dt>
              <dd>Instant, any hour, to your bank account.</dd>
            </div>
            <div>
              <dt>
                <span className={styles.wayMark}>
                  <span className={styles.wayWord}>NEFT</span>
                </span>
              </dt>
              <dd>A bank transfer, usually within the hour.</dd>
            </div>
            <div>
              <dt>
                <span className={styles.wayMark}>
                  <span className={styles.wayWord}>RTGS</span>
                </span>
              </dt>
              <dd>For large amounts, from ₹200,000.</dd>
            </div>
            <div>
              <dt>
                <span className={styles.wayMark} data-rail="TRC20">
                  <TronMark size={16} />
                  <span className={styles.wayWord}>TRC20</span>
                </span>
              </dt>
              <dd>USDT on TRON, to your own wallet.</dd>
            </div>
          </dl>
        </section>
      </aside>

      <AddDestination
        open={adding !== null}
        kind={adding ?? lastKind}
        onClose={() => setAdding(null)}
        protection={protection}
        email={email}
        holderName={clientName}
        firstOfKind={(adding ?? lastKind) === 'bank' ? banks.length === 0 : wallets.length === 0}
      />
      <ArchiveDialog target={archiving} onClose={() => setArchiving(null)} />
      <Sheet open={securing} onClose={() => setSecuring(false)} eyebrow="Account & security" title="A second way to confirm" description="Your Telegram or an authenticator app confirms the changes that matter.">
        <SecondFactor
          protection={protection}
          email={email}
          returnTo="/destinations"
          onDone={() => {
            setSecuring(false);
            router.refresh();
          }}
        />
      </Sheet>
    </>
  );
}

/** Where this session's confirmation codes can come from, in words: everything but the factor it was opened with. */
function confirmWords(p: Protection): string {
  const ways = [
    ...(p.telegram === 'LINKED' && p.signInMethod !== 'TELEGRAM' ? ['your Telegram'] : []),
    ...(p.signInMethod !== 'EMAIL' ? ['your email'] : []),
    ...(p.authenticator ? ['your authenticator'] : []),
  ];
  return ways.length > 1 ? `${ways.slice(0, -1).join(', ')} or ${ways.at(-1)}` : (ways[0] ?? 'a second factor');
}

function RailMarks({ rails, className }: { rails: readonly string[]; className?: string | undefined }) {
  const ordered = RAIL_ORDER.filter((r) => rails.includes(r));
  return (
    <span className={`${styles.rails} ${className ?? ''}`}>
      {ordered.map((r) => (
        <RailMark key={r} rail={r} />
      ))}
    </span>
  );
}

/**
 * The orange moment: can this client sell, can it buy — where the money lands, and the rails it travels by. The
 * marks are its own accounts' banks and UPI; the words say the same.
 */
function Routes({ destinations, ready, isAdmin, onAdd }: { destinations: ClientDestinations; ready: { sell: boolean; buy: boolean }; isAdmin: boolean; onAdd: (kind: DestinationKind) => void }) {
  const banks = destinations.banks.filter((b) => b.status === 'ACTIVE');
  const upis = destinations.upiIds.filter((u) => u.status === 'ACTIVE');
  const receiving = destinations.wallets.filter((w) => w.status === 'ACTIVE' && w.purpose !== 'SOURCE');
  const rails = [...(upis.length > 0 ? ['UPI'] : []), ...banks.flatMap((b) => b.rails)];
  const bankWords = banks.length === 1 ? `${banks[0]!.bankName} •••• ${banks[0]!.last4}` : `${banks.length} bank accounts`;
  const upiWords = upis.length === 0 ? '' : upis.length === 1 ? ` · UPI ${upis[0]!.vpa}` : ` · ${upis.length} UPI IDs`;
  const walletWords = receiving.length === 1 ? `${receiving[0]!.label} · ${shortenAddress(receiving[0]!.address, 4, 4)}` : `${receiving.length} wallets`;

  return (
    <section className={`${shell.brandField} ${styles.routes}`} aria-label="What you can trade">
      <MarkArt className={styles.routesArt} hub={false} />
      <div className={styles.lane}>
        <div className={styles.laneHead}>
          <span className={styles.laneEyebrow}>Sell USDT</span>
          <LaneState ready={ready.sell} />
        </div>
        <span className={styles.laneText}>
          <span className={styles.laneTitle}>INR to your bank</span>
          <span className={styles.laneDetail}>{ready.sell ? `${bankWords}${upiWords}` : 'Needs a bank account for the INR'}</span>
        </span>
        {ready.sell ? (
          <span className={styles.laneMarks}>
            <span className={styles.stack} aria-hidden="true">
              {banks.slice(0, 4).map((b) => (
                <BankMark key={b.id} ifsc={b.ifsc} name={b.bankName} size={36} />
              ))}
            </span>
            <RailMarks rails={rails} className={styles.laneRails} />
          </span>
        ) : isAdmin ? (
          <button type="button" className={styles.laneAdd} onClick={() => onAdd('bank')}>
            <PlusIcon />
            Add bank account
          </button>
        ) : null}
      </div>
      <div className={styles.lane}>
        <div className={styles.laneHead}>
          <span className={styles.laneEyebrow}>Buy USDT</span>
          <LaneState ready={ready.buy} />
        </div>
        <span className={styles.laneText}>
          <span className={styles.laneTitle}>USDT to your wallet</span>
          <span className={`${styles.laneDetail} ix-num`}>{ready.buy ? walletWords : 'Needs a wallet for the USDT'}</span>
        </span>
        {ready.buy ? (
          <span className={styles.laneMarks}>
            <span className={styles.stack} aria-hidden="true">
              <UsdtOnTron size={36} className={styles.laneToken} />
            </span>
            <span className={styles.laneRails}>
              <span className={styles.chainChip}>
                <TronMark size={14} />
                TRC20
              </span>
            </span>
          </span>
        ) : isAdmin ? (
          <button type="button" className={styles.laneAdd} onClick={() => onAdd('wallet')}>
            <PlusIcon />
            Add wallet
          </button>
        ) : null}
      </div>
    </section>
  );
}

function LaneState({ ready }: { ready: boolean }) {
  return (
    <span className={styles.laneState} data-ready={ready || undefined}>
      {ready ? <CheckIcon /> : <span className={styles.laneDot} aria-hidden="true" />}
      {ready ? 'Ready' : 'Not set up'}
    </span>
  );
}

function BankCard({ bank: b, onArchive }: { bank: ClientBankAccount; onArchive?: () => void }) {
  const name = `${b.bankName} •••• ${b.last4}`;
  return (
    <Instrument tint={bankTint(b.ifsc)} state={b.status.toLowerCase()}>
      <InstrumentTop
        mark={<BankMark ifsc={b.ifsc} name={b.bankName} />}
        title={b.bankName}
        sub={b.holderName}
        tag={
          b.status === 'PENDING_REVIEW' ? (
            <Tag tone="warning">Being checked</Tag>
          ) : b.status === 'REJECTED' ? (
            <Tag tone="danger">Not verified</Tag>
          ) : b.verified ? (
            <Tag tone="success">Verified</Tag>
          ) : null
        }
      />
      <div className={styles.figure}>
        <span className={styles.number}>
          <span className={styles.dots} aria-hidden="true">
            ••••
          </span>
          <span className="ix-visually-hidden">ending </span>
          {b.last4}
        </span>
        <span className={styles.figureMeta}>
          IFSC <span className="ix-num">{b.ifsc}</span>
        </span>
      </div>
      <div className={styles.foot}>
        <RailMarks rails={b.rails} />
        {onArchive ? <CardMenu label={name} items={[{ label: 'Archive', icon: <ArchiveIcon />, onSelect: onArchive, tone: 'danger' }]} /> : null}
      </div>
    </Instrument>
  );
}

const PURPOSE: Record<ClientWallet['purpose'], readonly ('in' | 'out')[]> = { DESTINATION: ['in'], SOURCE: ['out'], BOTH: ['in', 'out'] };

function WalletCard({ wallet: w, onArchive }: { wallet: ClientWallet; onArchive?: () => void }) {
  return (
    <Instrument tint={USDT_TINT} state={w.status.toLowerCase()}>
      <InstrumentTop
        mark={<UsdtOnTron size={44} />}
        title={w.label}
        sub="USDT on TRON · TRC20"
        tag={w.status === 'PENDING_REVIEW' ? <Tag tone="warning">Being checked</Tag> : w.status === 'REJECTED' ? <Tag tone="danger">Not verified</Tag> : null}
      />
      <div className={styles.figure}>
        <span className={styles.addressRow}>
          <span className={styles.address} title={w.address}>
            {shortenAddress(w.address, 6, 6)}
          </span>
          <span className="ix-visually-hidden"> full address {w.address}</span>
          <CopyButton value={w.address} label={`address of ${w.label}`} />
        </span>
      </div>
      <div className={styles.foot}>
        <span className={styles.purposes}>
          {PURPOSE[w.purpose].map((p) => (
            <span key={p} className={styles.purpose} data-way={p}>
              {p === 'in' ? <ArrowDownLeftIcon /> : <ArrowUpRightIcon />}
              {p === 'in' ? 'Receives USDT' : 'Sends USDT'}
            </span>
          ))}
        </span>
        {onArchive ? <CardMenu label={w.label} items={[{ label: 'Archive', icon: <ArchiveIcon />, onSelect: onArchive, tone: 'danger' }]} /> : null}
      </div>
    </Instrument>
  );
}
