import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@open-design/components';
import { workspaceContextHasTeamIdentity, type WorkspaceCollabContext } from '@open-design/contracts';
import type { PublicFilePublishFailureKey } from '../../collab/public-file-publish';
import type { useT } from '../../i18n';
import type { WebDeployProviderId } from '../../providers/registry';
import type { DeployProviderOption } from '../FileViewer';
import { RemixIcon } from '../RemixIcon';
import styles from './ShareTab.module.css';

export type SharePublishFailureKey = PublicFilePublishFailureKey | 'fileViewer.publishFileTooLarge';

/** Time-based waiting feedback, not transferred bytes. Only success may reach 1. */
export function boundedPublishProgress(elapsedMs: number, completed: boolean): number {
  if (completed) return 1;
  const elapsed = Number.isNaN(elapsedMs) ? 0 : Math.max(0, elapsedMs);
  return Math.min(0.9, 0.9 * (1 - Math.exp(-elapsed / 5000)));
}

export function ShareTab({
  menuOrigin,
  workspaceContext,
  t,
  shareAccess,
  shareAccessMenuOpen,
  shareAccessBusy,
  viewerOnly,
  setShareAccessMenuOpen,
  setWorkspaceShareAccess,
  canPublishPublic,
  filePublished,
  publishedFileUrl,
  copyPublishedFileLink,
  publishLinkFeedback,
  publishingPublicFile,
  publishProgress,
  unpublishCurrentFilePublic,
  viewerOnlyDisabledTitle,
  publishCurrentFilePublic,
  publishFailureKey,
  DEPLOY_PROVIDER_OPTIONS,
  streaming,
  openDeployModal,
  deployActionIconFor,
  deployActionLabelFor,
  sharePageUrl,
  canCopyShareLink,
  shareUnavailableHint,
  copyShareLink,
  copyShareLinkLabel,
  canOpenSharePage,
  shareLinkStatusHint,
}: {
  menuOrigin: 'toolbar' | 'artifact-card';
  workspaceContext: WorkspaceCollabContext | null;
  t: ReturnType<typeof useT>;
  shareAccess: 'private' | 'workspace';
  shareAccessMenuOpen: boolean;
  shareAccessBusy: boolean;
  viewerOnly: boolean;
  setShareAccessMenuOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspaceShareAccess: (nextAccess: 'private' | 'workspace') => void;
  canPublishPublic: boolean;
  filePublished: boolean;
  publishedFileUrl: string;
  copyPublishedFileLink: () => Promise<void>;
  publishLinkFeedback: 'copied' | 'failed' | null;
  publishingPublicFile: boolean;
  publishProgress: number | null;
  unpublishCurrentFilePublic: () => Promise<void>;
  viewerOnlyDisabledTitle: string;
  publishCurrentFilePublic: () => Promise<void>;
  publishFailureKey: SharePublishFailureKey | null;
  DEPLOY_PROVIDER_OPTIONS: DeployProviderOption[];
  streaming: boolean;
  openDeployModal: (nextProviderId?: WebDeployProviderId, intent?: 'deploy' | 'social-share') => Promise<void>;
  deployActionIconFor: (providerId: WebDeployProviderId) => 'pages-line' | 'upload-cloud-line';
  deployActionLabelFor: (providerId: WebDeployProviderId) => string;
  sharePageUrl: string;
  canCopyShareLink: boolean;
  shareUnavailableHint: string;
  copyShareLink: (url: string) => Promise<boolean>;
  copyShareLinkLabel: string;
  canOpenSharePage: boolean;
  shareLinkStatusHint: string;
}) {
  return (
                      <div className={`chrome-unified-panel chrome-unified-panel--share ${styles.panel}`}>
                      {/* Team-only, same as ReactComponentViewer's copy of this card above —
                          see the comment there (recvq5bM78HWCE). */}
                      {menuOrigin === 'toolbar' && workspaceContextHasTeamIdentity(workspaceContext) ? (
                      <>
                      {/* Access control gets the same section-label + row treatment as the
                          publish / deploy / save tiers below; its explanation moves into the
                          trailing "?" instead of a card sub-line. */}
                      <div className="share-menu-section-label share-menu-section-label--help" role="presentation">
                        <span>{t('fileViewer.workspaceShareTitle')}</span>
                        <button
                          type="button"
                          className="share-menu-help od-tooltip"
                          data-testid="workspace-access-help"
                          aria-label={shareAccess === 'private'
                            ? t('fileViewer.workspaceSharePrivateDescription')
                            : t('fileViewer.workspaceShareWorkspaceDescription')}
                          data-tooltip={shareAccess === 'private'
                            ? t('fileViewer.workspaceSharePrivateDescription')
                            : t('fileViewer.workspaceShareWorkspaceDescription')}
                          data-tooltip-placement="top"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <RemixIcon name="question-line" size={14} />
                        </button>
                      </div>
                      <div className="chrome-access-select">
                          <button
                            type="button"
                            className="chrome-access-trigger"
                            aria-haspopup="listbox"
                            aria-expanded={shareAccessMenuOpen}
                            disabled={shareAccessBusy || viewerOnly}
                            onClick={() => setShareAccessMenuOpen((v) => !v)}
                          >
                            <span className="share-menu-icon">
                              {/* recvqaVLC3MNaQ: same spinner-over-disabled fix as the
                                  ReactComponentViewer copy of this card above. */}
                              <RemixIcon
                                name={
                                  shareAccessBusy
                                    ? 'loader-4-line'
                                    : shareAccess === 'private'
                                      ? 'lock-line'
                                      : 'team-line'
                                }
                                size={16}
                                className={shareAccessBusy ? 'icon-spin' : undefined}
                              />
                            </span>
                            <span>
                              {shareAccess === 'private'
                                ? t('fileViewer.workspaceAccessPrivate')
                                : t('fileViewer.workspaceAccessMembers')}
                            </span>
                            <RemixIcon name="arrow-down-s-line" size={16} />
                          </button>
                          {shareAccessMenuOpen ? (
                            <div className="chrome-access-options" role="listbox">
                              {([
                                ['private', 'lock-line', t('fileViewer.workspaceAccessPrivate')],
                                ['workspace', 'team-line', t('fileViewer.workspaceAccessMembers')],
                              ] as const).map(([value, icon, label]) => (
                                <button
                                  key={value}
                                  type="button"
                                  role="option"
                                  aria-selected={shareAccess === value}
                                  className={shareAccess === value ? 'is-active' : undefined}
                                  disabled={shareAccessBusy || viewerOnly}
                                  onClick={() => void setWorkspaceShareAccess(value)}
                                >
                                  <span className="share-menu-icon"><RemixIcon name={icon} size={16} /></span>
                                  <span>{label}</span>
                                  {shareAccess === value ? <RemixIcon name="check-line" size={15} /> : null}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </>
                      ) : null}
                      {canPublishPublic ? (
                      <>
                      {publishProgress !== null ? (
                        <progress max={1} value={publishProgress} aria-label={t('fileViewer.publishingFile')} />
                      ) : null}
                      {filePublished ? (
                        <div className="chrome-publish-plain">
                          <div className={`chrome-publish-url${publishLinkFeedback === 'failed' ? ` ${styles.copyFallback}` : ''}`} title={publishedFileUrl}>
                              {publishedFileUrl}
                            </div>
                            <div className="chrome-publish-actions">
                              <Button
                                type="button"
                                className={styles.copyButton}
                                disabled={streaming}
                                title={streaming ? t('fileViewer.shareAfterGenerationComplete') : undefined}
                                onClick={() => {
                                  void copyPublishedFileLink();
                                }}
                              >
                                <svg
                                  width="13"
                                  height="13"
                                  viewBox={publishLinkFeedback === 'copied' ? '0 0 16 16' : '0 0 24 24'}
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                  focusable="false"
                                  className={publishLinkFeedback === 'copied' ? styles.copiedIcon : undefined}
                                >
                                  <path d={publishLinkFeedback === 'copied'
                                    ? 'm3 8 3 3 7-7'
                                    : 'M10 13.5a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 10.5a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l1.7-1.7'} />
                                </svg>
                                {publishLinkFeedback === 'copied'
                                  ? t('fileViewer.copied')
                                  : publishLinkFeedback === 'failed'
                                    ? t('useEverywhere.copyFailed')
                                    : t('fileViewer.copyShareLink')}
                              </Button>
                              <button
                                type="button"
                                className="chrome-publish-button chrome-publish-button--ghost"
                                disabled={publishingPublicFile}
                                onClick={() => {
                                  void unpublishCurrentFilePublic();
                                }}
                              >
                                {t('fileViewer.unpublishFile')}
                              </button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          className={styles.copyButton}
                          role="menuitem"
                          disabled={streaming || viewerOnly || publishingPublicFile}
                          aria-busy={publishingPublicFile}
                          title={viewerOnly ? viewerOnlyDisabledTitle : streaming ? t('fileViewer.shareAfterGenerationComplete') : undefined}
                          onClick={() => {
                            void publishCurrentFilePublic();
                          }}
                        >
                          {publishingPublicFile ? (
                            <RemixIcon name="loader-4-line" size={15} className="icon-spin" />
                          ) : (
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                              focusable="false"
                            >
                              <path d="M12 15V4m-4 4 4-4 4 4M5 20h14" />
                            </svg>
                          )}
                          <span>{publishingPublicFile
                            ? t('fileViewer.publishingFile')
                            : publishFailureKey === 'fileViewer.publishFileFailed' || publishFailureKey === 'fileViewer.publishFileTooLarge'
                              ? t('preview.retry')
                              : t('fileViewer.generateAndCopyLink')}</span>
                        </Button>
                      ) }
                      {publishFailureKey ? (
                        <p className={styles.publishError} role="status">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <circle cx="8" cy="8" r="6.2" />
                            <path d="M8 4.8v3.6M8 11h.01" />
                          </svg>
                          <span>{t(publishFailureKey)}</span>
                        </p>
                      ) : null}
                      </>
                      ) : null}
                      {menuOrigin === 'toolbar' ? (
                        <>
                          <div className="share-menu-divider" />
                          <div className="share-menu-section-label" role="presentation">
                            {t('fileViewer.shareMenuPublishOnline')}
                          </div>
                          {DEPLOY_PROVIDER_OPTIONS.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              className="share-menu-item"
                              role="menuitem"
                              disabled={streaming || viewerOnly}
                              title={
                                viewerOnly
                                  ? viewerOnlyDisabledTitle
                                  : streaming
                                    ? t('fileViewer.shareAfterGenerationComplete')
                                    : undefined
                              }
                              onClick={() => {
                                void openDeployModal(option.id);
                              }}
                            >
                              <span className="share-menu-icon"><RemixIcon name={deployActionIconFor(option.id)} size={15} /></span>
                              <span>{deployActionLabelFor(option.id)}</span>
                            </button>
                          ))}
                          {sharePageUrl ? (
                            <>
                              <button
                                type="button"
                                className="share-menu-item"
                                role="menuitem"
                                disabled={!canCopyShareLink || viewerOnly}
                                title={
                                  viewerOnly
                                    ? viewerOnlyDisabledTitle
                                    : canCopyShareLink
                                      ? undefined
                                      : shareUnavailableHint
                                }
                                onClick={() => {
                                  void copyShareLink(sharePageUrl);
                                }}
                              >
                                <span className="share-menu-icon"><RemixIcon name="file-copy-line" size={15} /></span>
                                <span>{copyShareLinkLabel}</span>
                              </button>
                              <button
                                type="button"
                                className="share-menu-item"
                                role="menuitem"
                                disabled={!canOpenSharePage || viewerOnly}
                                title={
                                  viewerOnly
                                    ? viewerOnlyDisabledTitle
                                    : canOpenSharePage
                                      ? undefined
                                      : shareLinkStatusHint || shareUnavailableHint
                                }
                                onClick={() => {
                                  if (!canOpenSharePage) return;
                                  window.open(sharePageUrl, '_blank', 'noopener');
                                }}
                              >
                                <span className="share-menu-icon"><RemixIcon name="external-link-line" size={15} /></span>
                                <span>{t('fileViewer.openSharePage')}</span>
                              </button>
                            </>
                          ) : null}
                          {sharePageUrl && (shareLinkStatusHint || shareUnavailableHint) ? (
                            <div className="share-menu-section-label" role="presentation">
                              {shareLinkStatusHint || shareUnavailableHint}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      </div>
  );
}
