import type { CSSProperties, ReactNode } from 'react';
import { Money, Rate } from '@inrp2p/kernel';
import { Button, FirmQuote } from '@inrp2p/ui';
import link from '../../src/app/q/[token]/link.module.css';
import { AT, DURATION, HELD_RATE, HOOK_MESSAGES as MESSAGES, HOOK_SHOUTS, TRADE, illustrative, inOut, out, outExpo, productEase, span } from './score.ts';
import styles from './held.module.css';

/**
 * Everything in HELD that is drawn by the page rather than the 3D world: the chat that opens the film, the word
 * HELD, the two product moments (the quote on a phone, locked and accepted; the bank's message that the money has
 * arrived), the mark, and the last card. Each is a function of the film's time and nothing else.
 */

/** The supplied mark, exactly as supplied. */
const MARK = new URL('../../../../brand/inrp2p-mark-1024.png', import.meta.url).href;

export interface Registration {
  /** Where the chest's arcs were on screen at the cut: the logo's arcs are placed exactly there. */
  readonly mark: { readonly x: number; readonly y: number; readonly r: number } | null;
  /** Where the mark comes to rest on the last card, as laid out (`data-film="lockup"`). */
  readonly lockup: { readonly x: number; readonly y: number; readonly size: number } | null;
}

// ——— the hook ————————————————————————————————————————————————————————————————————————————————————————

function priceAt(t: number, i: number): string {
  const tick = Math.floor(t * 14) + i * 7;
  const h = Math.sin(tick * 12.9898 + i) * 43758.5453;
  return `₹${(98.5 + (h - Math.floor(h)) * 6).toFixed(2)}`;
}

function Hook({ t }: { t: number }) {
  // After the chat has piled up, the whole screen starts to turn and close in, faster, until the cut.
  const spin = span(t, 3.1, AT.hookEnd);
  const angle = spin ** 2.2 * 38;
  const zoom = 1 + spin ** 2 * 0.55;
  const shake = spin > 0 ? spin * 7 : 0;
  const sx = Math.sin(t * 97) * shake;
  const sy = Math.cos(t * 83) * shake;
  const blur = spin ** 2 * 3.2;
  return (
    <div className={styles.hook}>
      <div className={styles.hookSpin} style={{ transform: `translate(${sx}px, ${sy}px) rotate(${angle}deg) scale(${zoom})`, filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined }}>
        {MESSAGES.filter((m) => t >= m.at).map((m, i) => {
          const pop = productEase(span(t, m.at, m.at + 0.16));
          const style: CSSProperties = {
            left: `${m.x * 100}%`,
            top: `${m.y * 100}%`,
            fontSize: `${m.size}px`,
            transform: `rotate(${m.tilt}deg) scale(${0.86 + 0.14 * pop})`,
            opacity: pop,
          };
          return (
            <div key={i} className={styles.bubble} data-mine={m.mine || undefined} style={style}>
              <span>{m.price ? priceAt(t, i) : m.text}</span>
              <time>{m.time}</time>
            </div>
          );
        })}
        {/* Near the end the words stop being messages and become the noise itself. */}
        {HOOK_SHOUTS.filter((w) => t >= w.at)
          .map((w) => (
            <p key={w.text} className={styles.shout} style={{ top: `${w.y * 100}%`, opacity: 0.9 * productEase(span(t, w.at, w.at + 0.1)) }}>
              {w.text}
            </p>
          ))}
      </div>
    </div>
  );
}

// ——— HELD. ——————————————————————————————————————————————————————————————————————————————————————————

function HeldCard({ t }: { t: number }) {
  const k = span(t, AT.held, AT.ringClose);
  return (
    <div className={styles.heldCard}>
      <p className={styles.held} style={{ transform: `scale(${1 + 0.035 * k})` }}>
        HELD<span className={styles.heldDot}>.</span>
      </p>
    </div>
  );
}

// ——— the phone ————————————————————————————————————————————————————————————————————————————————————————

function Device({ children }: { children: ReactNode }) {
  return (
    <div className={styles.device}>
      <div className={styles.screen}>{children}</div>
      <div className={styles.glass} />
    </div>
  );
}

const QUOTED_AT = Date.parse('2026-09-16T10:41:00Z');
const HELD_MS = 180_000;

