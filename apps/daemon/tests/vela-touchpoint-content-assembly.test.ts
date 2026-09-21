// OPEND-3371 at the daemon HTTP boundary — the cheapest layer that can see the
// symptom (AGENTS.md "Try the cheapest layer first").
//
// The browser is not changed by this ticket and must not be able to tell that
// anything happened: it asks the same URL and gets the same JSON. What changes
// is the WAN hop behind the daemon, where a steady-state refresh stops carrying
// the content package the daemon already holds.
//
// Two properties are load-bearing and each has its own named case below:
//
//   1. A request the daemon holds nothing for is byte-for-byte today's request
//      and today's response — no new parameters, no `contentOmitted`.
//   2. Anything that goes wrong behind the daemon costs bandwidth, never the
//      campaign. A trimmed reply it cannot rebuild is re-asked in full.

import { createHash } from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfigPrefs } from '../src/app-config.js';
import { registerVelaRoutes } from '../src/routes/vela.js';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

const SHARED = `export const shared = ${JSON.stringify('x'.repeat(4096))};`;
const ENTRY = `import './shared.js'; export function mount(root) { root.textContent = ${JSON.stringify('y'.repeat(4096))}; }`;
const PLACEMENT = 'opend.home.campaign-modal';
const LOCALE = 'en-US';

const manifest = {
  formatVersion: 2,
  runtimeKind: 'web-component',
  runtimeApiVersion: 1,
  platformWrapperVersion: 'vela-touchpoint-wrapper-v1',
  sdkVersion: 'vela-touchpoint-sdk-v1',
  contentLine: 'production',
  placements: [
    {
      key: PLACEMENT,
      entry: 'component.js',
      resources: ['shared.js'],
      locales: [LOCALE],
      requiredCapabilities: [],
      staticActions: [],
    },
  ],
  resources: ['component.js', 'shared.js'],
  images: [],
};

const FULL_RESPONSE = {
  deploymentId: 'deployment-1',
  activityId: 'activity-1',
  snapshotHash: 'sha256:snapshot',
  artifactHash: 'sha256:artifact',
  manifestHash: 'sha256:manifest',
  placementKey: PLACEMENT,
  requiredCapabilities: [],
  staticActions: [],
  testContext: null,
  content: {
    id: 'version-1',
    placementKey: PLACEMENT,
    locale: LOCALE,
    manifest,
    manifestHash: digest(JSON.stringify(manifest)),
    entryPath: 'component.js',
    entryDigest: digest(ENTRY),
    entryModule: ENTRY,
    resources: [
      { path: 'component.js', digest: digest(ENTRY), bytes: base64(ENTRY) },
      { path: 'shared.js', digest: digest(SHARED), bytes: base64(SHARED) },
    ],
    runtime: {
      kind: 'web-component',
      apiVersion: 1,
      wrapperVersion: 'vela-touchpoint-wrapper-v1',
      sdkVersion: 'vela-touchpoint-sdk-v1',
    },
    buildIdentity: { fingerprint: 'fixed' },
  },
  serverTime: '2026-09-18T00:00:00.000Z',
  startsAt: '2026-09-18T00:00:00.000Z',
  endsAt: '2026-09-19T00:00:00.000Z',
  authorizationExpiresAt: '2026-09-18T01:00:00.000Z',
  touchpointDecisionId: 'decision-1',
};

/** C3: today's object with `content` replaced in place by `contentOmitted: true`. */
const TRIMMED_RESPONSE = (() => {
  const trimmed: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(FULL_RESPONSE)) {
    if (field === 'content') trimmed.contentOmitted = true;
    else trimmed[field] = value;
  }
  return trimmed;
})();

type UpstreamCall = Readonly<{ path: string; heldContentId: string | null; heldContentLocale: string | null }>;

let dataDir: string;
let upstream: Server;
let daemon: Server;
let baseUrl: string;
let calls: UpstreamCall[];
/** Bytes of every response body Vela sent over the (notional) WAN hop. */
let upstreamBytes: number[];
/** When false the fake Vela is an un-upgraded one: it strips the new parameters. */
let supportsTrimming: boolean;
let status: number;
let errorBody: unknown;

