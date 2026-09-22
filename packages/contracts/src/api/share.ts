/**
 * Share + external-comment contract (P0).
 *
 * This module is the ONE place the share feature's cross-surface shapes are
 * frozen. Four independent lanes consume it — the OD daemon publish path, the
 * vela share page, the vela cloud comment API, and the OD client comment
 * sidebar — and none of them can see each other's code. A field renamed here
 * is a four-way break, so prefer adding over changing.
 *
 * `vela` is a SEPARATE pnpm workspace and cannot import this package. Its
 * server-side mirror of these shapes is hand-maintained; the cross-repo
 * agreement is the field NAMES and the literal string unions below, which is
 * why they are spelled out as `const` arrays rather than left implicit in a
 * type alias. Any change here needs the mirror changed in the same change set.
 *
 * Pure TypeScript, dependency-free — safe to import from daemon, web, and CLI.
 */

import type { PublicProjectFilePublication } from './collab.js';

/* ------------------------------------------------------------------ *
 * Share addressing
 * ------------------------------------------------------------------ */

/**
 * Public share URL shape, frozen 2026-09-21:
 *
 *     https://open-design.ai/cloud/artifact/{projectId}/{slug}
 *                            └── base path ──┘
 *
 * Both segments are load-bearing and neither is decorative:
 *
 * - `projectId` is the OD-side project id. It is what `collab.comment_events`
 *   is keyed by (`(team_id, project_id, seq)`), so carrying it in the path
 *   lets the share page ask for a project's comments without first resolving
 *   the snapshot back to a project.
 * - `slug` is the opaque public share key. It is a STABLE alias, not a
 *   snapshot address: updating a share advances what it points at, so the
 *   link a person was sent keeps working and shows the current version on
 *   their next load. Stop-then-resume restores the same slug.
 *
 * `/cloud/` is the DEPLOYMENT base path (`VITE_APP_BASE_PATH`), not part of
 * the application route, so it is deliberately absent from what this module
 * builds. Baking it in here would produce a wrong URL in every environment
 * that mounts the app somewhere else.
 *
 * `team_id` is deliberately NOT in the URL. The snapshot table already carries
 * that rule for its own public read — team_id is resolved server-side and
 * never exposed publicly — and the share binding follows it.
 *
 * ## Two segments means two independent public inputs
 *
 * A caller supplies `projectId` and `slug` separately, so the server MUST
 * confirm the slug actually belongs to that project before serving anything.
 * Without that check, pairing project A's id with project B's slug reads
 * across the boundary. The single-segment alternative had no such hole by
 * construction; this shape has to close it explicitly — see
 * {@link ShareBindingLookup}.
 *
 * ## `projectId` is a public identifier from now on
 *
 * It appears in URLs, `Referer` headers and browser history. Any existing
 * logic of the form "knowing a projectId is sufficient to do X" needs
 * re-examining against that.
 */
export const SHARE_URL_PATH_SEGMENT = 'artifact';

/**
 * What the server must resolve a share URL's two segments into before it
 * serves a share page or any of its comments.
 *
 * The resolution is the authorization step, not a lookup convenience: it is
 * where "this slug belongs to this project" is established. A caller that has
 * a valid `projectId` and a valid `slug` that do not belong together must be
 * refused with {@link ShareCommentErrorCode} `SHARE_NOT_FOUND` — the same
 * answer an unknown slug gets, so the mismatch does not confirm that either
 * half exists.
 *
 * ## This is the ONLY authority for whether a share is live
 *
 * `status` here is the single truth for the share's lifecycle. Whatever
 * stores the share's CONTENT — the alias row that points at the current
 * published version — must carry the version pointer and nothing else. It
 * must not carry its own `enabled` / `active` / `deleted` flag.
 *
 * This is not a style preference. Two lifecycle flags means two stop
 * switches, and nothing keeps them equal: stopping through one path leaves
 * the other saying "live", so the page serves content while comments answer
 * 410 Gone, or the reverse. Both halves look correct in isolation and their
 * own tests pass.
 *
 * Note the shape of the truth as well as its location: the lifecycle is a
 * four-state enum ({@link SHARE_STATUSES}), not a boolean. A boolean cannot
 * distinguish `none` from `stopped`, which is what makes "stop preserves the
 * binding so the same slug can resume" expressible at all.
 */
export interface ShareBindingLookup {
  projectId: string;
  slug: string;
  /** Resolved server-side; never echoed to the client. */
  teamId: string;
  status: ShareStatus;
}

/** Parsed form of a share URL path. */
export interface ShareUrlParts {
  projectId: string;
  slug: string;
}

/**
 * Build the public path (no origin) for a share. Callers that need an absolute
 * URL join this onto the configured cloud origin themselves — the origin
 * differs per environment and must not be baked into a shared contract.
 */
export function buildSharePath(parts: ShareUrlParts): string {
  return `/${SHARE_URL_PATH_SEGMENT}/${encodeURIComponent(parts.projectId)}/${encodeURIComponent(parts.slug)}`;
}

/**
 * Parse a share URL path back into its parts. Returns `null` for anything that
 * is not exactly `/artifact/{projectId}/{slug}` — including a trailing extra
 * segment, which is a different route, not a share with a suffix.
 */
