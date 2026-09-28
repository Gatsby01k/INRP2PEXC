'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ClientDetail } from '@inrp2p/desk';
import { Button } from '@inrp2p/ui';
import { createRequestAction } from '../../../../server/actions/desk.ts';
import { useCommand } from '../../../../components/useCommand.tsx';
import { AmountField, RateField, Segments, SelectField } from '../../_desk/fields.tsx';
import { parseAmount } from '../../_desk/format.ts';
import { Notice } from '../../_desk/ui.tsx';
import d from '../../_desk/desk.module.css';

type Direction = 'SELL_USDT' | 'BUY_USDT';
type Fixed = 'BASE' | 'QUOTE';

/**
 * "Create quote" from the client book (UX_FLOWS §2): it opens the request the dealer would otherwise wait for, then
 * goes straight to the desk's quote builder for it. The desk never quotes without a request, because the request is
 * what records what the client actually asked for. Destinations are the client's ACTIVE ones only — the same list
 * acceptance will accept (S8).
 */
export function NewRequest({ client, prefill }: { client: ClientDetail; prefill?: { direction: Direction; amount: string } }) {
  const cmd = useCommand();
  const router = useRouter();
  const [direction, setDirection] = useState<Direction>(prefill?.direction ?? client.typicalDirection ?? 'SELL_USDT');
  const [fixed, setFixed] = useState<Fixed>('BASE');
  const [amount, setAmount] = useState(prefill?.amount ? trim(prefill.amount) : '');
  const [target, setTarget] = useState('');
  const [bankAccountId, setBankAccountId] = useState(client.bankAccounts[0]?.id ?? '');
  const [walletId, setWalletId] = useState(client.wallets[0]?.id ?? '');

  const sell = direction === 'SELL_USDT';
  const destinationMissing = sell ? bankAccountId === '' : walletId === '';
  const typed = parseAmount(amount, fixed === 'BASE' ? 'USDT' : 'INR');
  const ready = typed !== null && typed.isPositive() && !destinationMissing && !cmd.busy && client.status === 'ACTIVE';

  const submit = () => {
    if (!ready) return;
    void cmd
      .run(`Open a request for ${client.name}`, (key) =>
        createRequestAction(
          { clientId: client.clientId, direction, fixedSide: fixed, amount, ...(target ? { targetRate: target } : {}), ...(sell ? { bankAccountId } : { walletId }) },
          key,
        ),
      )
      .then((out) => {
        if (out.ok) router.push(`/?row=request:${out.result.requestId}&do=quote`);
        return out;
      });
  };

  return (
    <div className={d.stackTight} data-testid="new-request">
      <div className={d.row}>
        <Segments<Direction>
          label="Direction"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'SELL_USDT', label: 'Client sells USDT' },
            { value: 'BUY_USDT', label: 'Client buys USDT' },
          ]}
        />
        <Segments<Fixed>
          label="Fixed side"
          value={fixed}
          onChange={(v) => {
            setFixed(v);
            setAmount('');
          }}
          options={[
            { value: 'BASE', label: 'Fix USDT' },
            { value: 'QUOTE', label: 'Fix INR' },
          ]}
        />
      </div>
      <div className={d.formGrid}>
        <AmountField label={fixed === 'BASE' ? 'Amount (USDT)' : 'Amount (INR)'} currency={fixed === 'BASE' ? 'USDT' : 'INR'} value={amount} onChange={setAmount} onEnter={submit} />
        <RateField label="Target rate (optional)" value={target} onChange={setTarget} onEnter={submit} hint="What the client asked for, if they named one" />
      </div>
      {sell ? (
        <SelectField label="Pay INR to" value={bankAccountId} onChange={setBankAccountId} options={client.bankAccounts.map((b) => ({ value: b.id, label: `${b.label} · ${b.detail}` }))} />
      ) : (
        <SelectField label="Send USDT to" value={walletId} onChange={setWalletId} options={client.wallets.map((w) => ({ value: w.id, label: `${w.label} · ${w.detail}` }))} />
      )}
      {destinationMissing ? <Notice tone="warning">This client has no active {sell ? 'bank account' : 'wallet'} for that direction yet.</Notice> : null}
      {client.status !== 'ACTIVE' ? <Notice tone="danger">This client is suspended; the desk cannot open requests for them.</Notice> : null}
      <div className={d.actions}>
        <Button intent="primary" disabled={!ready} loading={cmd.busy} onClick={submit}>
          Create request and quote
        </Button>
        <span className={d.fieldHint}>Opens the quote builder on the desk with this request.</span>
      </div>
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}

/** "100000.000000" → "100000": a repeat starts from the amount as a dealer would type it. */
function trim(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
