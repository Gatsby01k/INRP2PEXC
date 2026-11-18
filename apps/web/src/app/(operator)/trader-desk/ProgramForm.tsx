'use client';

import { useId, useState, type ReactNode } from 'react';
import { DEFAULT_RISK_POLICY, type RiskPolicy, TIER_NAMES } from '@inrp2p/kernel';
import type { DeskProgram } from '@inrp2p/traders';
import { Button, StepUpMark } from '@inrp2p/ui';
import { configureProgramAction } from '../../../server/actions/traders-desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { RailMark } from '../../../components/PayMarks.tsx';
import { TextArea, TextField } from '../_desk/fields.tsx';
import { plainDecimal } from '../_desk/format.ts';
import { Notice } from '../_desk/ui.tsx';
import { Sheet, bookStyles as b } from '../_book/parts.tsx';
import d from '../_desk/desk.module.css';

const RAILS = ['UPI', 'IMPS', 'NEFT', 'RTGS'] as const;
type Rail = (typeof RAILS)[number];
const TIER_LABEL = { NEW: 'New', PROVEN: 'Proven', TRUSTED: 'Trusted' } as const;
type TierField = 'minDeals' | 'minDays' | 'dealX' | 'openX';
const tierText = (p: RiskPolicy) => p.tiers.map((t) => ({ minDeals: String(t.minDeals), minDays: String(t.minDays), dealX: String(t.dealX), openX: String(t.openX) }));