export function parseSharePath(pathname: string): ShareUrlParts | null {
  const [head, rawProjectId, rawSlug, ...rest] = pathname.split('/').filter(Boolean);
  if (rest.length > 0) return null;
  if (head !== SHARE_URL_PATH_SEGMENT) return null;
  if (rawProjectId === undefined || rawSlug === undefined) return null;
  let projectId: string;
  let slug: string;
  try {
    projectId = decodeURIComponent(rawProjectId);
    slug = decodeURIComponent(rawSlug);
  } catch {
    return null;
  }
  if (!projectId || !slug) return null;
  return { projectId, slug };
}

/* ------------------------------------------------------------------ *
 * Comment authorship
 * ------------------------------------------------------------------ */

/**
 * Which identity union arm an external comment's author came from.
 *
 * - `member` — a workspace member of the owning team. Carries a
 *   `workspaceMemberId`; this is every comment written inside the OD client.
 * - `user` — a site-account holder with NO workspace membership: someone who
 *   opened a share link, logged in, and commented from the share page.
 *
 * This is the discriminator persisted as `collab.comment_events.author_kind`,
 * enforced there by `comment_events_author_shape_check`. Legacy rows default
 * to `member`, which is why no backfill was needed.
 */
export const SHARE_AUTHOR_KINDS = ['member', 'user'] as const;
export type ShareAuthorKind = (typeof SHARE_AUTHOR_KINDS)[number];

/**
 * Stable per-account key used as the AVATAR COLOR SEED on both ends.
 *
 * `authorKey = HMAC(server secret, app_user_id)`, lowercase hex, exactly
 * {@link AUTHOR_KEY_HEX_LENGTH} characters (HMAC-SHA256). Keyed on the ACCOUNT,
 * not the membership, so the same person is the same color whether they
 * commented from the OD client (as a member) or from the share page (as a
 * user).
 *
 * It is a display seed and nothing else. It is NOT a capability, NOT an
 * identity assertion, and must never be used to decide whether a comment
 * belongs to the viewer — `isMine` is computed server-side against the live
 * session, because a client can only compare keys and would get that wrong.
 *
 * The length is frozen because both ends hash it into a fixed palette index;
 * a shorter or differently-cased key silently produces a different color on
 * one side, which reads as a rendering bug rather than a contract break.
 */
export const AUTHOR_KEY_HEX_LENGTH = 64;

/** True when `value` has the frozen `authorKey` shape (lowercase hex, 64 chars). */
export function isValidAuthorKey(value: string): boolean {
  return value.length === AUTHOR_KEY_HEX_LENGTH && /^[0-9a-f]+$/.test(value);
}

/**
 * Display-name snapshot rules, shared by the OD client sidebar and the vela
 * share page (D104 ②: the share page matches the client, and the client is
 * the baseline because it is already shipped).
 *
 * The name is stamped by the SERVER at write time and stored on the event.
 * It is never read back out of the team member directory at render time —
 * that directory is a privacy boundary (real names + roles) that the share
 * page must not be able to reach. A renamed author therefore keeps the name
 * that was current when they wrote, which is intentional: a comment reads as
 * the record of who said it then.
 */
export const AUTHOR_DISPLAY_NAME_MAX_LENGTH = 64;

/**
 * Resolve the name to render for a comment author, with the client's existing
 * fallback ladder. Both ends must call THIS function rather than each
 * re-implementing the ladder — the two-implementation version is exactly how
 * the same author ends up labelled differently on the two surfaces.
 *
 * Ladder: stamped display name → caller-supplied directory name → `null`.
 * A `null` result means "render the existing id-only anonymous form", which
 * is what the client does today; it is not an error.
 */
export function resolveAuthorDisplayName(input: {
  /** Server-stamped snapshot from the comment event. */
  stamped?: string | null;
  /** Locally resolved member-directory name, when the viewer can see one. */
  directory?: string | null;
}): string | null {
  const stamped = input.stamped?.trim();
  if (stamped) return stamped.slice(0, AUTHOR_DISPLAY_NAME_MAX_LENGTH);
  const directory = input.directory?.trim();
  if (directory) return directory.slice(0, AUTHOR_DISPLAY_NAME_MAX_LENGTH);
  return null;
}

/** Author identity as it travels with an external comment. */
export interface ShareCommentAuthor {
  kind: ShareAuthorKind;
  /** Avatar color seed — see {@link AUTHOR_KEY_HEX_LENGTH}. */
  authorKey: string;
  /** Server-stamped name snapshot; absent means render the id-only form. */
  displayName?: string;
  /** Present only when `kind === 'member'`. */
  memberId?: string;
}

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

/**
 * Client-generated key for one SEND ATTEMPT (D131, frozen 2026-09-21).
 *
 * Per attempt, not per comment: `collab.comment_events` is an append-only
 * event log, so one `comment_id` legitimately produces many events (create,
 * edit, status change) and keying on it would reject the second legitimate
 * event. The uniqueness constraint in the database is therefore
 * `(team_id, project_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
 * which leaves every legacy row — all NULL — unaffected.
 *
 * The share page generates this BEFORE navigating away to log in, so the
 * replay that happens on return carries the same key and cannot produce a
 * second comment. That is the red-line case: same key POSTed twice yields
 * exactly one comment.
 *
 * Format frozen as a v4 UUID string so both ends can generate it with a
 * platform primitive (`crypto.randomUUID()`) and neither needs a dependency.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/** True when `value` is an acceptable idempotency key (non-empty, within bounds). */