/** The private quote, as the client opens it from a chat: locked, counting down, and then accepted. */
function QuotePhone({ t }: { t: number }) {
  const accepted = t >= AT.accepted;
  // The quote has been held for a second when the film cuts to it; its clock runs until it is accepted.
  const now = new Date(QUOTED_AT + 1000 + (Math.min(t, AT.accepted) - AT.phone) * 1000);
  const tap = span(t, AT.tap, AT.tap + 0.45);
  return (
    <div className={styles.phoneScene} data-scene="quote">
      <div className={styles.phoneCamera} data-film="phone-camera">
        <Device>
          <div className={link.page} style={{ minHeight: '100%' }}>
            <div className={link.card}>
              <p className={link.brand}>INRP2P Exchange · Private quote QT-260916-0006</p>
              <FirmQuote
                state={accepted ? 'ACCEPTED' : 'LOCKED'}
                direction="SELL_USDT"
                base={Money.parse(TRADE.usdt, 'USDT')}
                inr={Money.parse(TRADE.inr, 'INR')}
                rate={Rate.parse(HELD_RATE, 'CLIENT')}
                network="TRC20"
                destinationLabel="Your bank •••• 8219"
                expiresAt={new Date(QUOTED_AT + HELD_MS)}
                validityMs={HELD_MS}
                now={now}
                settlementNote="INR to your registered bank account"
                onAccept={() => {}}
              />
              {accepted ? null : (
                <Button intent="ghost" size="sm">
                  I already have a code
                </Button>
              )}
            </div>
          </div>
          {tap > 0 && tap < 1 ? <span className={styles.touch} data-film="touch" style={{ opacity: 1 - tap, transform: `translate(-50%, -50%) scale(${0.6 + tap * 0.9})` }} /> : null}
        </Device>
      </div>
    </div>
  );
}

// ——— the mark, and the last card ——————————————————————————————————————————————————————————————————————————

/** The arcs' centre and centre-line radius in the supplied 1024-pixel mark, measured from the file. */
const LOGO_ARCS = { x: 511.5, y: 514.5, r: 330 };

function Finale({ t, registration }: { t: number; registration: Registration }) {
  // From the chest's arcs, full frame, to the mark at the head of the card. The mark is drawn on its own field, and
  // the card is that field: nothing changes colour, the mark only comes to rest.
  const end = registration.lockup ?? { x: 872, y: 150, size: 176 };
  const start = registration.mark ?? { x: 960, y: 540, r: 250 };
  const k = inOut(span(t, AT.logo + 0.15, AT.card));
  const s0 = start.r / LOGO_ARCS.r;
  const s1 = end.size / 1024;
  const scale = s0 * (s1 / s0) ** k;
  const cx0 = start.x - (LOGO_ARCS.x - 512) * s0;
  const cy0 = start.y - (LOGO_ARCS.y - 512) * s0;
  const cx = cx0 + (end.x + end.size / 2 - cx0) * k;
  const cy = cy0 + (end.y + end.size / 2 - cy0) * k;
  const rise = (at: number, by = 18) => {
    const e = out(span(t, at, at + 0.6));
    return { opacity: e, transform: `translateY(${(1 - e) * by}px)` };
  };
  // Held, the card breathes in by a hair: alive, not moving.
  const breathe = 1 + 0.018 * span(t, AT.card, DURATION);
  return (
    <div className={styles.finale}>
      <div className={styles.breathe} style={{ transform: `scale(${breathe})` }}>
      <div className={styles.card}>
        <span className={styles.lockupSpace} data-film="lockup" aria-hidden="true" />
        <p className={styles.name} style={rise(AT.card - 0.1, 10)}>
          INRP2P Exchange
        </p>
        <p className={styles.line} style={rise(AT.card + 0.1)}>
          The market moves.
        </p>
        <p className={`${styles.line} ${styles.lineStrong}`} style={rise(AT.card + 0.3)}>
          Your rate doesn’t.
        </p>
        <span className={styles.cta} style={rise(AT.card + 0.6, 12)}>
          Request a quote <span aria-hidden="true">→</span>
        </span>
      </div>
      <img
        src={MARK}
        alt=""
        className={styles.mark}
        style={{ transform: `translate(${cx - 512 * scale}px, ${cy - 512 * scale}px) scale(${scale})` }}
      />
      </div>
    </div>
  );
}

// ——— the page ———————————————————————————————————————————————————————————————————————————————————————————

export function Overlay({ t, registration }: { t: number; registration: Registration }) {
  const tag = illustrative(t);
  let scene: ReactNode = null;
  if (t < AT.hookEnd) scene = <Hook t={t} />;
  else if (t >= AT.held && t < AT.ringClose) scene = <HeldCard t={t} />;
  else if (t >= AT.phone && t < AT.resume) scene = <QuotePhone t={t} />;
  else if (t >= AT.logo) scene = <Finale t={t} registration={registration} />;
  const flash = outExpo(1 - span(t, AT.snap, AT.snap + 0.22)) * (t >= AT.snap ? 1 : 0);
  return (
    <>
      {scene}
      {flash > 0.01 && t < AT.frozen ? <div className={styles.flash} style={{ opacity: flash * 0.3 }} /> : null}
      {tag ? (
        <p className={styles.tag}>
          Illustrative
        </p>
      ) : null}
    </>
  );
}
