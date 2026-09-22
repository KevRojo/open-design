import { useEffect, useState } from 'react';
import type { CommentSyncState, WorkspaceCollabContext } from '@open-design/contracts';
import { currentWorkspaceAccountGeneration, workspaceAccountScopedCacheKey, workspaceProjectHeaders } from '../../collab/workspace-identity';
import { AMR_LOGIN_STATUS_EVENT } from '../amrLoginPolling';

function isCommentSyncState(value: unknown): value is CommentSyncState {
  if (!value || typeof value !== 'object') return false;
  return 'pending' in value && Number.isSafeInteger(value.pending) && Number(value.pending) >= 0
    && 'sessionMissing' in value && typeof value.sessionMissing === 'boolean'
    && 'lastError' in value && (value.lastError === null || typeof value.lastError === 'string')
    && 'shareStopped' in value && (value.shareStopped === null || typeof value.shareStopped === 'boolean');
}

/** A missing/failed read is unknown. Neither history nor login state substitutes for the server conjunction. */
export function useCommentSyncState(projectId: string | undefined, context: WorkspaceCollabContext | null | undefined) {
  const generation = currentWorkspaceAccountGeneration();
  const scope = JSON.stringify([projectId, workspaceAccountScopedCacheKey(context)]);
  const [observation, setObservation] = useState<{ scope: string; value: CommentSyncState } | null>(null);
  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let controller: AbortController | undefined;
    const refresh = () => {
      const request = ++attempt;
      const account = currentWorkspaceAccountGeneration();
      controller?.abort();
      setObservation(null);
      if (!projectId) return;
      controller = new AbortController();
      void (async () => {
        let value: unknown;
        try {
          const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/comment-sync-state`, {
            cache: 'no-store', signal: controller?.signal,
            ...(context ? { headers: workspaceProjectHeaders(context) } : {}),
          });
          value = response.ok ? await response.json() : null;
        } catch {
          value = null; // Transport/parse failure remains unknown, never healthy.
        }
        if (disposed || request !== attempt || account !== currentWorkspaceAccountGeneration()) return;
        setObservation(isCommentSyncState(value) ? { scope, value } : null);
      })();
    };
    refresh();
    window.addEventListener(AMR_LOGIN_STATUS_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      controller?.abort();
      window.removeEventListener(AMR_LOGIN_STATUS_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [projectId, context, generation, scope]);
  return observation?.scope === scope ? observation.value : null;
}