export function isValidIdempotencyKey(value: string): boolean {
  return value.length > 0 && value.length <= IDEMPOTENCY_KEY_MAX_LENGTH;
}

/* ------------------------------------------------------------------ *
 * Share state (the DTO the OD client reads)
 * ------------------------------------------------------------------ */

/**
 * Lifecycle of one project's share, as the OD client sees it.
 *
 * - `none` — never shared, or the last share was stopped and forgotten.
 * - `preparing` — an upload is in flight. Transient; the client polls.
 * - `active` — a live share link exists.
 * - `stopped` — the owner stopped sharing. The link now answers 410 Gone;
 *   existing comments are retained, not deleted.
 */
export const SHARE_STATUSES = ['none', 'preparing', 'active', 'stopped'] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];

/**
 * One file the publish plan could not include, surfaced to the share panel.
 *
 * `missing` — referenced by the document but not present on disk.
 * `invalid` — present but unreadable or of a type the plan refuses.
 *
 * S16: these render as a yellow, expandable list and MUST NOT disable the
 * share button. A partially-complete share is the normal case for a
 * work-in-progress document; blocking on it was explicitly rejected.
 */
export interface SharePlanExclusion {
  path: string;
  reason: 'missing' | 'invalid';
}

/**
 * Total-bytes ceiling for one share (S15). Checked BEFORE the upload starts,
 * so the user is refused immediately rather than after a long transfer.
 *
 * NOTE: the 20 MB figure is carried over from the product spec and has no
 * source in code or in the decision ledger — it is an inherited constant, not
 * a measured limit. It is frozen here so the two ends agree, not because it
 * has been justified.
 */
export const SHARE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Summary of what a share WOULD contain, computed by the daemon's
 * `buildSharePlan` before any bytes move. Drives S2/S3/S7/S15/S16.
 */
export interface SharePlanSummary {
  fileCount: number;
  totalBytes: number;
  /** `totalBytes > SHARE_MAX_TOTAL_BYTES` — the S15 pre-upload refusal. */
  exceedsSizeLimit: boolean;
  /** S16. Empty array, never absent, so callers need no `?? []`. */
  exclusions: SharePlanExclusion[];
}

/**
 * The per-project share DTO. This is the single signal the client uses to
 * decide which share-panel state to open (G1 vs G2) and whether a project
 * has a live share at all (A22, replacing two `collab.enabled` reads).
 *
 * There is deliberately no third branch: the panel state is a total function
 * of `status`, so a future state must be added to {@link SHARE_STATUSES}
 * rather than inferred from some other field being present.
 */
export interface ProjectShareState {
  projectId: string;
  status: ShareStatus;
  /** Present when `status` is `active` or `stopped`. */
  slug?: string;
  /** Public path for the share; present exactly when `slug` is. */
  path?: string;
  /** Monotonic publish counter; bumped on each re-publish. */
  version?: number;
  /** Epoch ms of the most recent successful publish. */
  publishedAt?: number;
  /** Last computed plan summary, when one has been computed. */
  plan?: SharePlanSummary;
  /**
   * Count of comments on this project that have not been dealt with, as the
   * SERVER counts them.
   *
   * D116 ②/③, frozen: this is the number of UNRESOLVED comments — the same
   * figure the client already shows — NOT an unread count computed against
   * `lastReadAt`. The design draft asked for an unread count; we keep the
   * shipped meaning and only adopt the draft's red-dot appear/clear behavior.
   *
   * It must come from the server because the share page's list is capped at
   * {@link SHARE_COMMENT_PAGE_LIMIT}; computing it from `list.length` is a
   * negative assertion in the acceptance tests.
   */
  unresolvedTotal?: number;
}

/**
 * True when this project has a share the client should treat as live. A22
 * replaces two `collab.enabled` reads with this predicate — note it is a
 * predicate over the DTO, not over the transport, so a project with cloud
 * collaboration disabled can still have a live share and vice versa.
 */
export function hasActiveShare(state: ProjectShareState | null | undefined): boolean {
  return state?.status === 'active';
}

/* ------------------------------------------------------------------ *
 * Share-page comment API (I4)
 * ------------------------------------------------------------------ */

/**
 * Server-side page cap on the share page's comment list. The list is
 * truncated at this many items; {@link ProjectShareState.unresolvedTotal}
 * carries the real count.
 */
export const SHARE_COMMENT_PAGE_LIMIT = 500;

