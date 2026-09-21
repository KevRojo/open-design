import type Database from 'better-sqlite3';
import { cancelPersonalCommentRelayOutbox } from './comment-relay-outbox.js';

type SqliteDb = Database.Database;

export interface PublicFilePublicationScope {
  resourceTeamId: string;
  ownerMemberId: string;
  projectId: string;
  filePath: string;
}

export interface PublicFilePublication {
  url: string;
  slug: string;
  fileName: string;
}

export interface PublicFilePublicationStore {
  get(scope: PublicFilePublicationScope): PublicFilePublication | null;
  set(
    scope: PublicFilePublicationScope,
    publication: PublicFilePublication,
  ): void;
  delete(scope: PublicFilePublicationScope): void;
}

/** Full store capability for consumers that enumerate project publications. */
export interface ProjectPublicFilePublicationStore extends PublicFilePublicationStore {
  /** Lists this principal's project with the most recent successful publish time in epoch ms. */
  listByProject(scope: {
    resourceTeamId: string;
    ownerMemberId: string;
    projectId: string;
  }): ReadonlyArray<{
    filePath: string;
    slug: string;
    publishedAt: number;
  }>;
}

export interface PublicFileStopTaskKey extends PublicFilePublicationScope {
  slug: string;
}

export interface PublicFileStopTask extends PublicFileStopTaskKey {
  failureCount: number;
}

/** Internal persistence only: callers own stop requests and startup scheduling. */
export interface StopQueuePublicFilePublicationStore extends ProjectPublicFilePublicationStore {
  /** Record initial failure (count 1); existing tasks, even exhausted ones, are unchanged. */
  enqueueStop(key: PublicFileStopTaskKey): void;
  /** Detached snapshot including exhausted tasks for diagnostics; no raw errors are stored. */
  listStops(): ReadonlyArray<PublicFileStopTask>;
  /** One entry per retryable key for one startup pass; no retries are executed here. */
  listRetryableStops(): ReadonlyArray<PublicFileStopTask>;
  /** Increment an existing task once, capped at five total failures; absent tasks are ignored. */
  recordStopFailure(key: PublicFileStopTaskKey): void;
  /** After successful stop, remove only this exact task, including explicitly resolved terminal tasks. */
  completeStop(key: PublicFileStopTaskKey): void;
}

const MAX_STOP_FAILURES = 5;

function stopTaskValues(key: PublicFileStopTaskKey): [string, string, string, string, string] {
  return [key.resourceTeamId, key.ownerMemberId, key.projectId, key.filePath, key.slug];
}

function stopTaskKey(key: PublicFileStopTaskKey): string {
  return JSON.stringify(stopTaskValues(key));
}

