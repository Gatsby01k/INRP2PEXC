import { Money } from '@inrp2p/kernel';
import { usdtView } from '@inrp2p/desk';
import { DepositPoolStatus, TransactionHash, WalletRow } from '@inrp2p/ui';
import { formatIstDateTime, formatUsdt } from '@inrp2p/ui/format';
import { operatorPage } from '../../../server/operator.ts';
import styles from '../shell.module.css';
import usdt from './usdt.module.css';

export const dynamic = 'force-dynamic';

/** Below this many free pool addresses the desk is warned before SELL acceptance starts failing (D-02). */
const LOW_POOL_THRESHOLD = 20;

const STATE_LABEL: Record<string, string> = {
  DETECTED: 'detected · awaiting finality',
  CONFIRMED: 'confirmed',
  FAILED: 'failed on chain',
  ORPHANED: 'orphaned by a reorg',
};

/**
 * USDT: treasury, the deposit pool (D-02) and what the chain has produced lately. The scanner's cursor is shown
 * because an operator needs to know whether "no new transfers" means quiet or means broken (Phase 5).
 */
export default async function UsdtPage() {
  const ctx = await operatorPage();
  const view = await usdtView(ctx.db, { transferLimit: 30 });

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>USDT</h1>
        {view.scanner ? (
          <span className="ix-muted">
            Scanner at block {view.scanner.lastScannedBlock} · solidified {view.scanner.lastSolidifiedBlock}
            {view.scanner.lastRunAt ? ` · last run ${formatIstDateTime(new Date(view.scanner.lastRunAt))}` : ''}
          </span>
        ) : (
          <span className="ix-muted">The scanner has not run yet.</span>
        )}
      </header>
      <div className={styles.content}>
        <div className="ix-stack">
          <section className="ix-card">
            <h2 className="ix-sectionTitle">Deposit addresses</h2>
            <DepositPoolStatus
              capability={view.pool.capability}
              provider={view.pool.provider ?? 'no provider recorded'}
              available={view.pool.available}
              assigned={view.pool.assigned}
              cooldown={view.pool.cooldown}
              lowThreshold={LOW_POOL_THRESHOLD}
            />
          </section>

          <section className="ix-card">
            <h2 className="ix-sectionTitle">Treasury</h2>
            <div className={usdt.wallets}>
              {view.wallets.map((w) => (
                <div key={w.walletId} className={usdt.wallet}>
                  <WalletRow address={w.address} network="TRC20" label={`${w.label} · ${w.role.toLowerCase()}`} status={w.status === 'RETIRED' ? 'ARCHIVED' : w.status} />
                  <span className="ix-num">
                    {formatUsdt(Money.parse(w.available, 'USDT'), { unit: true })} available of {formatUsdt(Money.parse(w.observed, 'USDT'), { unit: true })}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="ix-card">
            <h2 className="ix-sectionTitle">Transfers</h2>
            {view.transfers.length === 0 ? (
              <p className="ix-muted">Nothing on chain yet.</p>
            ) : (
              <ul className={usdt.transfers}>
                {view.transfers.map((t) => (
                  <li key={t.id} className={usdt.transfer}>
                    <TransactionHash hash={t.txHash} {...(t.state === 'CONFIRMED' ? { finality: 'solidified' } : {})} />
                    <span className="ix-num">{formatUsdt(Money.parse(t.amount, 'USDT'), { unit: true })}</span>
                    <span>{STATE_LABEL[t.state] ?? t.state}</span>
                    <span className="ix-muted">{t.tradeRef ?? (t.source === 'SCANNER' ? 'unattributed' : 'operator submitted')}</span>
                    <span className="ix-muted">{formatIstDateTime(new Date(t.detectedAt))}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
