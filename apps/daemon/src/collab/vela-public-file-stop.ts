import type { PreparePublicFileStop } from './public-file-publication-store.js';
import { readVelaControlApiContext } from '../integrations/vela.js';
import { fetchVelaWorkspaceDirectory } from './vela-workspace-context.js';

export interface VelaPublicFileStopOptions {
  readSession?: typeof readVelaControlApiContext;
  fetchDirectory?: typeof fetchVelaWorkspaceDirectory;
  fetch?: typeof fetch;
  configuredEnv?: Record<string, string> | (() => Record<string, string>);
}

/**
 * Bind verification and StopShareBinding to one immutable credential snapshot.
 * Workspace roles cannot substitute for the persisted original member. The
 * remote binding authority still checks project ownership when stop executes.
 * Use the same HTTP contract as Vela's Go client: CLI profile loading would
 * re-read mutable disk credentials between preparation and execution.
 */
export function createVelaPublicFileStop(options: VelaPublicFileStopOptions = {}): PreparePublicFileStop {
  const fetchImpl = options.fetch ?? fetch;
  return async (key) => {
    const configuredEnv = typeof options.configuredEnv === 'function'
      ? options.configuredEnv() : options.configuredEnv ?? {};
    const session = (options.readSession ?? readVelaControlApiContext)(process.env, configuredEnv);
    if (!session?.controlKey || !session.apiUrl) return null;
    const captured = Object.freeze({ ...session });
    const directory = await (options.fetchDirectory ?? fetchVelaWorkspaceDirectory)({
      readSession: () => captured,
      fetch: fetchImpl,
    });
    if (!directory.ok || !directory.items.some((item) =>
      item.workspaceId === key.resourceTeamId
      && item.workspaceMemberId === key.ownerMemberId
      && item.memberStatus === 'active'
      && item.lifecycleState !== 'deleted'
      && item.lifecycleState !== 'deleting'
    )) return null;
    const { resourceTeamId, ownerMemberId, projectId, slug } = key;
    return {
      resourceTeamId,
      ownerMemberId,
      async stop() {
        try {
          const response = await fetchImpl(new URL(
            `/api/v1/collab/shares/${encodeURIComponent(slug)}/stop`, captured.apiUrl,
          ), {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${captured.controlKey}`,
              'x-vela-workspace-id': resourceTeamId,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ projectId }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error('stop rejected');
          const receipt: unknown = await response.json();
          if (typeof receipt !== 'object' || receipt === null
            || !('status' in receipt) || receipt.status !== 'stopped') {
            throw new Error('invalid stop receipt');
          }
        } catch {
          // Do not leak upstream bodies, URLs or credential-bearing errors.
          throw new Error('PUBLIC_FILE_STOP_FAILED');
        }
      },
    };
  };
}
