import type { ProjectDeleteShareResidual } from '@open-design/contracts';
import type { PreparePublicFileStop, PublicFilePublicationScope, StopQueuePublicFilePublicationStore } from './public-file-publication-store.js';

/** Internal handoff only: this error does not assert local deletion succeeded.
 * The deletion owner must finish its local work before returning ok: true.
 */
export class ProjectPublicFileStopPendingError extends Error {
  readonly shareResiduals: ReadonlyArray<ProjectDeleteShareResidual>;
  constructor(residuals: ReadonlyArray<ProjectDeleteShareResidual>) {
    super('PUBLIC_FILE_STOP_PENDING');
    this.name = 'ProjectPublicFileStopPendingError';
    this.shareResiduals = Object.freeze(residuals.map(item => Object.freeze({ ...item })));
  }
}

/**
 * Stop the original owner's publications before allowing catalog/local deletion.
 * Failed stops remain independent durable tasks. A changed publication invalidates
 * this deletion attempt: an older response must never erase a newer witness.
 */
export function createProjectPublicFileStop(store: StopQueuePublicFilePublicationStore, prepare: PreparePublicFileStop) {
  return async (scope: Omit<PublicFilePublicationScope, 'filePath'>): Promise<void> => {
    let pending = false;
    const targets = store.listByProject(scope).map((file) => {
      const key = { ...scope, filePath: file.filePath, slug: file.slug };
      return { key, revision: store.getRevision(key) };
    });
    for (const { key, revision } of targets) {
      if (!revision || revision.slug !== key.slug) { pending = true; continue; }
      // Preparation can await network identity verification; recheck before send.
      const matches = () => {
        const current = store.getRevision(key);
        return current?.slug === revision.slug && current.token === revision.token;
      };
      let stopped = false;
      try {
        const operation = await prepare(Object.freeze(key));
        if (operation?.resourceTeamId === key.resourceTeamId
          && operation.ownerMemberId === key.ownerMemberId && matches()) {
          await operation.stop();
          stopped = true;
        }
      } catch { /* Persist only the original still-current stop intent below. */ }
      if (!stopped) {
        // Never enqueue an old failure against a replacement stable alias.
        if (matches()) store.enqueueStop(key, revision);
        pending = true;
        continue;
      }
      // Persistence errors propagate: do not report deletion success after a
      // remote receipt if atomic witness/outbox cleanup did not commit.
      if (store.deleteIfRevisionMatches(key, revision)) store.completeStop(key);
      else pending = true;
    }
    const remaining = store.listByProject(scope);
    if (pending || remaining.length > 0) {
      const retryable = store.listRetryableStops();
      const residuals: ProjectDeleteShareResidual[] = remaining.map(file => {
        const revision = store.getRevision({ ...scope, filePath: file.filePath });
        return {
          filePath: file.filePath,
          slug: file.slug,
          retrying: revision?.slug === file.slug && retryable.some(task =>
            task.resourceTeamId === scope.resourceTeamId
            && task.ownerMemberId === scope.ownerMemberId
            && task.projectId === scope.projectId
            && task.filePath === file.filePath
            && task.slug === file.slug
            && task.publicationRevision === revision.token),
        };
      });
      throw new ProjectPublicFileStopPendingError(residuals);
    }
  };
}
