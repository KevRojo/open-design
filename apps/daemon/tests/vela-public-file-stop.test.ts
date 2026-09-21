import { expect, it, vi } from 'vitest';
import type { WorkspaceDirectoryItem } from '@open-design/contracts';
import { createVelaPublicFileStop } from '../src/collab/vela-public-file-stop.js';
import type { VelaControlApiContext } from '../src/integrations/vela.js';
import type { fetchVelaWorkspaceDirectory } from '../src/collab/vela-workspace-context.js';
const key = { resourceTeamId: 'workspace', ownerMemberId: 'member', projectId: 'project', filePath: 'index.html', slug: 'a/b' };
const member: WorkspaceDirectoryItem = { workspaceId: 'workspace', workspaceName: 'W', workspaceType: 'personal', workspaceMemberId: 'member', role: 'member', memberStatus: 'active', lifecycleState: 'active' };
const session = (): VelaControlApiContext => ({ profile: 'test', apiUrl: 'https://api.example.test', controlKey: 'fixture-key', user: null, configMtimeMs: null });
function fixture(items = [member]) {
  const captured = session();
  const readSession = vi.fn(() => captured);
  const fetchDirectory = vi.fn<typeof fetchVelaWorkspaceDirectory>(async () => ({ ok: true, items }));
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: 'stopped' })));
  return { captured, readSession, fetchDirectory, fetchImpl, prepare: createVelaPublicFileStop({ readSession, fetchDirectory, fetch: fetchImpl }) };
}
it('prepares without stopping and uses the exact captured credentials after account mutation', async () => {
  const f = fixture();
  const operation = await f.prepare(key);
  expect(operation).not.toBeNull();
  expect(f.fetchImpl).not.toHaveBeenCalled();
  const directoryOptions = f.fetchDirectory.mock.calls[0]![0]!;
  f.captured.controlKey = 'different-account'; f.captured.apiUrl = 'https://wrong.example.test';
  expect(directoryOptions.readSession?.()?.controlKey).toBe('fixture-key');
  await operation!.stop();
  expect(f.readSession).toHaveBeenCalledTimes(1);
  expect(f.fetchImpl).toHaveBeenCalledWith(new URL('https://api.example.test/api/v1/collab/shares/a%2Fb/stop'), expect.objectContaining({ method: 'POST', redirect: 'error', body: JSON.stringify({ projectId: 'project' }), headers: { authorization: 'Bearer fixture-key', 'x-vela-workspace-id': 'workspace', 'content-type': 'application/json' } }));
});
it.each([
  { ...member, workspaceMemberId: 'different' },
  { ...member, workspaceId: 'different' },
  { ...member, memberStatus: 'removed' as const },
  { ...member, lifecycleState: 'deleted' as const },
])('refuses an ineligible original principal: %j', async (item) => {
  const f = fixture([item]); expect(await f.prepare(key)).toBeNull(); expect(f.fetchImpl).not.toHaveBeenCalled();
});
it('defers without a session or a verified directory', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(await createVelaPublicFileStop({ readSession: () => null, fetch: fetchImpl })(key)).toBeNull();
  const f = fixture(); f.fetchDirectory.mockResolvedValue({ ok: false, items: [], reason: 'network' });
  expect(await f.prepare(key)).toBeNull(); expect(fetchImpl).not.toHaveBeenCalled();
});
it.each([new Response('{}'), new Response('{'), new Response('{}', { status: 403 }), new Response(JSON.stringify({ status: 'active' }))])('rejects unsuccessful stop receipts', async (response) => {
  const f = fixture(); f.fetchImpl.mockResolvedValue(response);
  const operation = await f.prepare(key); expect(operation).not.toBeNull();
  await expect(operation!.stop()).rejects.toThrow('PUBLIC_FILE_STOP_FAILED');
});
