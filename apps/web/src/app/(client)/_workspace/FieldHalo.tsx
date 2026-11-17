import styles from './field-halo.module.css';

/**
 * The landing's halo, without its robot: the mark's three arcs turning slowly, a dotted orbit with its nodes turning
 * the other way. It sits in a corner of an orange field (a cap, a field sheet) as the field's own light — drawing only,
 * so it is hidden from assistive technology. `place` puts it where the field's figure is not.
 */
export function FieldHalo({ place = 'top', sun = false }: { place?: 'top' | 'bottom'; sun?: boolean }) {
  return (
    <div className={styles.halo} data-place={place} aria-hidden="true">
      {sun ? <i /> : null}
      <svg className={styles.arcs} viewBox="0 0 400 400" focusable="false">
        <path d="M 27.6 230.4 A 175 175 0 0 1 117.8 45.5" />
        <path d="M 282.2 45.5 A 175 175 0 0 1 372.4 230.4" />
        <path d="M 297.9 345 A 175 175 0 0 1 102.1 345" />
      </svg>
      <svg className={styles.orbit} viewBox="0 0 400 400" focusable="false">
        <circle cx="200" cy="200" r="194" />
        <circle className={styles.node} cx="200" cy="6" r="6" />
        <circle className={styles.node} cx="32" cy="297" r="5" />
        <circle className={styles.node} cx="368" cy="297" r="5" />
      </svg>
    </div>
  );
}
