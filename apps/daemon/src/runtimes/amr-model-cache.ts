import type { AmrModelsResponse } from '@open-design/contracts';
import type { RuntimeModelOption } from './types.js';

type RemoteCacheEntry = {
  models: RuntimeModelOption[];
  fetchedAt: number;
};

type Fetchers = {
  fetchPreset: () => Promise<RuntimeModelOption[]>;
  fetchRemote: () => Promise<RuntimeModelOption[]>;
};

type CacheState = {
  remote: RemoteCacheEntry | null;
  inFlight: Promise<void> | null;
  lastRemoteError: string | null;
  pendingReads: number;
};

// The AMR model catalog changes rarely (new models land on the order of days),
// and a cached remote list is returned immediately while a refresh runs in the
// background — `get()` never blocks on the network when a cached entry exists.
// The per-run preflight now also reads this cache, so a tight interval would
// spawn `vela model list` far more often than the catalog actually changes.
// Refresh at most once every 10 minutes per cache key; callers always get the
// last-known catalog instantly in between.
const DEFAULT_REMOTE_REFRESH_INTERVAL_MS = 10 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export class AmrModelLoadingCache {
  private readonly states = new Map<string, CacheState>();

  private activeProbes = 0;

  constructor(
    private readonly refreshIntervalMs = DEFAULT_REMOTE_REFRESH_INTERVAL_MS,
    private readonly maxEntries = 64,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('AMR model cache capacity must be a positive integer');
    }
  }

  async get(cacheKey: string, fetchers: Fetchers): Promise<AmrModelsResponse> {
    const state = this.stateFor(cacheKey);
    const now = Date.now();
    if (state.remote) {
      const staleByAge = now - state.remote.fetchedAt >= this.refreshIntervalMs;
      if (staleByAge) this.startRefresh(state, fetchers.fetchRemote);
      return {
        source: 'remote',
        models: state.remote.models,
        refreshing: state.inFlight !== null,
        ...(state.inFlight || state.lastRemoteError ? { stale: true } : {}),
        ...(state.lastRemoteError ? { remoteError: state.lastRemoteError } : {}),
      };
    }

    if (this.activeProbes >= this.maxEntries) {
      throw new Error('AMR model cache is busy; retry later');
    }
    state.pendingReads += 1;
    this.activeProbes += 1;
    let preset: RuntimeModelOption[];
    try {
      preset = await fetchers.fetchPreset();
    } finally {
      state.pendingReads -= 1;
      this.activeProbes -= 1;
    }
    this.startRefresh(state, fetchers.fetchRemote);
    return {
      source: 'preset',
      models: preset,
      refreshing: state.inFlight !== null,
      ...(state.lastRemoteError ? { remoteError: state.lastRemoteError } : {}),
    };
  }

  warm(cacheKey: string, fetchRemote: () => Promise<RuntimeModelOption[]>): void {
    this.startRefresh(this.stateFor(cacheKey), fetchRemote);
  }

  invalidate(cacheKey: string): void {
    this.states.delete(cacheKey);
  }

  /**
   * Drop every cached catalog entry.
   *
   * Path A discovery is workspace-partitioned (`velaWorkspaceId` is part of
   * the cache key). Plan and wallet refreshes can change Link entitlements for
   * every workspace that shares the active credential, so invalidating only
   * the unscoped personal key would leave Team-scoped catalogs serving stale
   * locks for up to the refresh TTL.
   */
  invalidateAll(): void {
    this.states.clear();
  }

  resetForTests(): void {
    this.states.clear();
  }

  private stateFor(cacheKey: string): CacheState {
    const existing = this.states.get(cacheKey);
    if (existing) {
      this.states.delete(cacheKey);
      this.states.set(cacheKey, existing);
      return existing;
    }
    // Invalidation may detach active probes; keep counting them until they
    // finish so cache churn cannot bypass the subprocess budget.
    if (this.activeProbes >= this.maxEntries) {
      throw new Error('AMR model cache is busy; retry later');
    }
    if (this.states.size >= this.maxEntries) {
      const idle = [...this.states].find(([, state]) => !state.inFlight && state.pendingReads === 0);
      if (!idle) throw new Error('AMR model cache is busy; retry later');
      this.states.delete(idle[0]);
    }
    const created: CacheState = {
      remote: null,
      inFlight: null,
      lastRemoteError: null,
      pendingReads: 0,
    };
    this.states.set(cacheKey, created);
    return created;
  }

  private startRefresh(state: CacheState, fetchRemote: () => Promise<RuntimeModelOption[]>): void {
    if (state.inFlight || this.activeProbes >= this.maxEntries) return;
    this.activeProbes += 1;
    state.inFlight = (async () => {
      try {
        const models = await fetchRemote();
        if (models.length === 0) {
          throw new Error('AMR remote model list returned no chat models');
        }
        state.remote = { models, fetchedAt: Date.now() };
        state.lastRemoteError = null;
      } catch (error) {
        state.lastRemoteError = errorMessage(error);
      } finally {
        state.inFlight = null;
        this.activeProbes -= 1;
      }
    })();
  }
}

export const amrModelLoadingCache = new AmrModelLoadingCache();
