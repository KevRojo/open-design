import { expect, it, vi } from 'vitest';
import { createInMemoryPublicFilePublicationStore, createPublicFileStopStartup } from '../src/collab/public-file-publication-store.js';
const key = { resourceTeamId: 'team', ownerMemberId: 'owner', projectId: 'project', filePath: 'index.html', slug: 'stable' };
const publication = { slug: key.slug, url: 'https://example.test/stable', fileName: key.filePath };
it('does not stop a new publication for a legacy task without a generation', async () => {
  const store = createInMemoryPublicFilePublicationStore(); store.enqueueStop(key); store.set(key, publication);
  const stop = vi.fn(async () => {});
  expect((await createPublicFileStopStartup(store, async () => ({ ...key, stop }))()).deferred).toBe(1);
  expect(stop).not.toHaveBeenCalled(); expect(store.listStops()).toHaveLength(1);
});
it('rechecks generation after awaiting identity preparation', async () => {
  const store = createInMemoryPublicFilePublicationStore(); store.set(key, publication); store.enqueueStop(key);
  const stop = vi.fn(async () => {});
  const result = await createPublicFileStopStartup(store, async () => {
    store.set(key, publication); return { ...key, stop };
  })();
  expect(result.deferred).toBe(1); expect(stop).not.toHaveBeenCalled(); expect(store.listStops()).toHaveLength(1);
});
it.each([false, true])('a late response cannot clear or increment a replacement queue task: failed=%s', async (failed) => {
  const store = createInMemoryPublicFilePublicationStore(); store.set(key, publication); store.enqueueStop(key);
  const result = await createPublicFileStopStartup(store, async () => ({ ...key, stop: async () => {
    store.set(key, publication); store.completeStop(key); store.enqueueStop(key);
    if (failed) throw new Error('old network error');
  } }))();
  expect(result.deferred).toBe(1);
  expect(store.get(key)).toEqual(publication);
  expect(store.listStops()).toEqual([{ ...key, publicationRevision: store.getRevision(key)!.token, failureCount: 1 }]);
});
it('successful matching retry clears its publication witness and task', async () => {
  const store = createInMemoryPublicFilePublicationStore(); store.set(key, publication); store.enqueueStop(key);
  const result = await createPublicFileStopStartup(store, async () => ({ ...key, stop: async () => {} }))();
  expect(result.stopped).toBe(1); expect(store.get(key)).toBeNull(); expect(store.listStops()).toEqual([]);
});
