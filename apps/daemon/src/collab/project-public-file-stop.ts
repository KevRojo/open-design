import type { PreparePublicFileStop, PublicFilePublicationScope, StopQueuePublicFilePublicationStore } from './public-file-publication-store.js';

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
    if (pending || store.listByProject(scope).length > 0) {
      throw new Error('PUBLIC_FILE_STOP_PENDING');
    }
  };
}
