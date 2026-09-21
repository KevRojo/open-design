import { describe, expect, it, vi } from 'vitest';
import {
  fetchVelaBillingPreflight,
  parseBillingPreflight,
} from '../src/integrations/vela-billing.js';

const preview = {
  schemaVersion: 1,
  workspaceId: 'ws',
  workspaceMemberId: 'member',
  modelId: 'model',
  generatedAt: new Date().toISOString(),
  balanceUsd: '0',
  modelCovered: true,
  funding: 'coding_plan',
  codingPlan: {
    workspaceId: 'ws',
    generatedAt: new Date().toISOString(),
    eligible: true,
    tier: 'pro',
    windows: [
      {
        policyId: '5h',
        durationSeconds: 18000,
        resetMode: 'activity_triggered',
        usedCredits: '0',
        limitCredits: '100',
        remainingCredits: '100',
        windowStart: null,
        resetsAt: null,
      },
    ],
  },
};

describe('Vela billing preflight adapter', () => {
  it('preserves the member pool and passes the model as one CLI argument', async () => {
    const run = vi.fn(async () => JSON.stringify(preview));
    expect(await fetchVelaBillingPreflight('ws', 'model', { run })).toEqual(preview);
    expect(run).toHaveBeenCalledWith([
      'preflight',
      '--workspace-id',
      'ws',
      '--format',
      'json',
      '--model',
      'model',
    ]);
  });
  it('rejects mismatched identity, model and malformed quota evidence', () => {
    for (const change of [
      { workspaceId: 'other' },
      { modelId: 'other' },
      { generatedAt: 'bad' },
      {
        codingPlan: {
          ...preview.codingPlan,
          windows: [{ ...preview.codingPlan.windows[0], limitCredits: '0' }],
        },
      },
    ])
      expect(
        parseBillingPreflight(JSON.stringify({ ...preview, ...change }), 'ws', 'model'),
      ).toBeNull();
  });
  it('does not synthesize exhausted quota on an old CLI or temporary failure', async () => {
    for (const message of ['unknown command preflight', 'upstream unavailable']) {
      expect(
        await fetchVelaBillingPreflight('ws', null, {
          run: async () => {
            throw new Error(message);
          },
        }),
      ).toBeNull();
    }
  });
  it('preserves authorization failures', async () => {
    await expect(
      fetchVelaBillingPreflight('ws', null, {
        run: async () => {
          throw new Error('api request failed with status 403');
        },
      }),
    ).rejects.toThrow('403');
  });
});
