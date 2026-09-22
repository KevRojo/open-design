import type Database from 'better-sqlite3';
import type { CommentSyncState, CommentAlignResult } from '@open-design/contracts';
import { migrateCommentRelayOutbox } from './comment-relay-outbox.js';

export interface CommentSyncScope { projectId: string; workspaceId: string; workspaceMemberId: string }
export interface CommentSyncStateService {
  read(scope: CommentSyncScope): Promise<CommentSyncState | null>;
  retry(scope: CommentSyncScope): Promise<CommentSyncState | null>;
}

/** Null is unknown, not a healthy initial state. Session checks are uncached here
 * so a read after login observes recovery without recreating the service.
 */
export function createCommentSyncStateService(db: Database.Database,
  sessionAvailable: (scope: CommentSyncScope) => Promise<boolean | null>,
  diagnostics?: { readAlign: (scope: CommentSyncScope) => CommentAlignResult | undefined },
): CommentSyncStateService {
  migrateCommentRelayOutbox(db);
  const args = (scope: CommentSyncScope) => {
    const values = [scope.projectId, scope.workspaceId, scope.workspaceMemberId];
    if (values.some(value => !value.trim())) throw new Error('Comment sync scope required');
    return values;
  };
  const read = async (scope: CommentSyncScope): Promise<CommentSyncState | null> => {
    const identity = args(scope);
    const available = await sessionAvailable(scope);
    if (available === null) return null;
    // Query after the session await, not a stale count from before a send finished.
    const rows = db.prepare(`SELECT last_error FROM comment_relay_outbox
      WHERE project_id=? AND workspace_id=? AND workspace_member_id=? ORDER BY updated_at DESC`).all(...identity) as Array<{ last_error: string | null }>;
    const align = diagnostics?.readAlign(scope);
    return { ...(align ? { align } : {}), pending: rows.length,
      // Arbitrary transport messages can contain credentials or other private data.
      lastError: (rows.some(row => Boolean(row.last_error)) || db.prepare('SELECT 1 FROM comment_relay_sync_failures WHERE project_id=? AND workspace_id=? AND workspace_member_id=?').get(...identity)) ? 'COMMENT_SYNC_DELIVERY_FAILED' : null,
      sessionMissing: rows.length > 0 && !available, shareStopped: null };
  };
  return { read, retry: async scope => {
    db.prepare(`UPDATE comment_relay_outbox SET next_attempt_at=0
      WHERE project_id=? AND workspace_id=? AND workspace_member_id=?`).run(...args(scope));
    return read(scope);
  } };
}
