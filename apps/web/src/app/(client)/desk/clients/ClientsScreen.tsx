'use client';

import { useMemo, useState } from 'react';
import type { DeskClientRow } from '@inrp2p/quotes';
import { formatIstDate } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { setDeskClientAction } from '../../../../server/actions/desks.ts';
import { EmptyState } from '../../_workspace/EmptyState.tsx';
import { Field } from '../../_workspace/Field.tsx';
import { UsersIcon } from '../../_workspace/icons.tsx';
import { Sheet } from '../../_workspace/Sheet.tsx';
import { initial, sentence, usdt } from '../_ui/format.ts';
import shell from '../../shell.module.css';
import styles from '../desk.module.css';

type Filter = 'ALL' | 'ACTIVE' | 'BLOCKED';
const SOURCE: Record<string, string> = { PAGE: 'your page', LINK: 'a deal link', INVITE: 'an invitation' };

function ClientSheet({ client, onClose, canCommit }: { client: DeskClientRow | null; onClose: () => void; canCommit: boolean }) {
  const [maxDeal, setMaxDeal] = useState(client?.maxDeal?.replace(/\.?0+$/, '') ?? '');
  const [note, setNote] = useState(client?.note ?? '');
  const [confirmBlock, setConfirmBlock] = useState(false);
  const { run, busy, error, dialog } = useCommand();
  if (!client) return null;
  const blocked = client.status === 'BLOCKED';
  const dirty = (maxDeal || null) !== (client.maxDeal?.replace(/\.?0+$/, '') ?? null) || (note.trim() || null) !== client.note;

  const save = async (patch: { status?: 'ACTIVE' | 'BLOCKED' }) => {
    const out = await run(patch.status === 'BLOCKED' ? `Block ${client.name}` : patch.status === 'ACTIVE' ? `Unblock ${client.name}` : `Save ${client.name}`, (key) =>
      setDeskClientAction({ clientId: client.clientId, expectedVersion: client.version, ...patch, ...(dirty ? { maxDeal: maxDeal.trim() || null, note: note.trim() || null } : {}) }, key),
    );
    if (out.ok) onClose();
  };

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        locked={busy}
        eyebrow={blocked ? 'Blocked client' : 'Client'}
        title={client.name}
        description={`Came through ${SOURCE[client.source] ?? 'your desk'} on ${formatIstDate(new Date(client.since))}.`}
        footer={
          <button type="button" className={`${shell.action} ${shell.wide}`} disabled={!canCommit || !dirty || busy} aria-busy={busy || undefined} onClick={() => void save({})}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        }
      >
        <div className={styles.form}>
          <dl className={styles.preview}>
            <div className={styles.previewRow}>
              <dt>Completed deals</dt>
              <dd>{client.completedDeals}</dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Volume with you</dt>
              <dd>{usdt(client.completedUsdt)}</dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Open now</dt>
              <dd>{client.openDeals > 0 ? `${client.openDeals} deal${client.openDeals === 1 ? '' : 's'}` : client.asking ? 'Holding your price' : 'Nothing'}</dd>
            </div>
          </dl>
          <Field label="Largest deal with this client" hint="Leave empty for your page’s own limits." inputMode="decimal" adornment="USDT" value={maxDeal} onChange={(e) => setMaxDeal(e.target.value.replace(/[^0-9.]/g, ''))} disabled={!canCommit} />
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="client-note">
              Note <span className={shell.muted}>· only your desk sees it</span>
            </label>
            <textarea id="client-note" className={styles.textarea} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={!canCommit} placeholder="Pays from HDFC, prefers IMPS, Telegram @ravi" />
          </div>
          <section className={shell.info} data-tone={blocked ? undefined : 'warning'} aria-label={blocked ? 'Unblock' : 'Block'}>
            <span className={styles.infoStack}>
              <span>
                {blocked
                  ? 'This client cannot get your prices or take your links. Deals already accepted ran to their end.'
                  : 'Blocking stops new deals at once: a price the client holds and links it took are withdrawn. Deals already accepted run to their end.'}
              </span>
              {canCommit ? (
                blocked ? (
                  <button type="button" className={shell.secondaryAction} data-size="sm" disabled={busy} onClick={() => void save({ status: 'ACTIVE' })}>
                    Unblock
                  </button>
                ) : confirmBlock ? (
                  <span className={styles.cardActions}>
                    <button type="button" className={shell.action} data-size="sm" disabled={busy} onClick={() => void save({ status: 'BLOCKED' })}>
                      Block {client.name}
                    </button>
                    <button type="button" className={shell.textAction} onClick={() => setConfirmBlock(false)}>
                      Keep dealing
                    </button>
                  </span>
                ) : (
                  <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => setConfirmBlock(true)}>
                    Block client
                  </button>
                )
              ) : null}
            </span>
          </section>
          {error ? (
            <p className={shell.error} role="alert">
              {sentence(error)}
            </p>
          ) : null}
        </div>
      </Sheet>
      {dialog}
    </>
  );
}

