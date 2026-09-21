import { useEffect, useState } from 'react';
import type {
  WorkspaceBillingPreflight,
  WorkspaceBillingResponse,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './CodingPlanUsage.module.css';

/** Mounted only while the billing panel is visible. Quota changes do not emit
 * wallet events, so refresh independently and also at window reset. */
export function CodingPlanUsage({ context }: { context: WorkspaceCollabContext | null }) {
  const t = useT();
  const workspaceId = context?.workspaceId;
  const memberId = context?.workspaceMemberId;
  const [reading, setReading] = useState<WorkspaceBillingPreflight | null>(null);
  useEffect(() => {
    setReading(null);
    if (!workspaceId || !memberId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      let delay = 30_000;
      try {
        const response = await fetch(
          `/api/workspace/billing?scope=workspace&workspaceId=${encodeURIComponent(workspaceId)}&includePreflight=1`,
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        const body: WorkspaceBillingResponse | null = response.ok ? await response.json() : null;
        const next = body?.preflight;
        const valid =
          next?.workspaceId === workspaceId &&
          next.workspaceMemberId === memberId &&
          Math.abs(Date.now() - Date.parse(next.generatedAt)) < 60_000;
        if (!controller.signal.aborted) setReading(valid ? next : null);
        if (valid) {
          for (const window of next.codingPlan.windows) {
            if (window.resetsAt) {
              const untilReset = Date.parse(window.resetsAt) - Date.now();
              if (untilReset > 0) delay = Math.min(delay, untilReset + 250);
            }
          }
        }
      } catch {
        if (!controller.signal.aborted) setReading(null);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), delay);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspaceId, memberId]);
  if (!workspaceId || !memberId) return null;
  const plan =
    reading?.workspaceId === workspaceId && reading.workspaceMemberId === memberId
      ? reading.codingPlan
      : null;
  return (
    <div className={styles.panel} aria-label={t('billing.codingPlan')}>
      <strong>{t('billing.codingPlan')}</strong>
      {!plan ? (
        <p>{t('billing.codingPlanUnavailable')}</p>
      ) : !plan.eligible ? (
        <p>{t('billing.codingPlanNone')}</p>
      ) : (
        <>
          {plan.windows.map((window) => {
            const percent =
              Number((BigInt(window.remainingCredits) * 10_000n) / BigInt(window.limitCredits)) /
              100;
            return (
              <div key={window.policyId}>
                <div>
                  {t('billing.codingPlanRemaining', {
                    remaining: percent,
                    hours: window.durationSeconds / 3600,
                  })}
                </div>
                <progress
                  value={percent}
                  max={100}
                  aria-label={t('billing.codingPlanRemaining', {
                    remaining: percent,
                    hours: window.durationSeconds / 3600,
                  })}
                />
                <small>
                  {window.resetsAt
                    ? t('billing.codingPlanReset', {
                        time: new Date(window.resetsAt).toLocaleString(),
                      })
                    : t('billing.codingPlanUnstarted')}
                </small>
              </div>
            );
          })}
          <p>{t('billing.codingPlanFallback')}</p>
        </>
      )}
    </div>
  );
}