/**
 * Anti-abuse ceiling on a comment body, in BYTES. Not a product limit.
 *
 * The product decision is that comment length is not limited: no character
 * count, no disabled send button, no truncation, and no `maxLength` on the
 * input. A 4000-character cap was proposed and explicitly rejected, as was an
 * earlier 200-code-point one and a later 1–400 character one. This constant
 * exists only so a single request cannot be used to push unbounded bytes at
 * the server, which is a transport concern.
 *
 * The distinction is load-bearing, not pedantic:
 *
 * - It is measured in BYTES, not characters, because it is about payload size
 *   rather than anything a person types. Never render it as a character
 *   budget, and never derive a counter from it.
 * - Exceeding it is `PAYLOAD_TOO_LARGE`, not `INVALID_COMMENT`. It is not a
 *   validation rule about what a comment may say.
 * - The client must NOT pre-check it. The input stays uncapped; the server
 *   refuses the pathological case. A client-side check would reintroduce the
 *   exact "count and disable" behaviour the product ruled out.
 *
 * 64 KiB is roughly twenty thousand Chinese characters. Anything reaching it
 * is a script or a paste accident, not a person writing a comment.
 */
export const SHARE_COMMENT_MAX_BYTES = 64 * 1024;

/**
 * The four event shapes the comment stream carries. `delete` remains in the
 * union because the OD CLIENT can delete; the SHARE PAGE cannot (D97 — the
 * share page has no edit and no delete entry point at all, and one appearing
 * is a bug).
 */
export const SHARE_COMMENT_EVENT_TYPES = ['create', 'update', 'delete', 'status'] as const;
export type ShareCommentEventType = (typeof SHARE_COMMENT_EVENT_TYPES)[number];

/**
 * Frozen error codes for the share-page comment API (I4).
 *
 * The validation ORDER is part of the contract, not an implementation detail,
 * because each step leaks strictly less than the next: checking the session
 * before the share's liveness avoids telling an unauthenticated caller whether
 * a share exists. D58, narrowed to four steps by D97 (the author-identity step
 * disappeared with edit/delete):
 *
 *     401 UNAUTHENTICATED → 410 SHARE_STOPPED → 400 INVALID_COMMENT → 429 RATE_LIMITED
 *
 * An implementation that reorders these passes its own unit tests and fails
 * the contract, so the order is asserted directly.
 */
export const SHARE_COMMENT_ERROR_CODES = [
  /** 401 — no session, or the session expired mid-compose. */
  'UNAUTHENTICATED',
  /** 410 — the owner stopped this share. Both GET and POST answer this. */
  'SHARE_STOPPED',
  /** 404 — no share binding for this `(projectId, slug)` pair. */
  'SHARE_NOT_FOUND',
  /**
   * 400 — body empty or anchor malformed.
   *
   * NOT the answer for an oversized body: that is `PAYLOAD_TOO_LARGE`
   * against {@link SHARE_COMMENT_MAX_BYTES}, because size is a transport
   * fact rather than a judgement about the comment.
   */
  'INVALID_COMMENT',
  /** 429 — per-viewer write throttle tripped; carries `retryAfterSeconds`. */
  'RATE_LIMITED',
  /** 413 — request body exceeded the transport limit. */
  'PAYLOAD_TOO_LARGE',
] as const;
export type ShareCommentErrorCode = (typeof SHARE_COMMENT_ERROR_CODES)[number];

/** The order the checks must run in. Asserted, not merely documented. */
export const SHARE_COMMENT_VALIDATION_ORDER: readonly ShareCommentErrorCode[] = [
  'UNAUTHENTICATED',
  'SHARE_STOPPED',
  'INVALID_COMMENT',
  'RATE_LIMITED',
] as const;

/**
 * The failure envelope the vela CLI writes to stdout when a single comment
 * push fails, and the field names the daemon must read it by.
 *
 * This exists because the two halves were built to different names and both
 * sides' tests passed: the Go side emitted `errorCode`, the daemon parser
 * required `code`, so the parse returned null, no structured error was ever
 * produced, and the daemon's terminal-cancel could not fire. Nothing was red.
 * An agreement that lives only in two implementations is not an agreement.
 *
 * `errorCode` is the name, because the batch push path shipped it first
 * (`collabCommentPushBatchItemResult`); the parser is what moves.
 *
 * Both fields are required to act on it. A code alone must never cancel
 * data: cancelling discards a comment the user already wrote, so a loose
 * match — an upstream proxy whose prose happens to contain the code — would
 * destroy it. Status without code is equally insufficient.
 */
export const VELA_CLI_FAILURE_ENVELOPE_FIELDS = {
  /** Human-readable text. Must never, on its own, decide anything. */
  message: 'error',
  /** The API error code, e.g. `SHARE_STOPPED`. */
  code: 'errorCode',
  /** The HTTP status the API answered with. Omitted when zero. */
  status: 'status',
} as const;

/**
 * The one condition under which a queued comment is discarded rather than
 * retried. Both halves are required — see above for why.
 */
export const SHARE_COMMENT_TERMINAL_REJECTION = {
  status: 410,
  code: 'SHARE_STOPPED',
} as const;

/**
 * Error body for the share comment API.
 *
 * vela today answers errors in TWO different shapes depending on the route
 * family (`{ error: string }` and `{ code, retryAfterSeconds }`). This
 * interface is the one shape the share routes use; existing routes are not
 * being migrated as part of P0.
 */
export interface ShareCommentErrorResponse {
  code: ShareCommentErrorCode;
  /** Present only with `RATE_LIMITED`. */
  retryAfterSeconds?: number;
}

/**
 * One comment as the share page receives it.
 *
 * Invariant: this is exactly the POST response body as well. A create returns
 * the same shape a list returns, so the page appends the response directly
 * instead of refetching or synthesizing an optimistic row that can drift from
 * what the server actually stored.
 */