const listen = (server: Server) =>
  new Promise<AddressInfo>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address() as AddressInfo));
  });
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'od-touchpoint-assembly-'));
  calls = [];
  upstreamBytes = [];
  supportsTrimming = true;
  status = 200;
  errorBody = null;
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    const heldContentId = url.searchParams.get('heldContentId');
    const heldContentLocale = url.searchParams.get('heldContentLocale');
    calls.push({ path: url.pathname, heldContentId, heldContentLocale });
    res.setHeader('content-type', 'application/json');
    res.statusCode = status;
    const trim =
      supportsTrimming &&
      status === 200 &&
      heldContentId === FULL_RESPONSE.content.id &&
      heldContentLocale === FULL_RESPONSE.content.locale;
    const payload = JSON.stringify(
      status === 200 ? (trim ? TRIMMED_RESPONSE : FULL_RESPONSE) : errorBody,
    );
    upstreamBytes.push(Buffer.byteLength(payload));
    res.end(payload);
  });
  const upstreamAddress = await listen(upstream);
  const app = express();
  app.use(express.json());
  registerVelaRoutes(app, {
    paths: { RUNTIME_DATA_DIR: dataDir },
    appConfig: { readAppConfig: async () => ({ agentCliEnv: {} }) as AppConfigPrefs },
    http: {},
    env: {
      VELA_CONTROL_KEY: 'ck-test',
      VELA_API_URL: `http://127.0.0.1:${upstreamAddress.port}`,
    },
  });
  daemon = createServer(app);
  const daemonAddress = await listen(daemon);
  baseUrl = `http://127.0.0.1:${daemonAddress.port}`;
});

