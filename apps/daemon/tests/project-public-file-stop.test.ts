import { expect, it, vi } from 'vitest';
import { createInMemoryPublicFilePublicationStore, type PreparePublicFileStop } from '../src/collab/public-file-publication-store.js';
import { createProjectPublicFileStop } from '../src/collab/project-public-file-stop.js';
const scope = { resourceTeamId: 'workspace', ownerMemberId: 'member', projectId: 'project' };
const publication = (slug: string) => ({ slug, url: `https://example.test/${slug}`, fileName: 'index.html' });
function setup() {
  const store = createInMemoryPublicFilePublicationStore();
  const stop = vi.fn(async () => {});
  const prepare = vi.fn<PreparePublicFileStop>(async () => ({ ...scope, stop }));
  return { store, stop, prepare, run: createProjectPublicFileStop(store, prepare) };
}
it('stops every file before allowing deletion and does not touch another owner', async () => {
  const f = setup();
  f.store.set({ ...scope, filePath: 'a.html' }, publication('a'));
  f.store.set({ ...scope, filePath: 'b.html' }, publication('b'));
  f.store.set({ ...scope, ownerMemberId: 'other', filePath: 'a.html' }, publication('other'));
  await f.run(scope);
  expect(f.stop).toHaveBeenCalledTimes(2); expect(f.store.listByProject(scope)).toEqual([]);
  expect(f.store.get({ ...scope, ownerMemberId: 'other', filePath: 'a.html' })?.slug).toBe('other');
});
it('persists each failed stop independently and rejects the deletion continuation', async () => {
  const f = setup(); f.stop.mockRejectedValue(new Error('network'));
  for (const filePath of ['a.html', 'b.html']) f.store.set({ ...scope, filePath }, publication(filePath));
  await expect(f.run(scope)).rejects.toThrow('PUBLIC_FILE_STOP_PENDING');
  expect(f.store.listByProject(scope)).toHaveLength(2); expect(f.store.listStops()).toHaveLength(2);
  expect(f.store.listStops().every((task) => task.failureCount === 1)).toBe(true);
});
it('defers on missing identity without sending a stop', async () => {
  const f = setup(); f.prepare.mockResolvedValue(null);
  f.store.set({ ...scope, filePath: 'index.html' }, publication('a'));
  await expect(f.run(scope)).rejects.toThrow('PUBLIC_FILE_STOP_PENDING');
  expect(f.stop).not.toHaveBeenCalled(); expect(f.store.listStops()).toHaveLength(1);
});
it('rejects preparation under a different member', async () => {
  const f = setup(); f.prepare.mockResolvedValue({ ...scope, ownerMemberId: 'other', stop: f.stop });
  f.store.set({ ...scope, filePath: 'index.html' }, publication('a'));
  await expect(f.run(scope)).rejects.toThrow('PUBLIC_FILE_STOP_PENDING');
  expect(f.stop).not.toHaveBeenCalled();
});
it('does not clear a replacement publication or queue a stale retry after an in-flight failure', async () => {
  const f = setup(); const target = { ...scope, filePath: 'index.html' };
  f.store.set(target, publication('a'));
  f.stop.mockImplementation(async () => { f.store.set(target, publication('a')); throw new Error('old stop failed'); });
  await expect(f.run(scope)).rejects.toThrow('PUBLIC_FILE_STOP_PENDING');
  expect(f.store.get(target)?.slug).toBe('a'); expect(f.store.listStops()).toEqual([]);
});
it('rejects deletion if a new file appears while stopping', async () => {
  const f = setup(); f.store.set({ ...scope, filePath: 'index.html' }, publication('a'));
  f.stop.mockImplementation(async () => { f.store.set({ ...scope, filePath: 'new.html' }, publication('new')); });
  await expect(f.run(scope)).rejects.toThrow('PUBLIC_FILE_STOP_PENDING');
  expect(f.store.listByProject(scope).map((row) => row.slug)).toEqual(['new']);
});
it('does nothing for a project without publications', async () => {
  const f = setup(); await f.run(scope); expect(f.prepare).not.toHaveBeenCalled();
});
