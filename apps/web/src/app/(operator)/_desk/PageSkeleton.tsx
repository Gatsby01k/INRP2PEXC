import s from './desk.module.css';
import k from './skeleton.module.css';

/**
 * What a desk section shows between the click and the server's answer: the page frame, its header and body, in
 * placeholders. It is static, so the router prefetches it with the link and draws it the moment the operator clicks —
 * the rail's pill moves at once and the page arrives into the shape it already has. It holds no figure and no heading:
 * a number on a desk is either the server's current one or not shown.
 */
export function PageSkeleton() {
  return (
    <div className={s.page} aria-busy="true" aria-label="Loading">
      <div className={s.header} aria-hidden="true">
        <span className={`${k.bar} ${k.title}`} />
        <span className={`${k.bar} ${k.meta}`} />
        <span className={`${k.bar} ${k.tabs}`} />
      </div>
      <div className={s.body} aria-hidden="true">
        <div className={k.kpis}>
          <span className={`${k.block} ${k.kpi}`} />
          <span className={`${k.block} ${k.kpi}`} />
          <span className={`${k.block} ${k.kpi}`} />
          <span className={`${k.block} ${k.kpi}`} />
        </div>
        <span className={k.block} />
        <span className={k.block} data-size="sm" />
      </div>
    </div>
  );
}