/** A setting that is on or off, said as what it does — a switch, not a checkbox lost at the end of a sentence. */
function Switch({ title, body, checked, onChange, disabled }: { title: string; body: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  const id = useId();
  return (
    <div className={b.switchRow}>
      <label htmlFor={id} className={b.switchText}>
        <strong>{title}</strong>
        <span>{body}</span>
      </label>
      <input id={id} type="checkbox" role="switch" className={b.switch} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

/** One small number in a matrix, named for a screen reader by its row and column. */
function Cell({ label, value, onChange, disabled }: { label: string; value: string; onChange?: (v: string) => void; disabled?: boolean }) {
  return (
    <td>
      <input aria-label={label} inputMode="numeric" value={value} disabled={disabled || !onChange} onChange={(e) => onChange?.(e.target.value)} />
    </td>
  );
}

/**
 * The programme settings (`traders:configure`, ⧗), grouped by what they decide: who gets approved, how requests reach a
 * trader, how far a trader's reserve carries it, and how long each step of a deal may take. Nothing here has a default
 * that stands in for a decision: the Security Reserve stays unset until someone sets it, and every change is audited with
 * its reason — given once, in the bar that saves them all.
 */
export function ProgramForm({ program, canConfigure }: { program: DeskProgram; canConfigure: boolean }) {
  const cmd = useCommand();
  const [reserve, setReserve] = useState(plainDecimal(program.defaultRequiredReserve));
  const [offer, setOffer] = useState(String(program.offerTtlSeconds));
  const [hold, setHold] = useState(String(program.holdTtlSeconds));
  const [auto, setAuto] = useState(program.autoAssign);
  const [timing, setTiming] = useState(() => ({
    escrowMinutes: String(program.p2pTiming.escrowMinutes),
    finalMinutes: String(program.p2pTiming.finalMinutes),
    pay: Object.fromEntries(RAILS.map((r) => [r, String(program.p2pTiming.pay[r])])) as Record<Rail, string>,
    receipt: Object.fromEntries(RAILS.map((r) => [r, String(program.p2pTiming.receipt[r])])) as Record<Rail, string>,
  }));
  const [autoReview, setAutoReview] = useState(program.autoReview);
  const [holdHours, setHoldHours] = useState(String(program.settlementChangeHoldHours));
  const [limitsOn, setLimitsOn] = useState(program.riskPolicy !== null);
  const [tiers, setTiers] = useState(() => tierText(program.riskPolicy ?? DEFAULT_RISK_POLICY));
  const [cleanDays, setCleanDays] = useState(String((program.riskPolicy ?? DEFAULT_RISK_POLICY).cleanDays));
  const [reason, setReason] = useState('');
  const minutes = (v: string) => Number.parseInt(v, 10);
  const setTier = (i: number, f: TierField, v: string) => setTiers((all) => all.map((t, j) => (j === i ? { ...t, [f]: v } : t)));
  const riskPolicy = (): RiskPolicy | null => {
    if (!limitsOn) return null;
    const n = (v: string) => Number(v.trim());
    const [a, c2, c3] = tiers.map((t) => ({ minDeals: n(t.minDeals), minDays: n(t.minDays), dealX: n(t.dealX), openX: n(t.openX) }));
    return { cleanDays: n(cleanDays), tiers: [a!, c2!, c3!] };
  };
  const off = !canConfigure;

  const save = () =>
    cmd.run('Save trader programme', (key) =>
      configureProgramAction(
        {
          expectedVersion: program.version,
          defaultRequiredReserve: reserve.trim() === '' ? null : reserve.trim(),
          offerTtlSeconds: Number.parseInt(offer, 10),
          holdTtlSeconds: Number.parseInt(hold, 10),
          autoAssign: auto,
          p2pTiming: {
            escrowMinutes: minutes(timing.escrowMinutes),
            finalMinutes: minutes(timing.finalMinutes),
            pay: { UPI: minutes(timing.pay.UPI), IMPS: minutes(timing.pay.IMPS), NEFT: minutes(timing.pay.NEFT), RTGS: minutes(timing.pay.RTGS) },
            receipt: { UPI: minutes(timing.receipt.UPI), IMPS: minutes(timing.receipt.IMPS), NEFT: minutes(timing.receipt.NEFT), RTGS: minutes(timing.receipt.RTGS) },
          },
          autoReview,
          settlementChangeHoldHours: Number.parseInt(holdHours, 10),
          riskPolicy: riskPolicy(),
          reason,
        },
        key,
      ),
    );

  return (
    <form
      className={d.stack}
      aria-label="Programme"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={b.programme}>
        <Sheet title="Approvals" hint="Who becomes a trader, and what they must hold.">
          <Switch
            title="Approve traders by rule"
            body="Wallet proven by the reserve sent from it, bank holder is the applicant and on no other file, reserve funded. Anything else waits for a person."
            checked={autoReview}
            onChange={setAutoReview}
            disabled={off}
          />
          <div className={b.grid2}>
            <TextField label="Default Security Reserve (USDT)" value={reserve} onChange={setReserve} placeholder="Not set" disabled={off} hint="Offered at approval; each trader’s own can differ." />
            <TextField label="New bank or wallet waits (h)" value={holdHours} onChange={setHoldHours} disabled={off} hint="Every member is told and can stop it; then it applies between orders." />
          </div>
        </Sheet>

        <Sheet title="Routing" hint="How a request reaches a trader, and how long it is held.">
          <Switch title="Route requests automatically" body="New USDT-fixed requests go to a trader without a person choosing one." checked={auto} onChange={setAuto} disabled={off} />
          <div className={b.grid2}>
            <TextField label="Offer time (s)" value={offer} onChange={setOffer} disabled={off} hint="How long a trader has to take an offer." />
            <TextField label="Hold time (s)" value={hold} onChange={setHold} disabled={off} hint="How long an accepted order holds the request." />
          </div>
        </Sheet>

        <Sheet title="Limits from the reserve" hint="Multiples of a trader’s free reserve, in USDT. The desk’s own ceilings on a trader still apply.">
          <fieldset className={d.stackTight} disabled={off} aria-label="Reserve-based limits" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <Switch title="Limit deals by reserve and record" body="A trader moves up a level after enough clean deals and days; a failed deal puts it back to New." checked={limitsOn} onChange={setLimitsOn} disabled={off} />
            {limitsOn ? (
              <>
                <table className={b.matrix} aria-label="Levels">
                  <thead>
                    <tr>
                      <th />
                      <th scope="col">One deal ×</th>
                      <th scope="col">Open deals ×</th>
                      <th scope="col">After deals</th>
                      <th scope="col">After days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TIER_NAMES.map((name, i) => (
                      <tr key={name}>
                        <th scope="row">{TIER_LABEL[name]}</th>
                        <Cell label={`${TIER_LABEL[name]}: one deal ×`} value={tiers[i]!.dealX} onChange={(v) => setTier(i, 'dealX', v)} />
                        <Cell label={`${TIER_LABEL[name]}: open deals ×`} value={tiers[i]!.openX} onChange={(v) => setTier(i, 'openX', v)} />
                        {i === 0 ? (
                          <>
                            <Cell label="New: after deals" value="0" />
                            <Cell label="New: after days" value="0" />
                          </>
                        ) : (
                          <>
                            <Cell label={`${TIER_LABEL[name]}: after deals`} value={tiers[i]!.minDeals} onChange={(v) => setTier(i, 'minDeals', v)} />
                            <Cell label={`${TIER_LABEL[name]}: after days`} value={tiers[i]!.minDays} onChange={(v) => setTier(i, 'minDays', v)} />
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className={b.grid2}>
                  <TextField label="Back to New after a failed deal (days)" value={cleanDays} onChange={setCleanDays} hint="A dispute lost, or an escrow unwound because it did not pay." />
                </div>
              </>
            ) : null}
          </fieldset>
        </Sheet>

        <Sheet title="Deal times" hint="Minutes. A running deal keeps the times it opened with.">
          <fieldset className={d.stackTight} disabled={off} aria-label="P2P deal times" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <table className={b.matrix} aria-label="Minutes by rail">
              <thead>
                <tr>
                  <th />
                  <th scope="col">Buyer pays</th>
                  <th scope="col">Seller confirms</th>
                </tr>
              </thead>
              <tbody>
                {RAILS.map((r) => (
                  <tr key={r}>
                    <th scope="row">
                      <RailMark rail={r} />
                    </th>
                    <Cell label={`Buyer pays by ${r}`} value={timing.pay[r]} onChange={(v) => setTiming((t) => ({ ...t, pay: { ...t.pay, [r]: v } }))} />
                    <Cell label={`Seller confirms ${r}`} value={timing.receipt[r]} onChange={(v) => setTiming((t) => ({ ...t, receipt: { ...t.receipt, [r]: v } }))} />
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={d.fieldHint}>The buyer’s time runs from the escrow being final; then the seller confirms and INRP2P checks — never cancelled after that.</p>
            <div className={b.grid2}>
              <TextField label="Final period" value={timing.finalMinutes} onChange={(v) => setTiming((t) => ({ ...t, finalMinutes: v }))} hint="After the buyer is warned, before a cancel." />
              <TextField label="Trader funds a BUY’s escrow" value={timing.escrowMinutes} onChange={(v) => setTiming((t) => ({ ...t, escrowMinutes: v }))} hint="From the trade opening." />
            </div>
          </fieldset>
        </Sheet>
      </div>

      {canConfigure ? (
        <div className={b.saveBar}>
          <TextArea label="Reason for the change" value={reason} onChange={setReason} rows={1} placeholder="Kept with every setting this saves" />
          <Button intent="primary" type="submit" disabled={cmd.busy || reason.trim().length < 3} shortcut={<StepUpMark label="needs your authenticator code" />}>
            Save programme
          </Button>
        </div>
      ) : (
        <Notice icon="lock">Changing the programme needs traders:configure.</Notice>
      )}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </form>
  );
}
