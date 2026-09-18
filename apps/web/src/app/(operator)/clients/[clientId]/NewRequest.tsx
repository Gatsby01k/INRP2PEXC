'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClientDetail } from '@inrp2p/desk';
import { Button, DirectionToggle, MoneyInput } from '@inrp2p/ui';
import { createRequestAction } from '../../../../server/actions/desk.ts';
import { useCommand } from '../../../../components/useCommand.tsx';
import styles from '../clients.module.css';

/**
 * "Create quote" from the client book (UX_FLOWS §2). It opens the request the dealer would otherwise wait for,
 * then sends them straight to the desk's quote builder for it — the desk never quotes without a request, because
 * the request is what records what the client actually asked for.
 */
export function NewRequest({ client, prefill }: { client: ClientDetail; prefill?: { direction: 'SELL_USDT' | 'BUY_USDT'; amount: string } }) {
  const cmd = useCommand();
  const router = useRouter();
  const [direction, setDirection] = useState<'SELL_USDT' | 'BUY_USDT'>(prefill?.direction ?? 'SELL_USDT');
  const [amount, setAmount] = useState(prefill?.amount ?? '');
  const [target, setTarget] = useState('');
  const [bankAccountId, setBankAccountId] = useState(client.bankAccounts[0]?.id ?? '');
  const [walletId, setWalletId] = useState(client.wallets[0]?.id ?? '');

  const destinationMissing = direction === 'SELL_USDT' ? bankAccountId === '' : walletId === '';

  return (
    <section className="ix-card" data-testid="new-request">
      <h2 className="ix-sectionTitle">New request</h2>
      <div className={styles.form}>
        <DirectionToggle value={direction} onChange={setDirection} />
        <MoneyInput label="Amount (USDT)" currency="USDT" value={amount} onChange={setAmount} />
        <MoneyInput label="Target rate (optional)" currency="INR" value={target} onChange={setTarget} hint="What the client asked for" />

        {direction === 'SELL_USDT' ? (
          <div className="ix-field">
            <label htmlFor="dest-bank">Pay to</label>
            <select id="dest-bank" className="ix-input" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              {client.bankAccounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.detail}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="ix-field">
            <label htmlFor="dest-wallet">Send to</label>
            <select id="dest-wallet" className="ix-input" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
              {client.wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.detail}
                </option>
              ))}
            </select>
          </div>
        )}

        {destinationMissing ? <p className="ix-muted">This client has no active destination for that direction yet.</p> : null}

        <Button
          intent="primary"
          disabled={amount === '' || destinationMissing || cmd.busy}
          onClick={() =>
            cmd
              .run(`Open a request for ${client.name}`, (key) =>
                createRequestAction(
                  {
                    clientId: client.clientId,
                    direction,
                    fixedSide: 'BASE',
                    amount,
                    ...(target ? { targetRate: target } : {}),
                    ...(direction === 'SELL_USDT' ? { bankAccountId } : { walletId }),
                  },
                  key,
                ),
              )
              .then((out) => {
                if (out.ok) router.push(`/?row=request:${out.result.requestId}&do=quote`);
                return out;
              })
          }
        >
          Create request and quote
        </Button>
      </div>
      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </section>
  );
}
