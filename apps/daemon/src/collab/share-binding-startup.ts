import type { PublicFileMutations } from './public-file-mutations.js';
import type { ShareBindingOutbox, ShareBindingTask } from './share-binding-outbox.js';

export interface PreparedShareBinding {
  resourceTeamId: string;
  ownerMemberId: string;
  /** Must bind only this captured immutable publication, never publish again. */
  bind(): Promise<void>;
}
export type PrepareShareBinding = (task: Readonly<ShareBindingTask>) => Promise<PreparedShareBinding | null>;
export interface ShareBindingStartupOptions {
  prepare: PrepareShareBinding | null;
  /** Must verify a current authoritative local publication witness, not just the queue. */
  isCurrent(task: ShareBindingTask): boolean;
  mutations: PublicFileMutations;
}
export interface ShareBindingStartupResult { bound: number; failed: number; deferred: number; persistenceFailures: number }

/** One binding-only pass per lifecycle. A missing primitive defers; it is not
 * a failed network attempt. Local CAS protects bookkeeping, not cloud atomicity.
 */
export function createShareBindingStartup(outbox: ShareBindingOutbox, options: ShareBindingStartupOptions): () => Promise<ShareBindingStartupResult> {
  let started: Promise<ShareBindingStartupResult> | undefined;
  return () => started ??= Promise.resolve().then(async () => {
    const result = { bound: 0, failed: 0, deferred: 0, persistenceFailures: 0 };
    for (const snapshot of outbox.list()) {
      if (snapshot.failureCount >= 5) continue;
      const task = Object.freeze({ ...snapshot, receipt: Object.freeze({ ...snapshot.receipt }) });
      try {
        await options.mutations.run(task.projectId, async () => {
          const current = () => {
            const queued = outbox.list().find(item => item.id === task.id);
            return queued?.publicationRevision === task.publicationRevision
              && queued.failureCount === task.failureCount && options.isCurrent(task);
          };
          if (!current()) { result.deferred++; return; }
          let operation: PreparedShareBinding | null = null;
          try { operation = await options.prepare?.(task) ?? null; } catch { /* No verified identity/primitive. */ }
          if (!operation || operation.resourceTeamId !== task.resourceTeamId
            || operation.ownerMemberId !== task.ownerMemberId || !current()) {
            result.deferred++; return;
          }
          let failed = false;
          try { await operation.bind(); } catch { failed = true; }
          if (!current()) { result.deferred++; return; }
          if (failed) { outbox.fail(task); result.failed++; }
          else { outbox.complete(task); result.bound++; }
        });
      } catch {
        // Preserve budget on local reads/writes/lock failure and continue other projects.
        result.persistenceFailures++;
      }
    }
    return result;
  });
}
