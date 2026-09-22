import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runVelaCommand } from '../integrations/vela-command.js';
import type { VelaControlApiContext } from '../integrations/vela.js';

export interface PinnedVelaCommandInput {
  args: string[];
  session: VelaControlApiContext;
  /** Resolved daemon data root, supplied by the composition root. No fallback. */
  dataRoot: string;
  workspaceId: string;
  configuredEnv?: Record<string, string>;
}

/** Isolate Go CLI profile loading from concurrent login/account changes.
 * Credentials are never command arguments. The runner settles only after its
 * child has exited (including timeout termination), then the config is removed.
 */
export async function runPinnedVelaCommand(
  input: PinnedVelaCommandInput,
  run: typeof runVelaCommand = runVelaCommand,
): Promise<string> {
  try {
    const { profile, apiUrl, controlKey } = input.session;
    const { dataRoot, workspaceId } = input;
    const args = [...input.args];
    const configuredEnv = { ...input.configuredEnv };
    if (!path.isAbsolute(dataRoot) || !workspaceId.trim() || !apiUrl.trim() || !controlKey.trim()
      || !['prod', 'test', 'feature-test', 'local'].includes(profile)) {
      throw new Error('missing pinned CLI context');
    }
    const home = await mkdtemp(path.join(dataRoot, 'vela-session-'));
    try {
      await writeFile(path.join(home, 'config.json'), JSON.stringify({
        profiles: { [profile]: { controlKey, apiUrl } },
      }), { mode: 0o600, flag: 'wx' });
      return await run(args, {
        configuredEnv: {
          ...configuredEnv,
          AMR_HOME: home,
          VELA_PROFILE: profile,
          VELA_API_URL: apiUrl,
          VELA_WORKSPACE_ID: workspaceId,
        },
        timeoutMs: 30_000,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  } catch {
    throw new Error('VELA_PINNED_COMMAND_FAILED');
  }
}
