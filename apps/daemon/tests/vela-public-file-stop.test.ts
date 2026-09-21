import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { WorkspaceDirectoryItem } from '@open-design/contracts';
import { createVelaPublicFileStop } from '../src/collab/vela-public-file-stop.js';
import type { VelaControlApiContext } from '../src/integrations/vela.js';
import type { fetchVelaWorkspaceDirectory } from '../src/collab/vela-workspace-context.js';
it.each([true, false])('uses real HTTP for directory verification and pinned stop, original member matches=%s', async (matches) => {
  const requests: Array<{ url: string | undefined; method: string | undefined; authorization: string | undefined; workspace: string | string[] | undefined; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, workspace: req.headers['x-vela-workspace-id'], body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/workspaces') res.end(JSON.stringify({ items: [{ ...member, workspaceMemberId: matches ? member.workspaceMemberId : 'other' }] }));
    else res.end(JSON.stringify({ status: 'stopped' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP listener');
    const captured = { ...session(), apiUrl: `http://127.0.0.1:${address.port}` };
    const prepare = createVelaPublicFileStop({ readSession: () => captured });
    const operation = await prepare(key);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: '/api/v1/workspaces', method: 'GET', authorization: 'Bearer fixture-key' });
    captured.controlKey = 'switched-account';
    if (matches) {
      expect(operation).not.toBeNull(); await operation!.stop();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual({ url: '/api/v1/collab/shares/a%2Fb/stop', method: 'POST', authorization: 'Bearer fixture-key', workspace: 'workspace', body: JSON.stringify({ projectId: 'project' }) });
    } else {
      expect(operation).toBeNull(); expect(requests).toHaveLength(1);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

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
