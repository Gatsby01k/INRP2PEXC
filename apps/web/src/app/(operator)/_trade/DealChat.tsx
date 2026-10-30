'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { DeskTrade } from '@inrp2p/desk';
import { Button } from '@inrp2p/ui';
import { postDeskDealMessageAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { Ago } from '../_desk/clock.tsx';
import { TextArea } from '../_desk/fields.tsx';
import { time } from '../_desk/format.ts';
import { Chip, Notice } from '../_desk/ui.tsx';
import type { TradePerms } from './types.ts';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

type Chat = NonNullable<DeskTrade['chat']>;

/**
 * A P2P deal's chat as INRP2P's people work it (ADR 0023): every message with who wrote it, the files each side
 * attached, and — when a side called support — that it is waiting. An operator who works cases answers here; the first
 * answer tells both sides INRP2P joined. Deciding the payment stays where it was (P2P payment): never a message.
 */
export function DeskDealChat({ trade, perms }: { trade: DeskTrade; perms: TradePerms }) {
  const cmd = useCommand();
  const [body, setBody] = useState('');
  const thread = useRef<HTMLOListElement>(null);
  const chat = trade.chat;
  const count = chat?.messages.length ?? 0;
  useLayoutEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [count]);
  if (!chat || !perms.openException) return null;
  // Nothing said and nobody asking: the panel waits until a side writes.
  if (count === 0 && !chat.support) return null;

  const side = (a: Chat['messages'][number]['author']) => (a === 'INRP2P' ? 'INRP2P' : a === 'CLIENT' ? `Client · ${chat.clientIs.toLowerCase()}` : `Trader · ${chat.clientIs === 'BUYER' ? 'seller' : 'buyer'}`);
  const send = () =>
    cmd.run('Message sent to the deal’s chat', (key) => {
      const form = new FormData();
      form.set('tradeId', trade.tradeId);
      form.set('key', key);
      form.set('body', body.trim());
      return postDeskDealMessageAction(form);
    });

  return (
    <PanelSection
      title={chat.support && !chat.support.joined ? 'Support called to the deal chat' : 'Deal chat'}
      aside={chat.support ? chat.support.ref : `${count} message${count === 1 ? '' : 's'}`}
      testId="deal-chat"
      {...(chat.support && !chat.support.joined ? { tone: 'danger' as const } : {})}
    >
      <div className={d.stack}>
        {chat.support ? (
          <Notice tone={chat.support.joined ? 'brand' : 'warning'} icon="flag">
            {chat.support.joined ? 'INRP2P answered. Close the case once the question is settled.' : <>A side asked for support <Ago at={chat.support.calledAt} />. Answer here — both sides see it.</>}
          </Notice>
        ) : null}
        <ol ref={thread} className={t.chatThread} aria-label="Deal chat">
          {chat.messages.map((m) => (
            <li key={m.id} className={t.chatMessage} data-author={m.author.toLowerCase()}>
              <span className={t.chatMeta}>
                <strong>{side(m.author)}</strong> · {m.person} · {time(m.at)}
                {m.kind === 'RECEIPT' ? <Chip tone="neutral">receipt {m.paymentRef}</Chip> : null}
                {m.kind === 'SUPPORT_CALLED' ? <Chip tone="warning">called support</Chip> : null}
              </span>
              {m.file ? (
                <a className={d.link} href={`/api/deal-files/${m.file.id}`} target="_blank" rel="noreferrer noopener">
                  {m.file.name}
                </a>
              ) : null}
              {m.body && m.kind !== 'SUPPORT_JOINED' ? <p className={t.disputeNote}>{m.body}</p> : null}
            </li>
          ))}
        </ol>
        {trade.lifecycle === 'COMPLETED' || trade.lifecycle === 'CANCELLED' ? null : (
          <Notice icon="shield">A screenshot in the chat is the payer’s, not the payee’s bank. Decide a payment only from the payee’s side (P2P payment).</Notice>
        )}
        <TextArea label="Write to both sides" value={body} onChange={setBody} rows={2} placeholder="Both the client and the trader see this, signed INRP2P support." />
        <div className={d.actions}>
          <Button intent="primary" size="sm" disabled={cmd.busy || body.trim() === ''} aria-busy={cmd.busy || undefined} onClick={() => void send().then((out) => out.ok && setBody(''))}>
            Send
          </Button>
        </div>
        {cmd.error ? (
          <Notice tone="danger" role="alert">
            {cmd.error}
          </Notice>
        ) : null}
      </div>
      {cmd.dialog}
    </PanelSection>
  );
}
