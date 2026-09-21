import { Button } from '@open-design/components';
import styles from './SharePanelHeader.module.css';

/** Shared chrome for toolbar/card entry; closing the shell never cancels a publish. */
export function SharePanelHeader({ title, closeLabel, onClose }: {
  title: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      <Button type="button" className={styles.close} aria-label={closeLabel} onClick={onClose}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </Button>
    </div>
  );
}
