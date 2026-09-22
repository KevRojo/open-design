import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPinnedVelaCommand } from '../src/collab/vela-pinned-command.js';
import type { VelaControlApiContext } from '../src/integrations/vela.js';
import type { runVelaCommand } from '../src/integrations/vela-command.js';
it.each([false, true])('pins CLI session until settlement and cleans its private config, rejection=%s', async (reject) => {
  const root = await mkdtemp(path.join(tmpdir(), 'od-pinned-cli-'));
  try {
    const session: VelaControlApiContext = { profile: 'test', apiUrl: 'https://example.test', controlKey: 'synthetic-key', user: null, configMtimeMs: null };
    const args = ['share', 'stop', 'stable', '--project-id', 'project', '--json'];
    const run = vi.fn<typeof runVelaCommand>().mockImplementation(async (argv, options) => {
      expect(argv).toEqual(['share', 'stop', 'stable', '--project-id', 'project', '--json']);
      const env = options?.configuredEnv;
      expect(env).toMatchObject({ VELA_PROFILE: 'test', VELA_API_URL: 'https://example.test', VELA_WORKSPACE_ID: 'workspace', VELA_BIN: 'fixture-bin' });
      expect(options?.timeoutMs).toBe(30_000);
      const home = env?.AMR_HOME; if (!home) throw new Error('missing pinned home');
      expect(path.relative(root, home).startsWith('..')).toBe(false);
      const config = path.join(home, 'config.json');
      expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ profiles: { test: { controlKey: 'synthetic-key', apiUrl: 'https://example.test' } } });
      if (process.platform !== 'win32') {
        expect((await stat(home)).mode & 0o777).toBe(0o700);
        expect((await stat(config)).mode & 0o777).toBe(0o600);
      }
      if (reject) throw new Error('sensitive child diagnostics');
      return '{"status":"stopped"}';
    });
    const pending = runPinnedVelaCommand({ args, session, dataRoot: root, workspaceId: 'workspace', configuredEnv: { AMR_HOME: 'wrong-home', VELA_PROFILE: 'prod', VELA_API_URL: 'https://wrong.test', VELA_WORKSPACE_ID: 'wrong', VELA_BIN: 'fixture-bin' } }, run);
    session.controlKey = 'switched-key'; session.apiUrl = 'https://switched.test'; args[2] = 'wrong-slug';
    if (reject) await expect(pending).rejects.toThrow(/^VELA_PINNED_COMMAND_FAILED$/);
    else expect(await pending).toBe('{"status":"stopped"}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
