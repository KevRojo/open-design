import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkspacePermissions, buildWorkspaceSeatSummary, type WorkspaceCollabContext } from '@open-design/contracts';
import { closeDatabase, insertProject, insertConversation, openDatabase, mergeSyncedPreviewComment, listPreviewComments } from '../src/db.js';
import { createVelaCliCollabClient } from '../src/collab/vela-cli-collab-client.js';
import { createCollabCloudService } from '../src/collab/collab-cloud-service.js';

let root: string | undefined;
afterEach(() => { closeDatabase(); if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

it('replays unmodified Vela cb44e7597d HTTP capture through adapter, service and SQLite', async () => {
  const wire = readFileSync(new URL('./fixtures/vela-share-downstream-cb44e7597d.json', import.meta.url), 'utf8');
  expect(createHash('sha256').update(wire).digest('hex')).toBe('1306f34a75b57468976c4133259d7aabc5b6d00cefc9f371ce3ae52ab2b70710');
  const captured = JSON.parse(wire);
  // Database event seq/timestamps in provenance are NOT transport fields.
  expect(captured.comments.every((comment: Record<string, unknown>) => !('seq' in comment))).toBe(true);
  expect(captured.comments[0]).not.toHaveProperty('createdAt');
  expect(captured.comments[2]).not.toHaveProperty('authorKind');
  expect(captured.comments[3]).not.toHaveProperty('filePath');
  expect(captured.comments[3]).not.toHaveProperty('label');
  root = mkdtempSync(join(tmpdir(), 'od-real-vela-wire-'));
  const db = openDatabase(root);
  const projectId = 'share-management-project';
  insertProject(db, { id: projectId, name: 'Capture', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'local', projectId, title: 'Local', createdAt: 1, updatedAt: 1 });
  const context: WorkspaceCollabContext = {
    workspaceId: 'fixture-space', workspaceType: 'team', workspaceMemberId: 'member-owner',
    role: 'owner', memberStatus: 'active', lifecycleState: 'active', billingState: 'active',
    planId: null, providerMode: 'platform_credits', teamId: 'fixture-space',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
  };
  const calls: string[][] = [];
  const received: unknown[] = [];
  const errors: unknown[] = [];
  const client = createVelaCliCollabClient({ run: async (args, workspaceId) => {
    expect(workspaceId).toBe(context.workspaceId);
    calls.push(args); return wire;
  } });
  const before = Date.now();
  const service = createCollabCloudService({
    client, listProjectIds: () => [], resolveLocalConversationId: () => 'local',
    resolveProjectWorkspaceContext: async () => context,
    listPersonalCommentRelayFilePaths: () => new Set(['index.html']),
    mergeComment: ({ projectId: id, conversationId, comment }) => {
      received.push(comment);
      const result = mergeSyncedPreviewComment(db, id, conversationId, comment);
      if (received.length === 2) {
        expect(listPreviewComments(db, id, conversationId).find((row) => row.id === comment.id)?.label).toBe('Hero heading');
      }
      return result;
    },
    onError: (error) => errors.push(error),
  });
  try {
    expect(await service.pullProject(projectId, context)).toBe(true);
    expect(errors).toEqual([]);
    expect(received).toEqual(captured.comments);
    const rows = listPreviewComments(db, projectId, 'local');
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === captured.comments[0].id)).toMatchObject({
      label: 'heading', authorKind: 'user', authorAppUserId: 'share-fixture-viewer-app', authorMemberId: undefined,
    });
    expect(rows.find((row) => row.id === captured.comments[0].id)!.createdAt).toBeGreaterThanOrEqual(before);
    expect(rows.find((row) => row.id === 'capture-member')).toMatchObject({
      authorMemberId: 'member-owner', authorAppUserId: undefined, createdAt: captured.comments[2].createdAt,
    });
    expect(rows.some((row) => row.id === captured.comments[3].id)).toBe(false);
    // Replaying the same captured bytes is a local retry probe, not another live HTTP capture.
    expect(await service.pullProject(projectId, context)).toBe(true);
    expect(listPreviewComments(db, projectId, 'local')).toHaveLength(2);
    expect(calls.map((args) => args.slice(3))).toEqual([
      ['--since-seq', '0', '--author-kinds', 'member,user'],
      ['--since-seq', '4', '--author-kinds', 'member,user'],
    ]);
  } finally { service.dispose(); }
});