/** The desk's clients as a list it can search, with what each did with it; one opens in a sheet. */
export function ClientsScreen({ clients, canCommit }: { clients: readonly DeskClientRow[]; canCommit: boolean }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(
    () => clients.filter((c) => (filter === 'ALL' || c.status === filter) && c.name.toLowerCase().includes(q.trim().toLowerCase())),
    [clients, q, filter],
  );
  const blocked = clients.filter((c) => c.status === 'BLOCKED').length;
  const current = clients.find((c) => c.clientId === open) ?? null;

  return (
    <main className={shell.main}>
      <section className={shell.card} aria-label="Clients">
        {clients.length === 0 ? (
          <EmptyState icon={<UsersIcon />} title="No clients yet" body="A client becomes yours the first time it asks your page for a price or takes a deal link you sent." />
        ) : (
          <>
            <div className={styles.filters}>
              <div className={styles.periods} role="group" aria-label="Show">
                {(['ALL', 'ACTIVE', 'BLOCKED'] as const).map((f) => (
                  <button key={f} type="button" className={styles.period} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {f === 'ALL' ? `All ${clients.length}` : f === 'ACTIVE' ? 'Active' : `Blocked ${blocked}`}
                  </button>
                ))}
              </div>
              <div className={styles.search}>
                <Field label={<span className="ix-visually-hidden">Search clients</span>} placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} type="search" />
              </div>
            </div>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Client</th>
                  <th className={styles.num}>Deals</th>
                  <th className={styles.num}>Volume</th>
                  <th className={styles.num}>Last deal</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.clientId}>
                    <td>
                      <span className={styles.who}>
                        <span className={styles.avatar} aria-hidden="true">
                          {initial(c.name)}
                        </span>
                        <span className={styles.whoText}>
                          <button type="button" className={`${styles.rowLink} ${styles.whoName} ${styles.nameButton}`} onClick={() => setOpen(c.clientId)}>
                            {c.name}
                          </button>
                          <span className={styles.whoMeta}>
                            via {SOURCE[c.source] ?? 'your desk'}
                            {c.maxDeal ? ` · up to ${usdt(c.maxDeal)}` : ''}
                            {c.note ? ` · ${c.note}` : ''}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className={styles.num}>
                      {c.completedDeals}
                      <span className={styles.unitMobile}> {c.completedDeals === 1 ? 'deal' : 'deals'}</span>
                    </td>
                    <td className={styles.num} data-col="hide">
                      {usdt(c.completedUsdt)}
                    </td>
                    <td className={styles.num} data-col="hide">
                      {c.lastDealAt ? formatIstDate(new Date(c.lastDealAt)) : '—'}
                    </td>
                    <td>
                      <span className={styles.status} data-tone={c.status === 'BLOCKED' ? 'neutral' : c.openDeals > 0 || c.asking ? 'action' : 'live'}>
                        <span className={styles.statusDot} aria-hidden="true" />
                        {c.status === 'BLOCKED' ? 'Blocked' : c.openDeals > 0 ? 'Dealing now' : c.asking ? 'Asking' : 'Active'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 ? <p className={shell.muted}>No client matches.</p> : null}
          </>
        )}
      </section>
      {current ? <ClientSheet key={`${current.clientId}:${current.version}`} client={current} onClose={() => setOpen(null)} canCommit={canCommit} /> : null}
    </main>
  );
}
