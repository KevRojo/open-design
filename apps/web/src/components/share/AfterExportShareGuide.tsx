import { useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import { advanceShareGuideClock, startShareGuideClock } from './after-export-share-guide';
import styles from './AfterExportShareGuide.module.css';

/** Behavior-only placeholder. Visual acceptance is BLOCKED on the Owner-01 source image. */
export function AfterExportShareGuide({ onOpenShare, onDismiss, onNeverShow, labels }: {
  onOpenShare: () => void;
  onDismiss: () => void;
  /** Return false when the permanent preference could not be persisted. */
  onNeverShow: () => boolean;
  labels: { openShare: string; close: string; neverShow: string; awaitingDesign: string; saveFailed: string };
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
      className={styles.placeholder}
      aria-label={labels.openShare}
      data-design-status="awaiting-source-image"
      onMouseEnter={() => updateInteraction({ ...interaction, hovered: true })}
      onMouseLeave={() => updateInteraction({ ...interaction, hovered: false })}
      onFocusCapture={() => updateInteraction({ ...interaction, focused: true })}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) updateInteraction({ ...interaction, focused: false });
      }}
    >
      <small>{labels.awaitingDesign}</small>
      <Button type="button" onClick={() => { onDismiss(); onOpenShare(); }}>{labels.openShare}</Button>
      <Button type="button" onClick={onDismiss} aria-label={labels.close}>×</Button>
      <Button type="button" onClick={() => {
        if (onNeverShow()) onDismiss();
        else setSaveFailed(true);
      }}>{labels.neverShow}</Button>
      {saveFailed ? <p role="alert">{labels.saveFailed}</p> : null}
    </section>
  );
}
