'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DealChatMessage, DealChatView } from '@inrp2p/settlement';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { type ActionResult, useCommand } from '../../../components/useCommand.tsx';
import { ATTACH_ACCEPT, fileSize, prepareAttachment } from './attach.ts';
import { RobotSays } from '../_robot/RobotSays.tsx';
import { chatRisk, chatRiskSpeech } from '../_robot/speech.ts';
import { ChatIcon, CloseIcon, PaperclipIcon, ReceiptIcon, SendIcon, ShieldIcon, SupportIcon } from './icons.tsx';
import shell from '../shell.module.css';
import styles from './deal-chat.module.css';

/**
 * A P2P deal's chat (ADR 0023), the same for the client and the trader: the other side by its role only, INRP2P when
 * someone calls it in, and the receipts either side attaches. Beside the deal's own card, never inside it — the escrow
 * and the payment are told there, by the server, and nothing written here moves either.
 *
 * `fields` names the deal for the action (the client's trade reference, or the trader's order reference); the chat adds
 * the words, the file and one key per press.
 */
export function DealChat({
  chat,
  fields,
  send,
  callSupport,
}: {
  chat: DealChatView;
  fields: Readonly<Record<string, string>>;
  send: (form: FormData) => Promise<ActionResult<{ id: string }>>;
  callSupport: (note: string | null, key: string) => Promise<ActionResult<{ ref: string; called: boolean }>>;
}) {
  const cmd = useCommand();
  const support = useCommand();
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const thread = useRef<HTMLOListElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);
  const other = chat.you === 'BUYER' ? 'seller' : 'buyer';
  const count = chat.messages.length;
  // The robot guards the chat (ADR 0034 addendum): the other side's latest message that moves the deal off INRP2P or asks
  // to cancel it gets one remark under it, and so does the person's own draft before it is sent. A warning, never a block.
  const flagged = chat.messages.findLast((m) => (m.from === 'BUYER' || m.from === 'SELLER') && m.body !== null && chatRisk(m.body) !== null);
  const draftRisk = body.trim().length > 0 ? chatRisk(body) : null;

  // Follow the conversation as it grows — unless the reader scrolled up to read something earlier.
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  useEffect(() => {
    const el = thread.current;
    if (!el) return;
    const onScroll = () => {
      nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const pick = async (f: File | undefined) => {
    setFileError(null);
    if (!f) return;
    const ready = await prepareAttachment(f);
    if (ready.ok) setFile(ready.file);
    else setFileError(ready.error);
  };

  const submit = async () => {
    const text = body.trim();
    if ((!text && !file) || cmd.busy) return;
    nearBottom.current = true;
    const out = await cmd.run(file ? 'File sent' : 'Message sent', (key) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      form.set('key', key);
      if (text) form.set('body', text);
      if (file) form.set('file', file);
      return send(form);
    });
    if (out.ok) {
      setBody('');
      setFile(null);
    }
  };

  const ask = async () => {
    const out = await support.run('INRP2P support called', (key) => callSupport(note.trim() || null, key));
    if (out.ok) {
      setAsking(false);
      setNote('');
    }
  };

  return (
    <section id="deal-chat" className={`${shell.card} ${styles.chat}`} aria-labelledby="deal-chat-title">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 id="deal-chat-title" className={styles.title}>
            <span className={styles.titleTile} aria-hidden="true">
              <ChatIcon className={styles.titleIcon} />
            </span>
            <span className={styles.titleWords}>
              Chat with the {other}
            </span>
          </h2>
        </div>
        {chat.support === 'NONE' ? (
          chat.canPost ? (
            <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => setAsking((v) => !v)} aria-expanded={asking} title="Call INRP2P support into this chat">
              <SupportIcon />
              Support
            </button>
          ) : null
        ) : (
          <span className={styles.supportPill} data-state={chat.support.toLowerCase()} role="status">
            <ShieldIcon />
            {chat.support === 'JOINED' ? 'INRP2P support is here' : 'Support is on the way'}
          </span>
        )}
      </div>

      {asking ? (
        <div className={styles.ask}>
          <label className={styles.askField}>
            <span className={styles.askLabel}>What should INRP2P look at? (optional)</span>
            <textarea className={styles.askInput} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The amount I see is different" />
          </label>
          <div className={styles.askRow}>
            <button type="button" className={shell.action} data-size="sm" disabled={support.busy} aria-busy={support.busy || undefined} onClick={() => void ask()}>
              Call INRP2P support
            </button>
            <button type="button" className={shell.textAction} onClick={() => setAsking(false)}>
              Not now
            </button>
          </div>
          <p className={styles.askHint}>Support joins this chat. The deal and its times go on; to stop the escrow, say the money did not arrive.</p>
          {support.error ? (
            <p className={shell.error} role="alert">
              {support.error}
            </p>
          ) : null}
        </div>
      ) : null}

      <ol ref={thread} className={styles.thread} aria-label={`Messages with the ${other}`} aria-live="polite" tabIndex={0}>
        {/* The one rule of the chat stays at its top, above whatever is said. Only the people in the deal and INRP2P see it. */}
        <li className={styles.empty}>
          <ShieldIcon />
          <span>Never share an OTP, PIN or password.</span>
        </li>
        {chat.messages.map((m) => (
          <Fragment key={m.id}>
            <Message m={m} other={other} />
            {m === flagged ? (
              <li className={styles.robotNote}>
                <RobotSays speech={chatRiskSpeech(chatRisk(m.body!)!, 'them', other)} variant="sheet" live={false} />
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>

      {chat.canPost ? (
        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {file || fileError ? (
            <div className={styles.attached} data-tone={fileError ? 'warning' : undefined}>
              {file ? (
                <>
                  <PaperclipIcon className={styles.attachedIcon} />
                  <span className={styles.attachedName}>{file.name}</span>
                  <span className={styles.attachedSize}>{fileSize(file.size)}</span>
                  <button type="button" className={styles.iconButton} onClick={() => setFile(null)} aria-label="Remove the file">
                    <CloseIcon />
                  </button>
                </>
              ) : (
                <span>{fileError}</span>
              )}
            </div>
          ) : null}
          {draftRisk ? <RobotSays speech={chatRiskSpeech(draftRisk, 'you', other)} variant="sheet" className={styles.robotDraft} /> : null}
          <div className={styles.compose}>
            <button type="button" className={styles.iconButton} onClick={() => picker.current?.click()} aria-label="Attach a receipt or screenshot" title="Attach a receipt or screenshot">
              <PaperclipIcon />
            </button>
            <input
              ref={picker}
              type="file"
              accept={ATTACH_ACCEPT}
              hidden
              onChange={(e) => {
                void pick(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <textarea
              className={styles.input}
              rows={1}
              maxLength={2000}
              value={body}
              placeholder={`Message the ${other}`}
              aria-label={`Message the ${other}`}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends on a keyboard; on a phone it is a new line, and the button sends.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button type="submit" className={styles.send} disabled={cmd.busy || (!body.trim() && !file)} aria-busy={cmd.busy || undefined} aria-label="Send">
              <SendIcon />
            </button>
          </div>
          {cmd.error ? (
            <p className={shell.error} role="alert">
              {cmd.error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className={styles.closed}>This deal closed more than a week ago; its chat is kept as it was.</p>
      )}
      {cmd.dialog}
      {support.dialog}
    </section>
  );
}

const WHO: Record<DealChatMessage['from'], string> = { YOU: 'You', BUYER: 'Buyer', SELLER: 'Seller', INRP2P: 'INRP2P support' };

function Message({ m, other }: { m: DealChatMessage; other: 'buyer' | 'seller' }) {
  const time = formatIstDateTime(new Date(m.at)).split(', ')[1];
  if (m.kind === 'SUPPORT_JOINED' || m.kind === 'SUPPORT_CALLED') {
    return (
      <li className={styles.event}>
        <ShieldIcon className={styles.eventIcon} />
        <span>
          {m.kind === 'SUPPORT_JOINED' ? 'INRP2P support joined' : `${m.from === 'YOU' ? 'You' : `The ${other}`} called INRP2P support`}
          {m.kind === 'SUPPORT_CALLED' && m.body && !/asked INRP2P support to join\.$/.test(m.body) ? `: “${m.body}”` : ''}
        </span>
        <time dateTime={m.at}>{time}</time>
      </li>
    );
  }
  return (
    <li className={styles.message} data-from={m.from === 'YOU' ? 'you' : m.from === 'INRP2P' ? 'inrp2p' : 'them'}>
      <span className={styles.who}>{WHO[m.from]}</span>
      <div className={styles.bubble}>
        {m.kind === 'RECEIPT' ? (
          <span className={styles.receiptTag}>
            <ReceiptIcon />
            Payment receipt{m.paymentRef ? ` · ${m.paymentRef}` : ''}
          </span>
        ) : null}
        {m.file ? <Attachment file={m.file} /> : null}
        {m.body ? <p className={styles.text}>{m.body}</p> : null}
        {m.kind === 'RECEIPT' && m.from !== 'YOU' ? <p className={styles.caution}>A screenshot is not a payment. Check your bank app before you confirm.</p> : null}
      </div>
      <time className={styles.time} dateTime={m.at}>
        {time}
      </time>
    </li>
  );
}

function Attachment({ file }: { file: NonNullable<DealChatMessage['file']> }) {
  const href = `/api/deal-files/${file.id}`;
  if (file.type.startsWith('image/')) {
    return (
      <a className={styles.image} href={href} target="_blank" rel="noreferrer noopener" aria-label={`Open ${file.name}`}>
        {/* A private file, served with its own headers: never through an image optimiser. */}
        <img src={href} alt={file.name} loading="lazy" />
      </a>
    );
  }
  return (
    <a className={styles.document} href={href} rel="noreferrer noopener" download={file.name}>
      <ReceiptIcon />
      <span className={styles.documentName}>{file.name}</span>
      <span className={styles.attachedSize}>{fileSize(file.size)}</span>
    </a>
  );
}