afterEach(async () => {
  await close(daemon);
  await close(upstream);
  try {
    fs.chmodSync(path.join(dataDir, 'touchpoint-content-cache'), 0o700);
  } catch {
    /* absent or already writable */
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const decide = async () => {
  const response = await fetch(
    `${baseUrl}/api/touchpoints/production-runtime?placementKey=${PLACEMENT}&locale=${LOCALE}`,
  );
  return { status: response.status, text: await response.text() };
};

const blobsDir = () => path.join(dataDir, 'touchpoint-content-cache', 'blobs');
/** The file a digest names, so a case can damage one specific blob rather than whichever one readdir happens to list first. */
const blobFile = (value: string) => path.join(blobsDir(), value.slice('sha256:'.length));

describe('daemon touchpoint content assembly', () => {
  // Property 1. If this ever fails, every already-published client stops seeing
  // campaigns, because their guard is `if (!next.content?.id) return clear`.
  it('REGRESSION: a cold daemon sends today\'s request and returns today\'s response byte for byte', async () => {
    const cold = await decide();
    expect(cold.status).toBe(200);
    expect(calls).toEqual([
      { path: '/api/v1/touchpoints/runtime/production', heldContentId: null, heldContentLocale: null },
    ]);
    expect(cold.text).toBe(JSON.stringify(FULL_RESPONSE));
    expect(cold.text).not.toContain('contentOmitted');
  });

  it('asks Vela to omit content it already holds, and hands the browser the same response anyway', async () => {
    const cold = await decide();
    const warm = await decide();
    expect(calls[1]).toEqual({
      path: '/api/v1/touchpoints/runtime/production',
      heldContentId: 'version-1',
      heldContentLocale: LOCALE,
    });
    expect(warm.status).toBe(200);
    // Byte for byte, which is also what guards the re-encode: blobs are stored
    // as raw bytes and encoded back to base64 on the way out, so a rebuilt
    // response matches the original only while upstream sends canonical
    // base64. If Vela ever folds lines or switches to base64url, this is the
    // assertion that says so.
    expect(warm.text).toBe(cold.text);
    expect(warm.text).toBe(JSON.stringify(FULL_RESPONSE));
    expect(warm.text).not.toContain('contentOmitted');
    // The saving is on the WAN hop only; the browser's own response is unchanged.
    expect(upstreamBytes[1]).toBeLessThan(upstreamBytes[0]! / 10);
  });

  it('never forwards bytes its digest did not cover', async () => {
    await decide();
    // `SHARED` is 4121 bytes, so its base64 form ends in padding and Node's
    // decoder drops anything appended after it. The digest is computed over
    // that decoded view, so it goes on matching while the file -- and the
    // response built from it -- carries nine bytes nobody verified.
    fs.appendFileSync(blobFile(digest(SHARED)), 'GARBAGEXX');
    calls = [];
    const next = await decide();
    expect(next.status).toBe(200);
    // The daemon hands over the response it actually verified, or it asks
    // again. It does not hand over one it only appeared to verify.
    expect(next.text).toBe(JSON.stringify(FULL_RESPONSE));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.heldContentId).toBeNull();
    // The consequence this pins, in one line: `atob` is WHATWG
    // forgiving-base64 and strips ASCII whitespace only. Any other stray
    // character throws, the placement never mounts, and because the daemon
    // believed it succeeded no fallback anywhere is reached.
    const rebuilt = JSON.parse(next.text) as { content: { resources: Array<{ bytes: string }> } };
    for (const resource of rebuilt.content.resources)
      expect(() => atob(resource.bytes)).not.toThrow();
  });

  it('keeps serving the campaign when the cached bytes are corrupted, and stops paying for them', async () => {
    await decide();
    fs.writeFileSync(blobFile(digest(SHARED)), base64('tampered'));
    calls = [];
    const recovered = await decide();
    expect(recovered.status).toBe(200);
    expect(recovered.text).toBe(JSON.stringify(FULL_RESPONSE));
    // One conditional ask that could not be rebuilt, then today's full request.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.heldContentId).toBe('version-1');
    expect(calls[1]?.heldContentId).toBeNull();
    // Damage costs one extra round trip, not every round trip from now on. The
    // full response the fallback just fetched is the daemon's only chance to
    // put the real bytes back; if it declines, this placement pays double
    // forever and nothing anywhere reports it.
    calls = [];
    const healed = await decide();
    expect(healed.status).toBe(200);
    expect(healed.text).toBe(JSON.stringify(FULL_RESPONSE));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.heldContentId).toBe('version-1');
  });

  it('keeps serving the campaign when the cache cannot be written at all', async () => {
    const root = path.join(dataDir, 'touchpoint-content-cache');
    fs.mkdirSync(root, { recursive: true });
    fs.chmodSync(root, 0o500);
    const first = await decide();
    const second = await decide();
    expect(first.text).toBe(JSON.stringify(FULL_RESPONSE));
    expect(second.text).toBe(JSON.stringify(FULL_RESPONSE));
    expect(calls.every((call) => call.heldContentId === null)).toBe(true);
  });

  it('keeps serving the campaign against a Vela that ignores the new parameters', async () => {
    await decide();
    supportsTrimming = false;
    const warm = await decide();
    expect(calls[1]?.heldContentId).toBe('version-1');
    expect(warm.text).toBe(JSON.stringify(FULL_RESPONSE));
  });

  it('passes an upstream refusal through untouched while holding content', async () => {
    await decide();
    status = 410;
    errorBody = {
      error: 'production_runtime_revoked',
      receipt: {
        touchpointDecisionId: 'decision-1',
        deploymentId: 'deployment-1',
        activityId: 'activity-1',
        contentVersionId: 'version-1',
      },
    };
    const revoked = await decide();
    expect(revoked.status).toBe(410);
    expect(revoked.text).toBe(JSON.stringify(errorBody));
    status = 404;
    errorBody = { error: 'no_decision' };
    const missing = await decide();
    expect(missing.status).toBe(404);
    expect(missing.text).toBe(JSON.stringify(errorBody));
    // A refusal is the server's own decision and must never be re-asked as a
    // full request: the daemon's fallback is for content it cannot rebuild.
    expect(calls).toHaveLength(3);
  });

  it('never rewrites a caller that already carries held-content parameters', async () => {
    await decide();
    const response = await fetch(
      `${baseUrl}/api/touchpoints/production-runtime?placementKey=${PLACEMENT}&locale=${LOCALE}&heldContentId=someone-elses&heldContentLocale=fr-FR`,
    );
    expect(response.status).toBe(200);
    expect(calls[1]).toEqual({
      path: '/api/v1/touchpoints/runtime/production',
      heldContentId: 'someone-elses',
      heldContentLocale: 'fr-FR',
    });
  });

  it('follows the server to a new activity within one poll instead of pinning the cached one', async () => {
    await decide();
    const replacement = JSON.parse(JSON.stringify(FULL_RESPONSE)) as typeof FULL_RESPONSE;
    replacement.activityId = 'activity-2';
    replacement.deploymentId = 'deployment-2';
    replacement.content.id = 'version-2';
    supportsTrimming = false;
    await close(upstream);
    upstream = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://upstream');
      calls.push({
        path: url.pathname,
        heldContentId: url.searchParams.get('heldContentId'),
        heldContentLocale: url.searchParams.get('heldContentLocale'),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(replacement));
    });
    // The daemon resolves Vela per request, so rebinding the same port is not
    // required: re-register against the new address.
    const address = await listen(upstream);
    const app = express();
    app.use(express.json());
    registerVelaRoutes(app, {
      paths: { RUNTIME_DATA_DIR: dataDir },
      appConfig: { readAppConfig: async () => ({ agentCliEnv: {} }) as AppConfigPrefs },
      http: {},
      env: { VELA_CONTROL_KEY: 'ck-test', VELA_API_URL: `http://127.0.0.1:${address.port}` },
    });
    await close(daemon);
    daemon = createServer(app);
    const daemonAddress = await listen(daemon);
    baseUrl = `http://127.0.0.1:${daemonAddress.port}`;
    const next = await decide();
    expect(JSON.parse(next.text)).toEqual(replacement);
  });
});
