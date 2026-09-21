// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodingPlanUsage } from '../../src/components/CodingPlanUsage';
import { I18nProvider } from '../../src/i18n';
import { workspaceContextFixture } from '../helpers/workspace-context';

const context = workspaceContextFixture({
  workspaceId: 'ws',
  workspaceMemberId: 'member',
  workspaceType: 'team',
});
function response(member = 'member', remaining = '75') {
  return new Response(
    JSON.stringify({
      preflight: {
        schemaVersion: 1,
        workspaceId: 'ws',
        workspaceMemberId: member,
        modelId: null,
        generatedAt: new Date().toISOString(),
        balanceUsd: '0',
        modelCovered: null,
        funding: 'gateway',
        codingPlan: {
          workspaceId: 'ws',
          generatedAt: new Date().toISOString(),
          eligible: true,
          tier: 'pro',
          windows: [18000, 604800].map((seconds) => ({
            policyId: String(seconds),
            durationSeconds: seconds,
            usedCredits: '25',
            remainingCredits: remaining,
            limitCredits: '100',
            resetsAt: new Date(Date.now() + 1000).toISOString(),
            windowStart: null,
            resetMode: 'activity_triggered',
          })),
        },
      },
    }),
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('Coding Plan usage display', () => {
  it('shows separate windows with no sum or unlimited claim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );
    render(
      <I18nProvider initial="en">
        <CodingPlanUsage context={context} />
      </I18nProvider>,
    );
    await screen.findByText('75% remaining · 5h window');
    expect(screen.getByText('75% remaining · 168h window')).toBeTruthy();
    expect(screen.queryByText(/unlimited/i)).toBeNull();
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });
  it('does not show another member pool', async () => {
    const fetcher = vi.fn(async () => response('other'));
    vi.stubGlobal('fetch', fetcher);
    render(
      <I18nProvider initial="en">
        <CodingPlanUsage context={context} />
      </I18nProvider>,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Plan usage unavailable')).toBeTruthy();
  });
  it('refreshes when the quota window resets without a wallet event', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn(async () => response('member', '0'))
      .mockImplementationOnce(async () => response('member', '0'));
    vi.stubGlobal('fetch', fetcher);
    render(
      <I18nProvider initial="en">
        <CodingPlanUsage context={context} />
      </I18nProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fetcher.mockImplementation(async () => response('member', '100'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(screen.getByText('100% remaining · 5h window')).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
