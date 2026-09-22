import type { WorkspaceCollabContext } from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { AmrLoginPill } from '../AmrLoginPill';
import { useCommentSyncState } from './useCommentSyncState';
import styles from './CommentSyncBanner.module.css';

/** K8 only. Historical errors and unchecked align/backfill never select a banner. */
export function CommentSyncBanner({ projectId, workspaceContext }: {
  projectId?: string;
  workspaceContext?: WorkspaceCollabContext | null;
}) {
  const { t } = useI18n();
  const state = useCommentSyncState(projectId, workspaceContext);
  if (state?.sessionMissing !== true) return null;
  return (
    <div className={styles.banner} role="status">
      <p>{t('fileViewer.commentSync.sessionMissing')}</p>
      <AmrLoginPill className={styles.login} hideSignedOutStatus hideSignedInStatus showConsoleAction={false} />
    </div>
  );
}
