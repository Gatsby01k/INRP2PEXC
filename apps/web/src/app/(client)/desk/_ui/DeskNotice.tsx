import { ShieldIcon } from '../../_workspace/icons.tsx';
import shell from '../../shell.module.css';
import styles from '../desk.module.css';

/**
 * What INRP2P decided about the desk (block 11), said where its people work: suspended — no new deal, open deals settle —
 * or its page hidden, with INRP2P's own words. Nothing to say, nothing shown.
 */
export function DeskNotice({ desk }: { desk: { readonly status: string; readonly suspensionReason: string | null; readonly pageHiddenReason: string | null } }) {
  if (desk.status !== 'SUSPENDED' && desk.pageHiddenReason === null) return null;
  return (
    <div className={styles.notices}>
      {desk.status === 'SUSPENDED' ? (
        <p className={shell.info} data-tone="warning" role="status">
          <ShieldIcon className={shell.infoIcon} />
          <span>
            <strong>INRP2P has suspended your desk.</strong> Clients cannot get a price or take a link until INRP2P lifts it; deals already accepted settle as usual.
            {desk.suspensionReason ? <span className={styles.noticeWhy}> INRP2P’s note: “{desk.suspensionReason}”</span> : null}
          </span>
        </p>
      ) : null}
      {desk.pageHiddenReason !== null ? (
        <p className={shell.info} data-tone="warning" role="status">
          <ShieldIcon className={shell.infoIcon} />
          <span>
            <strong>INRP2P has hidden your page.</strong> Nobody can open it until INRP2P shows it again. Change your desk’s name or words on Page, and INRP2P will look at
            it again.
            <span className={styles.noticeWhy}> INRP2P’s note: “{desk.pageHiddenReason}”</span>
          </span>
        </p>
      ) : null}
    </div>
  );
}