export function migratePublicFilePublications(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_file_publications (
      resource_team_id TEXT NOT NULL,
      owner_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT NOT NULL,
      slug TEXT NOT NULL,
      file_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (resource_team_id, owner_member_id, project_id, file_path)
    );
    CREATE TABLE IF NOT EXISTS public_file_stop_queue (
      resource_team_id TEXT NOT NULL,
      owner_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      slug TEXT NOT NULL,
      failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 1 AND 5),
      PRIMARY KEY (resource_team_id, owner_member_id, project_id, file_path, slug)
    );
  `);
}

function scopeKey(scope: PublicFilePublicationScope): string {
  return JSON.stringify([
    scope.resourceTeamId,
    scope.ownerMemberId,
    scope.projectId,
    scope.filePath,
  ]);
}

// Use the same locale-independent ordering for both backends, including Unicode paths.
function comparePublicationFilePaths(a: { filePath: string }, b: { filePath: string }): number {
  if (a.filePath === b.filePath) return 0;
  return a.filePath < b.filePath ? -1 : 1;
}

export function createInMemoryPublicFilePublicationStore(): StopQueuePublicFilePublicationStore {
  const stopTasks = new Map<string, PublicFileStopTask>();
  const publications = new Map<string, {
    scope: PublicFilePublicationScope;
    publication: PublicFilePublication;
    publishedAt: number;
  }>();
  return {
    enqueueStop(key) {
      const id = stopTaskKey(key);
      if (!stopTasks.has(id)) {
        stopTasks.set(id, {
          resourceTeamId: key.resourceTeamId,
          ownerMemberId: key.ownerMemberId,
          projectId: key.projectId,
          filePath: key.filePath,
          slug: key.slug,
          failureCount: 1,
        });
      }
    },
    listStops: () => [...stopTasks.values()].map((task) => ({ ...task })),
    listRetryableStops: () => [...stopTasks.values()]
      .filter((task) => task.failureCount < MAX_STOP_FAILURES)
      .map((task) => ({ ...task })),
    recordStopFailure(key) {
      const task = stopTasks.get(stopTaskKey(key));
      if (task && task.failureCount < MAX_STOP_FAILURES) task.failureCount += 1;
    },
    completeStop(key) { stopTasks.delete(stopTaskKey(key)); },
    get: (scope) => publications.get(scopeKey(scope))?.publication ?? null,
    listByProject: (scope) => [...publications.values()]
      .filter((entry) => entry.scope.resourceTeamId === scope.resourceTeamId
        && entry.scope.ownerMemberId === scope.ownerMemberId
        && entry.scope.projectId === scope.projectId)
      .map((entry) => ({
        filePath: entry.scope.filePath,
        slug: entry.publication.slug,
        publishedAt: entry.publishedAt,
      }))
      .sort(comparePublicationFilePaths),
    set: (scope, publication) => {
      publications.set(scopeKey(scope), {
        scope: { ...scope },
        publication,
        publishedAt: Date.now(),
      });
    },
    delete: (scope) => {
      publications.delete(scopeKey(scope));
    },
  };
}

/**
 * Persist public snapshot identities under the exact resource-hub principal
 * that created them. There is deliberately no project foreign key: deleting a
 * local project must not erase the slug needed to redact its still-public
 * remote snapshot.
 */
export function createSqlitePublicFilePublicationStore(
  db: SqliteDb,
  now: () => number = Date.now,
): StopQueuePublicFilePublicationStore {
  const selectRow = db.prepare(`
    SELECT url, slug, file_name AS fileName
      FROM public_file_publications
     WHERE resource_team_id = ?
       AND owner_member_id = ?
       AND project_id = ?
       AND file_path = ?
  `);
  const selectProjectRows = db.prepare(`
    SELECT file_path AS filePath, slug, updated_at AS publishedAt
      FROM public_file_publications
     WHERE resource_team_id = ?
       AND owner_member_id = ?
       AND project_id = ?
  `);
  const upsertRow = db.prepare(`
    INSERT INTO public_file_publications
      (resource_team_id, owner_member_id, project_id, file_path,
       url, slug, file_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_team_id, owner_member_id, project_id, file_path)
    DO UPDATE SET
      url = excluded.url,
      slug = excluded.slug,
      file_name = excluded.file_name,
      updated_at = excluded.updated_at
  `);
  const deleteRow = db.prepare(`
    DELETE FROM public_file_publications
     WHERE resource_team_id = ?
       AND owner_member_id = ?
       AND project_id = ?
       AND file_path = ?
  `);

  const deletePublicationAndCancelOutbox = db.transaction((scope: PublicFilePublicationScope) => {
    deleteRow.run(
      scope.resourceTeamId,
      scope.ownerMemberId,
      scope.projectId,
      scope.filePath,
    );
    cancelPersonalCommentRelayOutbox(db, scope);
  });

  // Independent of publications/projects: replacement slugs and local deletion
  // must not erase an outstanding remote stop, including exhausted diagnostics.
  const stopSelect = `SELECT resource_team_id AS resourceTeamId,
    owner_member_id AS ownerMemberId, project_id AS projectId,
    file_path AS filePath, slug, failure_count AS failureCount
    FROM public_file_stop_queue`;
  const selectStops = db.prepare(stopSelect);
  const selectRetryableStops = db.prepare(`${stopSelect} WHERE failure_count < ?`);
  const enqueueStop = db.prepare(`
    INSERT INTO public_file_stop_queue
      (resource_team_id, owner_member_id, project_id, file_path, slug, failure_count)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(resource_team_id, owner_member_id, project_id, file_path, slug) DO NOTHING
  `);
  const failStop = db.prepare(`UPDATE public_file_stop_queue
    SET failure_count = failure_count + 1 WHERE resource_team_id = ? AND owner_member_id = ?
    AND project_id = ? AND file_path = ? AND slug = ? AND failure_count < ?`);
  const completeStop = db.prepare(`DELETE FROM public_file_stop_queue WHERE resource_team_id = ?
    AND owner_member_id = ? AND project_id = ? AND file_path = ? AND slug = ?`);

  return {
    enqueueStop(key) { enqueueStop.run(...stopTaskValues(key)); },
    listStops() { return selectStops.all() as PublicFileStopTask[]; },
    listRetryableStops() { return selectRetryableStops.all(MAX_STOP_FAILURES) as PublicFileStopTask[]; },
    recordStopFailure(key) { failStop.run(...stopTaskValues(key), MAX_STOP_FAILURES); },
    completeStop(key) { completeStop.run(...stopTaskValues(key)); },
    get(scope) {
      const row = selectRow.get(
        scope.resourceTeamId,
        scope.ownerMemberId,
        scope.projectId,
        scope.filePath,
      ) as { url?: unknown; slug?: unknown; fileName?: unknown } | undefined;
      if (
        !row
        || typeof row.url !== 'string'
        || typeof row.slug !== 'string'
        || typeof row.fileName !== 'string'
      ) {
        return null;
      }
      return { url: row.url, slug: row.slug, fileName: row.fileName };
    },
    listByProject(scope) {
      const rows = selectProjectRows.all(
        scope.resourceTeamId,
        scope.ownerMemberId,
        scope.projectId,
      ) as Array<{ filePath: string; slug: string; publishedAt: number }>;
      return rows.map((row) => ({
        filePath: row.filePath,
        slug: row.slug,
        publishedAt: row.publishedAt,
      })).sort(comparePublicationFilePaths);
    },
    set(scope, publication) {
      const timestamp = now();
      upsertRow.run(
        scope.resourceTeamId,
        scope.ownerMemberId,
        scope.projectId,
        scope.filePath,
        publication.url,
        publication.slug,
        publication.fileName,
        timestamp,
        timestamp,
      );
    },
    delete(scope) {
      // A successful public-file stop is authoritative locally. Remove its
      // witness and every pre-stop personal relay revision as one SQLite
      // transaction, so immediate re-publication cannot revive stale rows.
      deletePublicationAndCancelOutbox(scope);
    },
  };
}

/**
 * Prepare an operation bound to the queued resource team AND member. Return null
 * when capability/identity is unavailable; never resolve to a different account.
 * Preparation must not send the stop request. The returned operation must retain
 * the verified credentials rather than consulting mutable current-account state.
 */
interface PreparedPublicFileStop {
  resourceTeamId: string;
  ownerMemberId: string;
  stop(): Promise<void>;
}

export type PreparePublicFileStop = (
  key: Readonly<PublicFileStopTaskKey>,
) => Promise<PreparedPublicFileStop | null>;

interface PublicFileStopStartupResult {
  stopped: number;
  failed: number;
  deferred: number;
  persistenceFailures: number;
}

/** One pass per daemon lifecycle, not per route registration or request. */
export function createPublicFileStopStartup(
  store: StopQueuePublicFilePublicationStore,
  prepare: PreparePublicFileStop | null,
): () => Promise<PublicFileStopStartupResult> {
  let started: Promise<PublicFileStopStartupResult> | undefined;
  return () => started ??= Promise.resolve().then(async () => {
    const result = { stopped: 0, failed: 0, deferred: 0, persistenceFailures: 0 };
    const seen = new Set<string>();
    for (const task of store.listRetryableStops()) {
      const key: PublicFileStopTaskKey = {
        resourceTeamId: task.resourceTeamId,
        ownerMemberId: task.ownerMemberId,
        projectId: task.projectId,
        filePath: task.filePath,
        slug: task.slug,
      };
      const id = stopTaskKey(key);
      if (seen.has(id)) continue;
      seen.add(id);
      let operation: PreparedPublicFileStop | null = null;
      try { operation = await prepare?.(Object.freeze(key)) ?? null; } catch { /* No verified operation. */ }
      if (!operation
        || operation.resourceTeamId !== key.resourceTeamId
        || operation.ownerMemberId !== key.ownerMemberId) {
        result.deferred++;
        continue;
      }
      let failed = false;
      try { await operation.stop(); } catch { failed = true; }
      // Persistence errors must not masquerade as network failures or success.
      try {
        if (failed) {
          store.recordStopFailure(key);
          result.failed++;
        } else {
          store.completeStop(key);
          result.stopped++;
        }
      } catch {
        result.persistenceFailures++;
      }
    }
    return result;
  });
}