export interface ShareComment {
  id: string;
  seq: number;
  author: ShareCommentAuthor;
  /**
   * Computed SERVER-side against the live session (D87). The client cannot
   * derive this from `author.authorKey` and must not try.
   */
  isMine: boolean;
  note: string;
  filePath: string;
  elementId: string;
  selector: string;
  htmlHint: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** `GET` the share page's comment list. `since` is the `seq` cursor. */
export interface ShareCommentListResponse {
  comments: ShareComment[];
  /** Highest `seq` in this page; pass back as `since` to poll forward. */
  latestSeq: number;
  /** Unresolved count, independent of the page cap. See `unresolvedTotal`. */
  unresolvedTotal: number;
}

/** `POST` a comment from the share page. */
export interface ShareCommentCreateRequest {
  /** See {@link IDEMPOTENCY_KEY_MAX_LENGTH}. Required — replay safety. */
  idempotencyKey: string;
  note: string;
  filePath: string;
  elementId: string;
  selector: string;
  htmlHint: string;
}

/** Same shape as one list item — see {@link ShareComment}. */
export interface ShareCommentCreateResponse {
  comment: ShareComment;
}

/* ------------------------------------------------------------------ *
 * Public HTTP seam
 * ------------------------------------------------------------------ */

/**
 * The share page's public endpoints, frozen 2026-09-21.
 *
 * The page URL and the API URL are different things and only the first was
 * frozen earlier, which left the share page unable to write a request without
 * inventing one. These are the shapes the cloud actually serves.
 *
 * `{slug}` rides in the path and `projectId` in the query. That split is not
 * arbitrary: the slug alone identifies the snapshot bytes, while the project
 * is what scopes the comments, and keeping them in different positions makes
 * it obvious at the call site that BOTH must be supplied. A request missing
 * either half is refused as `SHARE_NOT_FOUND` — the same answer a mismatched
 * pair gets, so probing learns nothing.
 */
export const SHARE_COMMENTS_PATH_PREFIX = '/api/v1/collab/share';

/**
 * `GET {prefix}/{slug}/comments?projectId=&filePath=&since=`
 * → {@link ShareCommentListResponse}
 *
 * `since` is the `seq` cursor: pass back the previous response's `latestSeq`
 * to poll forward. It is a DELTA read, not a full list, so a caller that
 * discards its accumulated comments between polls will show an emptying page.
 */
export function buildShareCommentsUrl(input: {
  slug: string;
  projectId: string;
  filePath: string;
  since?: number;
}): string {
  const query = new URLSearchParams({
    projectId: input.projectId,
    filePath: input.filePath,
  });
  if (input.since !== undefined) query.set('since', String(input.since));
  return `${SHARE_COMMENTS_PATH_PREFIX}/${encodeURIComponent(input.slug)}/comments?${query}`;
}

/**
 * Snapshot metadata comes from the EXISTING public snapshot read, not from a
 * new share-specific endpoint: `GET /api/v1/public/snapshots/{slug}` returns
 * the manifest, which is where the entry file name comes from. There is no
 * directory index and no `index.html` fallback, so the page must read the
 * manifest before it can build an iframe `src`.
 */
export const PUBLIC_SNAPSHOT_PATH_PREFIX = '/api/v1/public/snapshots';

/**
 * An OPEN share page does not poll for a newer snapshot. The viewer refreshes.
 *
 * ## The link is stable; what it points at moves
 *
 * A snapshot is immutable, but the share link is NOT a snapshot address — it
 * is a stable alias whose pointer the owner advances when they update. The
 * toast after a successful update says as much: "viewers see the latest
 * version after refreshing". A failed update leaves the server-side pointer
 * where it was, which is only a meaningful guarantee because there IS a
 * pointer. Stop-then-resume likewise restores the SAME link and mints no new
 * snapshot.
 *
 * So a share URL keeps working across updates, and a viewer who reloads gets
 * the current version. What P0 does not build is the transport that would let
 * a page ALREADY OPEN notice the change on its own — no version poll, no
 * second request to compare versions, no push.
 *
 * The distinction is easy to collapse and expensive to get wrong in either
 * direction: read it as "one link, one version forever" and the update flow
 * looks impossible; read it as "the page keeps itself current" and every
 * share page grows a polling loop nobody asked for.
 *
 * This constant exists so the absence stays a recorded decision rather than a
 * gap someone fills in with that loop.
 */
export const SHARE_SNAPSHOT_DISCOVERY_IN_P0 = false;

/* ------------------------------------------------------------------ *
 * Comment read state
 * ------------------------------------------------------------------ */

/**
 * When the viewer last opened this project's comments, as epoch ms.
 *
 * Persisted by the DAEMON, not by the cloud and not in browser storage: the
 * red dot has to survive a restart, and a per-browser value would make the
 * same person on two devices disagree about what they have already seen.
 *
 * ## This is NOT the number on the badge
 *
 * The badge shows {@link ProjectShareState.unresolvedTotal} — how many
 * comments are still unhandled. The design draft asked for an unread count
 * and that was declined: the shipped meaning stays. `lastReadAt` drives only
 * whether the dot APPEARS and when it CLEARS.
 *
 * Keeping the two apart matters because they answer different questions.
 * "Three comments need your attention" is true whether or not you have looked
 * at them; "something arrived since you last looked" stops being true the
 * moment you look. Merging them would make the badge drop to zero on open
 * while three comments were still open.
 */
export interface ProjectCommentReadState {
  projectId: string;
  /** Epoch ms; absent means the viewer has never opened this project's comments. */
  lastReadAt?: number;
}

/**
 * Is there something the viewer has not seen yet?
 *
 * Two conditions, and the second is the one that gets forgotten: a comment
 * the viewer wrote themselves must never light the dot. Without that, sending
 * a comment marks your own project unread.
 *
 * A comment that arrived at exactly `lastReadAt` counts as SEEN. The
 * comparison is strict on purpose — a comment written in the same
 * millisecond as the open is far more likely to be the one that triggered
 * the open than one that arrived after it.
 */
export function hasUnreadComments(input: {
  readState: ProjectCommentReadState | null | undefined;
  comments: ReadonlyArray<{ createdAt: number; author: { authorKey?: string } }>;
  viewerAuthorKey: string | null;
}): boolean {
  const lastReadAt = input.readState?.lastReadAt;
  return input.comments.some((comment) => {
    if (comment.author.authorKey && comment.author.authorKey === input.viewerAuthorKey) {
      return false;
    }
    return lastReadAt === undefined || comment.createdAt > lastReadAt;
  });
}

/** `PUT /api/projects/:projectId/comments/read` — stamps `lastReadAt` to now. */
export interface ProjectCommentReadRequest {
  /** Epoch ms. Server-clamped: a client clock ahead of the server cannot hide future comments. */
  readAt: number;
}

/* ------------------------------------------------------------------ *
 * Delete-time residual cleanup
 * ------------------------------------------------------------------ */

/**
 * The project was deleted locally, but stopping its public share did not
 * finish.
 *
 * Deleting a shared project is two effects against two systems: the local
 * project row goes away, and the cloud binding that keeps the public link
 * serving has to be stopped. The second one crosses the network and can fail
 * on its own — expired credentials, the cloud being down, the account no
 * longer authorized for that project.
 *
 * ## Why this cannot be folded into the delete's success flag
 *
 * Failing the whole delete would be wrong: the project IS gone, and telling
 * the user it was not would make them try again against something that no
 * longer exists. Succeeding silently would be worse: a link they believe they
 * just revoked is still serving their content to anyone holding it. That is a
 * privacy-visible outcome, and it is exactly the one an `ok: true` with no
 * further shape cannot say.
 *
 * So the delete reports success AND carries this. One response, two facts.
 *
 * ## `retrying` is the difference between a notice and an alarm
 *
 * `true` means the stop was queued and the daemon will keep attempting it;
 * the user needs to know the link may be briefly live, not to do anything.
 * `false` means nothing further will happen on its own and the link stays up
 * until someone acts. Collapsing the two produces either a scary banner for a
 * self-healing case, or a calm one for a case that needs a person.
 *
 * ## Exactly once
 *
 * This is delivered on the delete response and nowhere else. The project is
 * gone, so there is no row left to hang a persistent indicator on, and no
 * later request will rediscover the condition. A surface that drops it drops
 * it permanently — which is why it rides the response every consumer already
 * reads rather than a separate channel one of them might not subscribe to.
 */
export interface ProjectDeleteShareResidual {
  /**
   * Which file's link is still serving.
   *
   * Publications are per FILE, not per project: `public_file_publications` is
   * keyed by `(resource_team_id, owner_member_id, project_id, file_path)`. A
   * person who published three files from one project and then deleted it can
   * therefore be left with three live links, each of which may fail to stop
   * for its own reason.
   *
   * Without this, a message could only say "a link is still up" — and the
   * person has no way to tell which of their files it is.
   */
  filePath: string;
  /** The public slug that may still be serving. */
  slug: string;
  /** Will the daemon keep trying THIS one on its own? */
  retrying: boolean;
  /** The failure's error code, when the stop attempt produced one. */
  code?: string;
}

/**
 * `DELETE /api/projects/:projectId` response.
 *
 * `ok` describes the LOCAL delete only. It stays `true` when
 * {@link ProjectDeleteShareResidual} is present — see that type for why.
 */
export interface ProjectDeleteResponse {
  ok: true;
  /**
   * Every file whose public link may still be serving, one entry each.
   *
   * A list, not a single value: see {@link ProjectDeleteShareResidual.filePath}
   * — publications are per file, so one delete can leave several behind, and
   * they do not share a fate. Some may be queued for retry while others are
   * terminal, which is why `retrying` lives on each entry rather than here.
   *
   * Absent or empty means the project had no live share, or every stop
   * succeeded. A caller must not treat a single-element list as the only
   * possible shape.
   */
  shareResiduals?: ReadonlyArray<ProjectDeleteShareResidual>;
}

/* ------------------------------------------------------------------ *
 * Publishing: content and binding can succeed separately
 * ------------------------------------------------------------------ */

/**
 * What a publish confirmed, as the SERVER reported it.
 *
 * Every field here is a fact the server sent back. None of it may be
 * reconstructed from a child process's exit code: a nonzero exit proves that
 * something failed, NOT that the alias is unchanged. A publish that timed out
 * may well have landed. Reconciliation reads this receipt or asks the server
 * again; it never infers pointer state from a failure.
 */
export interface SharePublishReceipt {
  /** The file that was published, in the same spelling the rest of this module uses. */
  filePath: string;
  /** The stable public alias. */
  slug: string;
  /** Epoch ms of this publish. */
  publishedAt: number;
  /** Alias generation: which publish this link now points at. */
  version: number;
  /** The immutable version the alias was pointed at, so a retry cannot drift. */
  versionId: string;
  /** Entry file inside the published package, e.g. the rewritten `index.html`. */
  entryPath: string;
}

/**
 * Publishing is two effects, and the second one can fail alone.
 *
 * `od` uploads the content and advances the alias, then registers the share
 * binding that makes the link serve. The registration crosses the network
 * separately, so there is a real outcome in the middle: **the content is
 * published and the alias has moved, but the link is not bound yet.**
 *
 * ## Why this needs its own status rather than an error
 *
 * Reporting it as a failure is a lie the user pays for twice: the content DID
 * upload, and the alias DID advance, so a retry of the whole publish would
 * push the pointer forward again for nothing. Reporting it as success is
 * worse — the person is handed a link that does not serve.
 *
 * Collapsing it also loses the receipt. `share.go` returns its binding error
 * before it writes the share receipt to stdout, which is exactly how the
 * daemon came to lose a confirmed publish; that is a defect against this
 * contract, not a shape this contract accommodates.
 *
 * ## Retry means binding only
 *
 * A `binding_pending` publish is resumed by registering the binding again for
 * the same project, slug and `versionId` under the original identity. It must
 * NOT re-run the publish: that advances the alias and invents a new version
 * nobody asked for. The queue that carries these retries must also be
 * distinct from the stop queue — a binding task misfiled as a stop would
 * revoke the very share it was meant to complete.
 *
 * ## A failure BEFORE the content lands is still an ordinary error
 *
 * This union covers outcomes where a receipt exists. A publish that failed
 * before confirming anything keeps the existing error response; do not dress
 * it up as `binding_pending` with an empty receipt.
 */
export type SharePublishResult =
  | {
      status: 'published';
      receipt: SharePublishReceipt;
      /** Absent on purpose: a bound share has nothing pending to warn about. */
      binding?: never;
    }
  | {
      status: 'binding_pending';
      receipt: SharePublishReceipt;
      binding: SharePublishBindingPending;
    };

/**
 * Why the link is not serving yet, and whether anyone will fix it.
 *
 * `retrying` is the DAEMON's fact and only the daemon may assert it: it is
 * true once a durable enqueue has succeeded, and false otherwise — including
 * when the enqueue itself failed. The vela CLI cannot fill this in, because it
 * does not own the queue; a CLI result that claims it is reporting something
 * it cannot know.
 *
 * A failed enqueue is therefore still `binding_pending`, with
 * `retrying: false`. It is never full success (the link does not serve) and
 * never a generic publish failure (the content is up). That combination is
 * the one that needs a person, which is precisely why it must stay sayable.
 */
export interface SharePublishBindingPending {
  /** Will the daemon keep trying on its own? */
  retrying: boolean;
  /** The binding failure's error code, sanitized for a public response. */
  code?: string;
}

/**
 * Owner, workspace, resource ids and queue revision tokens stay OUT of the
 * public publish response.
 *
 * The daemon needs every one of them to retry a binding under the original
 * identity and generation, and it already holds them. Echoing them to a
 * caller would publish internal identifiers to buy nothing, and a token in a
 * response is a token in a log.
 */
export const SHARE_PUBLISH_RESPONSE_OMITS_INTERNAL_IDS = true;

/* ------------------------------------------------------------------ *
 * Share entry: is what is serving still what you would publish?
 * ------------------------------------------------------------------ */

/**
 * Whether the live share still matches the content it would publish now.
 *
 * This is a SECOND axis, orthogonal to {@link ShareStatus}. Status answers
 * "does a share exist and is it serving"; freshness answers "is what it
 * serves still current". Folding them into one enum would force a `stopped`
 * share to also claim a freshness it cannot have.
 *
 * ## `unknown` is a third value, not a default
 *
 * It means the comparison could not be made — the query is in flight, it
 * failed, or the stored record predates fingerprinting and cannot be compared.
 * It is NOT `outdated` and it is NOT "never shared". Collapsing it in either
 * direction is a visible defect:
 *
 * - read as fresh → the entry shows a confident "shared" state for content
 *   that may have moved on
 * - read as outdated → the person is nagged to re-publish something that is
 *   already current
 * - read as none → **the existing share link disappears from the UI**, which
 *   is the worst of the three: the share is still live and public, and the
 *   person has just lost the only handle they had on it
 *
 * So `unknown` keeps the plain entry and keeps the copy-link affordance. It
 * says less, and says nothing false.
 */
export const SHARE_CONTENT_FRESHNESS = ['current', 'outdated', 'unknown'] as const;
export type ShareContentFreshness = (typeof SHARE_CONTENT_FRESHNESS)[number];

/**
 * What may and may not establish `current`.
 *
 * `current` requires positive proof: a fingerprint over the COMPLETE publish
 * plan, compared against the payload of the last successful publish. Complete
 * means the dependency resources too — a share whose entry HTML is untouched
 * but whose stylesheet changed is `outdated`, and a comparison that only
 * looked at the entry would call it `current` and be wrong.
 *
 * None of the following may stand in for that comparison:
 *
 * - **`status === 'active'`** — proves a share is serving, says nothing about
 *   what it serves.
 * - **file mtime** — changes without content changing, and fails to change
 *   when content is restored to an earlier state.
 * - **url or slug** — the slug is a STABLE alias across updates by design
 *   (see the addressing section above). It cannot distinguish versions; that
 *   is the point of it.
 * - **a revision or counter that is not derived from content** — it answers
 *   "did we publish again", not "is the content the same".
 *
 * When the fingerprint is unavailable, the answer is `unknown`. Guessing from
 * any of the above is how a confident wrong state gets shipped.
 */
export const SHARE_FRESHNESS_REQUIRES_CONTENT_FINGERPRINT = true;

/**
 * What the share entry should show, derived once so no surface re-derives it.
 *
 * Three appearances, and the mapping is a total function of the two axes:
 *
 * - `plain` — no live share to point at, or nothing trustworthy to say about
 *   one. Covers `none`, `stopped`, `preparing`, and every `unknown`.
 * - `published` — the "already shared" affirmative state. Requires BOTH an
 *   `active` share AND `current` freshness. Nothing else earns it.
 * - `outdated` — an active share whose content has provably moved on. Leads
 *   to the update path; it must never be drawn as the affirmative state.
 *
 * `canCopyLink` is deliberately separate from appearance: a share that is
 * `active` still has a working link while its freshness is `unknown` or
 * `outdated`, and hiding the copy affordance there would strand the person.
 */
export interface ShareEntryPresentation {
  appearance: 'plain' | 'published' | 'outdated';
  /** True whenever a live link exists, regardless of how fresh it is. */
  canCopyLink: boolean;
}

/**
 * The single place the two axes become an appearance.
 *
 * Kept as a function rather than a table so the `unknown` rule cannot be
 * quietly dropped by a caller writing `status === 'active' ? green : plain`.
 */
export function shareEntryPresentation(input: {
  status: ShareStatus;
  freshness: ShareContentFreshness;
}): ShareEntryPresentation {
  if (input.status !== 'active') {
    return { appearance: 'plain', canCopyLink: false };
  }
  if (input.freshness === 'current') {
    return { appearance: 'published', canCopyLink: true };
  }
  if (input.freshness === 'outdated') {
    return { appearance: 'outdated', canCopyLink: true };
  }
  // unknown: the link works, but nothing affirmative may be claimed about it.
  return { appearance: 'plain', canCopyLink: true };
}

/* ------------------------------------------------------------------ *
 * Reading one file's share state
 * ------------------------------------------------------------------ */

/**
 * `GET /api/projects/:projectId/files/:filePath/publish-public`
 *
 * Three fields, deliberately independent. Each answers a different question
 * and each can be absent or unknown on its own:
 *
 * - `publication` — the LOCAL record of what was published: the link to show
 *   and copy. `null` means no local record.
 * - `status` — whether a share exists and is serving, from the lifecycle
 *   source of truth.
 * - `freshness` — whether what is serving still matches current content.
 *
 * ## `publication: null` is not `status: 'none'`
 *
 * Losing the local record is a gap in what we know, not proof that nothing is
 * shared. A share registered under this identity can be live and public while
 * this daemon has no row for it — after a reinstall, a data-dir move, or a
 * record written before this field existed.
 *
 * Collapsing the two makes the UI say "not shared" about a link that is
 * serving, and takes away the only handle the person had on it. That is the
 * same failure the `unknown` freshness rule exists to prevent, arriving
 * through a different door.
 *
 * ## A local row does not prove the cloud says `active`
 *
 * `publication` is written by this daemon; `status` belongs to the share
 * lifecycle, which lives on the other side of the network. A stopped share
 * leaves the local row in place ON PURPOSE, so the same slug can resume.
 * Deriving `status` from `publication != null` would make `stopped`
 * unreachable and re-break the thing the four-state enum exists for.
 *
 * ## A failed read changes nothing
 *
 * On a non-2xx, a caller keeps what it already had: the previously known link
 * stays on screen and freshness degrades to `unknown`. It must not rewrite
 * state to `none` — a request that did not answer is not an answer.
 *
 * ## Caching
 *
 * Scope any cache by identity + project + file, because all three change what
 * the correct answer is. Invalidate and re-read after a successful publish,
 * update or stop. Drop the old scope's entries when the identity changes
 * rather than letting them answer for the new one. The card and the toolbar
 * read the SAME entry — two independent polls of the same fact would let the
 * two surfaces disagree on screen.
 */
export interface ProjectFilePublicShareResponse {
  /** Local record of the published link; `null` when we hold none. */
  publication: PublicProjectFilePublication | null;
  /** From the lifecycle source, not inferred from `publication`. */
  status: ShareStatus;
  /** From a content fingerprint comparison; `unknown` until one is available. */
  freshness: ShareContentFreshness;
}
