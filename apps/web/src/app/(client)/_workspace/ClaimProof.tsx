import type { DealChatView } from '@inrp2p/settlement';
import { ReceiptIcon } from './icons.tsx';
import styles from './pay-inr.module.css';

/**
 * The receipt the buyer attached to the payment the seller is asked to confirm (ADR 0023) — shown, and said for what
 * it is: the buyer's own screenshot. Only the seller's bank shows whether the money arrived.
 */
export function ClaimProof({ chat, paymentRef }: { chat: DealChatView; paymentRef: string }) {
  const receipt = chat.messages.filter((m) => m.kind === 'RECEIPT' && m.paymentRef === paymentRef && m.from !== 'YOU' && m.file).at(-1);
  if (!receipt?.file) return null;
  const href = `/api/deal-files/${receipt.file.id}`;
  return (
    <div className={styles.claimProof}>
      <a href={href} target="_blank" rel="noreferrer noopener" aria-label="Open the buyer’s receipt">
        {receipt.file.type.startsWith('image/') ? <img src={href} alt="The buyer’s receipt" loading="lazy" /> : <ReceiptIcon />}
      </a>
      <span>
        <strong>The buyer attached a receipt.</strong> It is their screenshot, not proof — a receipt can be edited, and a transfer can still be returned. Confirm only what your
        bank app shows.
      </span>
    </div>
  );
}
