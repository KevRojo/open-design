import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishVelaShareVersion } from '../src/collab/vela-share-publish.js';
import { runPinnedVelaCommand } from '../src/collab/vela-pinned-command.js';

// Explicit source-built executable only; never use a developer's login/CLI.
it.skipIf(!process.env.OD_TEST_VELA_BIN).each([200, 403])('publishes a stable alias with real Go CLI, binding HTTP=%s', async (bindingStatus) => {
  const binary = process.env.OD_TEST_VELA_BIN;
  if (!binary) throw new Error('explicit test CLI required');
  const root = await mkdtemp(path.join(tmpdir(), 'od-go-publish-'));
  const requests: Array<{ url: string | undefined; method: string | undefined; bearer: string | undefined; workspace: string | string[] | undefined; body: unknown }> = [];
  const input = { workspaceId: 'workspace', projectId: 'project', resourceId: 'resource', slug: 'stable', sourceKey: 'index.html', entryPath: 'index.html', name: 'Design', versionId: 'immutable-upload' };
  const receipt = { slug: input.slug, version: 2, publishedAt: 1234, entryPath: 'index.html', snapshot: { slug: 'snapshot-not-alias', versionId: input.versionId, name: 'Design', kind: 'project' } };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url, method: req.method, bearer: req.headers.authorization, workspace: req.headers['x-vela-workspace-id'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/resources/resource/shares') res.end(JSON.stringify(receipt));
    else if (req.url === '/api/v1/collab/shares') {
      res.statusCode = bindingStatus;
      res.end(JSON.stringify(bindingStatus === 200 ? { projectId: 'project', slug: 'stable', status: 'active' } : { error: 'forbidden', message: 'synthetic private diagnostic' }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    const session = { profile: 'test' as const, apiUrl: `http://127.0.0.1:${address.port}`, controlKey: 'synthetic-key', user: null, configMtimeMs: null };
    const pending = publishVelaShareVersion(input, args => runPinnedVelaCommand({ args, session, dataRoot: root, workspaceId: input.workspaceId, configuredEnv: { VELA_BIN: binary } }));
    if (bindingStatus === 200) expect(await pending).toEqual({ slug: 'stable', version: 2, publishedAt: 1234, entryPath: 'index.html' });
    else await expect(pending).rejects.toThrow(/^PUBLIC_SHARE_PUBLISH_FAILED$/);
    // The first request succeeded even when the second failed: rejection is not
    // evidence of rollback. The adapter must not repeat either remote mutation.
    expect(requests).toEqual([
      { url: '/api/v1/resources/resource/shares', method: 'POST', bearer: 'Bearer synthetic-key', workspace: 'workspace', body: { slug: 'stable', sourceKey: 'index.html', entryPath: 'index.html', name: 'Design', versionId: 'immutable-upload' } },
      { url: '/api/v1/collab/shares', method: 'POST', bearer: 'Bearer synthetic-key', workspace: 'workspace', body: { projectId: 'project', slug: 'stable' } },
    ]);
    expect(await readdir(root)).toEqual([]);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
