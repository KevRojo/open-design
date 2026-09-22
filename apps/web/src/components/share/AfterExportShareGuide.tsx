import { useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import { advanceShareGuideClock, startShareGuideClock } from './after-export-share-guide';
import styles from './AfterExportShareGuide.module.css';

/** Anchored guide borrowing the shared canvas prompt/tool visual language. */
export function AfterExportShareGuide({ onOpenShare, onDismiss, onNeverShow, labels }: {
  onOpenShare: () => void;
  onDismiss: () => void;
  /** Return false when the permanent preference could not be persisted. */
  onNeverShow: () => boolean;
  labels: { openShare: string; close: string; neverShow: string; saveFailed: string };
}) {
  const [clock, setClock] = useState(() => startShareGuideClock(performance.now()));
  const [interaction, setInteraction] = useState({ hovered: false, focused: false });
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    if (clock.paused) return;
    const delay = Math.max(0, clock.remainingMs - (performance.now() - clock.checkedAt));
    const timer = window.setTimeout(onDismiss, delay);
    return () => window.clearTimeout(timer);
  }, [clock, onDismiss]);

  function updateInteraction(next: typeof interaction) {
    setClock(previous => advanceShareGuideClock(previous, performance.now(), next));
    setInteraction(next);
  }
  return (
    <section
      className={styles.guide}
      aria-label={labels.openShare}
      onMouseEnter={() => updateInteraction({ ...interaction, hovered: true })}
      onMouseLeave={() => updateInteraction({ ...interaction, hovered: false })}
      onFocusCapture={() => updateInteraction({ ...interaction, focused: true })}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) updateInteraction({ ...interaction, focused: false });
      }}
    >
      <div className={styles.header}>
        <Button className={styles.openShare} type="button" onClick={() => { onDismiss(); onOpenShare(); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M10 13.5a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 10.5a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
          </svg>
          <span>{labels.openShare}</span>
        </Button>
        <Button className={styles.close} type="button" onClick={onDismiss} aria-label={labels.close}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </Button>
      </div>
      <Button className={styles.neverShow} type="button" onClick={() => {
        if (onNeverShow()) onDismiss();
        else setSaveFailed(true);
      }}>{labels.neverShow}</Button>
      {saveFailed ? <p className={styles.error} role="alert">{labels.saveFailed}</p> : null}
    </section>
  );
}
