# First live share-chain probe — PREPARED, NOT RUN

Source: first-chain acceptance task28, retained in the delivery coordinator’s local task artifacts.

This is an operator-assisted **live observation probe**, not a mocked Playwright CI test. It attaches to the already prepared Owner browser in an isolated tools-dev namespace; it never boots another runtime, makes an API write, fabricates a slug/session/comment, imports app internals, or substitutes a fixture. The operator performs real UI publishing, edits, selection, SSO, and comment submissions. Pressing Enter advances observation; it never makes an assertion pass. The probe clicks the actual UI Copy Link button and reads the system clipboard. All later page visits use that captured clipboard URL, never the CLI's expected URL or API receipt URL.

## DO NOT RUN until explicitly dispatched

Preparation/typechecking does not invoke the entry or connect to services. Two gates guard execution: explicit `--execute` and `SHARE_CHAIN_DISPATCHED=1`. A real expected URL must arrive first. No green runtime result is claimed for this preparation.

Runtime configuration (not alternative business inputs):
- `SHARE_CHAIN_CDP`: dedicated Chromium CDP endpoint; **never a personal/default/shared browser**. Resolve browser-seat coordination before dispatch.
- `SHARE_CHAIN_NAMESPACE`: existing non-default tools-dev namespace. The script records/accepts this operator prerequisite; does not independently attest sidecar identity.
- `SHARE_CHAIN_WEB_ORIGIN`: independently verified deployed console origin. Do not set it by extracting the test URL's origin; that would make the origin check tautological.
- `SHARE_CHAIN_PG_SERVICE`: optional authorized **read-only** libpq service name. `psql` must be installed. Never pass a database URL/password to the command. SQL uses an exact real POST comment ID, actual project and alias, read-only transaction, and body/selector equality. Output contains counts/booleans only. Without this configuration the persistence check is UNKNOWN, not inferred from HTTP201.
- Have exactly one real Owner file UI tab for the input project's ID already open and authenticated. No Owner route is synthesized. The expected URL is a reference only; step1 must republish through that Owner UI and copy the same URL.

Future dispatch command (not executed during preparation):

```sh
# Run only after the main session dispatches the real target and approves test accounts/resources.
with-env corepack pnpm --dir e2e exec tsx scripts/playwright.ts share-chain-probe \
  --execute "$REAL_URL" "$NEW_EVIDENCE_DIRECTORY"
```

Use a **new** output directory; existing directories are rejected. Headers, cookies, storageState, credentials and auth responses are never recorded. Relevant HTTP JSON is redacted; screenshots/rendered work/comment text are still sensitive and belong only to authorized test accounts in the private evidence directory. No tracing of the SSO/login page. Startup/stop of the preexisting Owner runtime remains with its owner via tools-dev; retain those lifecycle logs alongside the probe output. The probe closes only contexts it creates and disconnects its CDP client. It does not stop another session's runtime. Exit 0=all criteria PASS,1=FAIL,2=UNKNOWN present. Per-step `report.json`, filtered/redacted `http-evidence.json`, PG text output, screenshots and lifecycle records are retained.

## Data lineage / chronology

1. Given expected URL → actual Owner UI publish HTTP → actual UI copy/clipboard URL. Assert canonical `/artifact/project/UUIDv4`, independent Web origin, exact expected URL. Any explicit failure stops the chain.
2. Clipboard URL → fresh cookie-empty visitor context → rendered text compared with Owner's actual iframe output. Empty/non-text/dynamic artifacts need a specific content oracle; no made-up heading is substituted.
3. Same clipboard URL with final8path characters removed → E3 page (never E2) + actual navigation and relevant API status. This is a negative **branch**; step4 continues the valid step2 page, not a fabricated replacement URL.
4. Same visitor context → real login/UI comment POST → actual returned ID/body/author/isMine → visible article + optional exact PG match. Public author discriminator is `comment.author.kind`, not an invented top-level `authorKind`.
5. That exact ID → Owner panel row + naturally observed Owner comment read → internal authorKind. Public comment data is never substituted for the Owner response.
6. **Before republishing**, create the step7 local comment via Owner UI; capture its actual POST ID. Edit actual rendered content. Enter a real unsent visitor draft. Owner publishes, copies UI link again; verify stable URL and fresh page loads changed Owner output. Original page/draft must remain. If real toast is visible, its actual refresh button is exercised with native confirm: cancel preserves draft/document, accept reloads the same URL into new content and clears draft. No window.confirm replacement, page.reload shortcut, clock acceleration, or injected version event.
7. Only the captured pre-update local comment ID may satisfy public-read and visitor-list checks. Failure branch is not fault-injected. Missing delivery is UNKNOWN until a real terminal/backfill status distinguishes it from latency; it is never marked successful by note text alone.

## Criteria needing main-session clarification before a full PASS is possible

- Step2 says anonymous visibility is “as expected” but supplies no allowed/forbidden field/control set. Probe captures it and marks this criterion UNKNOWN. Define exactly which content, comments, author fields, login/compose controls are permitted.
- Step5 “no team directory exposure” is broader than anything a screenshot proves. Need a response/DOM/network surface and forbidden-field/endpoint policy; do not equate lack of a requested endpoint with absence of disclosure. This criterion remains UNKNOWN.
- Step6 requires a new-version notice but the current instruction says an open page does **not poll**. The inspected console implementation currently uses a visible-page cadence. Which approved event/action triggers discovery, and what observation deadline applies? Probe never invents a trigger, never advances a clock, and reports absent notice UNKNOWN. It currently recognizes English/Chinese toast text; other locales require an explicit real selector/text oracle.
- Step7: on an already-shared file, a “local” comment may already relay **before** republish. Its later visibility alone cannot identify a backfill cause. Need an approved real pre-publication pending state or server backfill-generation witness. No artificial network failure is introduced. This limitation must not be mislabeled as backfill causality proof.
- The failure-only half of step7 needs a naturally observed real failure and an exact UI hint/success surface. No failure observed => that branch UNKNOWN, not PASS and not a reason to manufacture a failure.

These gaps are reportable criteria, not permission to improvise. Useful main-chain observations may still be collected after dispatch, but the probe is deliberately incapable of an all-green report with these unknowns outstanding.
