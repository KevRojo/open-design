import type { TouchpointStaticAction } from "./touchpoint-static-actions";
import { touchpointStaticActionsMatch } from "./touchpoint-static-actions";
import {
	ensureWebTouchpointElement,
	emitWebTouchpointDiagnostic,
	hasWebTouchpointCloseControl,
	readWebTouchpointHostContext,
	verifyWebTouchpoint,
	webTouchpointContext,
	type WebTouchpointContent,
	type OpenDesignTouchpointElement,
} from "./touchpoint-component";

import { useCallback, useEffect, useRef, useState } from "react";

export type AuthorizationTiming = Readonly<{
	serverTime: string;
	endsAt: string;
	authorizationExpiresAt: string;
}>;

/**
 * The Test runtime's authorization contract: it may not grant display for
 * longer than this at a time. It is a property of that runtime's protocol, not
 * a duration anyone chose as "long enough" — production has no counterpart and
 * must not be given one. See {@link resolveAuthorizationDeadline}.
 */
export const TEST_MAX_AUTHORIZATION_MS = 60_000;

/**
 * The server grants display authority. A client may REFUSE a grant its own
 * runtime contract forbids; it may never quietly shorten one.
 *
 * `maximumAuthorizationMs` is that contract, and it is a rejection threshold
 * rather than a ceiling: an authorization longer than it yields `null` — no
 * decision at all — never a silently shortened deadline. Only the Test runtime
 * has such a contract ({@link TEST_MAX_AUTHORIZATION_MS}). Production passes
 * nothing, because the server enforces no maximum schedule length and its own
 * production-runtime fixtures run windows of 2020-01-01 to 2100-01-01.
 *
 * The minimum used to carry a third term, `serverTime + maximum`, and three
 * times running that term was given a number which answered some OTHER question
 * and thereby became the binding answer to this one:
 *
 *  - Five minutes, the interval between polls. Every longer authorization came
 *    back as five minutes, so a client that could not reach the server went
 *    blank in the middle of an activity that was still running.
 *  - `MAX_TIMER_MS`, the reach of one `setTimeout`. Every schedule longer than
 *    ~24.9 days came back truncated. `armExpiry` already segments a longer
 *    wait, so the timer limit was never the lease's problem to solve; borrowing
 *    it moved the same defect up a tier, and a device offline past that point
 *    woke to what looked like a new presentation whose impression retired a
 *    campaign the server was still running.
 *  - Ten years, a guess at "far enough that no operator's schedule reaches it".
 *    The fixtures above reach it. (It was not even ten years: 10 * 365 days
 *    lands two days short, which is its own small sign that the number was
 *    never derived from anything.)
 *
 * Every one of the three was defended as a backstop against a server clock that
 * has fallen behind — `validForMs` is `deadline - serverTime`, so a lagging
 * `serverTime` inflates the window, and `endsAt` cannot catch that because it
 * is the very thing the lag is measured against. The defence does not survive
 * the arithmetic. A duration cap sees only the SUM of the skew and the
 * schedule, so it cannot bound one without binding the other: a value small
 * enough to catch a month of skew truncates every multi-year campaign, and a
 * value large enough to clear a 74-year schedule catches no skew worth the
 * name. The two requirements are mutually exclusive by construction — which is
 * precisely why each number picked for the skew question turned into the
 * binding term for the schedule question. There is no fourth value to try, and
 * the term is gone rather than widened.
 *
 * What answers the skew question instead:
 *
 *  - The minimum still contains `authorizationExpiresAt`. Whenever the server
 *    issues a clock-derived credential window, `deadline - serverTime` is two
 *    readings of the SAME clock, so a uniform offset cancels out exactly.
 *  - `endsAt <= serverTime` still refuses an activity already over on the
 *    server's own clock.
 *  - `POLL_MS`. A successful response REPLACES `validForMs` outright, so an
 *    inflated window is only ever spent by a client that cannot reach the
 *    server for the whole of it; reconnecting, or a corrected server clock,
 *    supersedes it at the next poll.
 *
 * What is left is accepted deliberately: a server clock wrong by a month
 * over-displays by a month — the error is the size of the SKEW, not the size of
 * the lease, so it does not grow with the schedule — and a server in that state
 * is mis-deciding `startsAt` and `endsAt` for every client at once, which is
 * not a fault a client can repair by shortening its own lease. Do NOT reach for
 * the obvious replacement and compare `serverTime` against the device's
 * `Date.now()`: the device clock is the least reliable clock in this system,
 * and refusing a grant the server made because a user's laptop is wrong is
 * OPEND-3366 once more, from a new source.
 */
export function resolveAuthorizationDeadline(timing: AuthorizationTiming, maximumAuthorizationMs?: number): number | null {
	const serverTime = Date.parse(timing.serverTime);
	const endsAt = Date.parse(timing.endsAt);
	const authorizationExpiresAt = Date.parse(timing.authorizationExpiresAt);
	if (!Number.isFinite(serverTime) || !Number.isFinite(endsAt) || !Number.isFinite(authorizationExpiresAt) || endsAt <= serverTime) return null;
	if (maximumAuthorizationMs !== undefined && (authorizationExpiresAt > serverTime + maximumAuthorizationMs || authorizationExpiresAt > endsAt)) return null;
	return Math.min(authorizationExpiresAt, endsAt);
}

/**
 * The identity a lease key exists to compare: is this still the same content,
 * for the same person, from the same deployment?
 *
 * `touchpointDecisionId` used to be part of every placement's key. It is not
 * content identity — it is a one-shot credential the server re-issues whenever
 * its own sixty-second row lapses. With a thirty-second poll, missing two polls
 * (a Wi-Fi switch, a tunnel, a closed lid) was enough to get a new one, and a
 * new key means `++generation`: shadow DOM rebuilt, Blob URLs re-created, entry
 * animation replayed, scroll lock released and re-taken. Stabilising the id
 * server-side (OPEND-3369) removed the every-thirty-seconds version of that
 * churn but left the network-wobble version, which lands on exactly the users
 * the recovery-lifecycle P1 was about.
 *
 * Keeping the credential out of the key means a matching key retains the
 * previous decision OBJECT, so the client goes on presenting a credential the
 * server has long since expired. That is safe because the server no longer
 * ties either use of it to the credential's own window: revocation receipts
 * answer for aged ids (OPEND-3372) and click settlement is bound to the
 * deployment's delivery window (OPEND-3364). `validForMs` is always taken from
 * the new response, so a shortened authorization still applies immediately.
 *
 * Shared by all three production placements so their keys cannot drift apart.
 */
export const touchpointContentIdentity = (decision: {
	activityId: string;
	deploymentId: string;
	content: { id: string };
}) => `${decision.activityId}:${decision.deploymentId}:${decision.content.id}`;

/**
 * A lease carries two things, and they age in opposite directions.
 *
 * Its content identity is STABLE: that is what {@link touchpointContentIdentity}
 * compares, and while it matches, the previous decision object is retained so
 * the host keeps its mount. Its authorization window is FRESH: `validForMs` is
 * taken from the newest response every time, so an activity an operator cuts
 * short still ends on time.
 *
 * `serverTime`, `endsAt` and `authorizationExpiresAt` describe the second thing
 * while living in the object that is retained for the first. A retained value's
 * copies of them are simply the numbers some earlier response happened to
 * carry. Nothing reads them today — but that is a fact about who has written
 * the consumers so far, not about the code, and the day someone adds
 * `decision.endsAt` to a countdown they will read an end time the operator has
 * already moved, with nothing failing to tell them.
 *
 * So they do not survive into the lease. The type says so, and the value really
 * does not carry them, which keeps the guarantee true for a consumer that casts
 * its way around the type.
 *
 * Scope, because this reads like a property of the hook and is not one: it
 * holds wherever this helper is applied, which is the three PRODUCTION
 * placements — Modal, Badge and Hover. `useTouchpointLifecycle` has a fourth
 * consumer, `TestCampaignModal`, whose lease value retains whole decisions with
 * their timing intact. That is deliberate: the Test channel exists to show an
 * operator what the schedule is doing, its authorization is capped at sixty
 * seconds, and every round recomputes from a fresh `serverTime`, so nothing it
 * retains can be stale by more than one poll. Nothing enforces the boundary
 * either — a fifth consumer would inherit neither the helper nor this note — so
 * read it as three audited call sites rather than as an invariant of the hook.
 */
export type TouchpointAuthorizationTimingField =
	| "serverTime"
	| "endsAt"
	| "authorizationExpiresAt";
export type TouchpointLeaseValue<T> = Omit<T, TouchpointAuthorizationTimingField>;
const AUTHORIZATION_TIMING_FIELDS: readonly string[] = [
	"serverTime",
	"endsAt",
	"authorizationExpiresAt",
];
export const touchpointLeaseValue = <T extends object>(decision: T): TouchpointLeaseValue<T> =>
	Object.fromEntries(
		Object.entries(decision).filter(([field]) => !AUTHORIZATION_TIMING_FIELDS.includes(field)),
	) as TouchpointLeaseValue<T>;

export type TouchpointLifecycleLoad<T> =
	| Readonly<{ kind: "decision"; value: T; key: string; validForMs: number }>
	| Readonly<{ kind: "waiting"; retryAfterMs: number }>
	| Readonly<{ kind: "retain" }>
	| Readonly<{ kind: "clear"; ended?: boolean }>;

type LifecycleStatus = "loading" | "before" | "active" | "ended" | "error" | null;
export type TouchpointLifecycleOptions<T> = Readonly<{
	enabled: boolean;
	identity: string | null;
	load: (signal: AbortSignal, active: T | null) => Promise<TouchpointLifecycleLoad<T>>;
	onError?: (error: unknown) => void;
}>;

type Clock = { monotonic: number; wall: number };
const clock = (): Clock => ({ monotonic: performance.now(), wall: Date.now() });
/**
 * How long a lease has been alive, measured against both clocks so that neither
 * can be used to overstay.
 *
 * The monotonic term stops a wall clock that is set BACK from granting time.
 * The wall term stops a sleeping device from freezing the lease, because
 * `performance.now()` pauses across sleep on some platforms and a lease would
 * otherwise survive the night un-aged. Both are load-bearing; dropping either
 * one re-opens the cheat it closes.
 *
 * What `max` does NOT give is monotonicity. A wall clock that steps FORWARD and
 * is then corrected BACK — an NTP step, a resumed VM, a dual-boot machine —
 * makes this rise and then fall again. Callers must not assume that "expired"
 * is a property which, once true, stays true; OPEND-3376 and OPEND-3378 are
 * both defects that came from assuming it. Each consumer is audited, and the
 * ones whose answer depends on the direction of the error say so at the call
 * site.
 */
const elapsed = (start: Clock) => Math.max(0, performance.now() - start.monotonic, Date.now() - start.wall);
const POLL_MS = 30_000;
/**
 * One refresh fetches a context and every enabled placement's content, so the
 * budget has to cover a whole round, not one request. A ten-second budget was
 * measured being exceeded by a real round (11.5s) whose placements all
 * succeeded, which abandoned a campaign that was working.
 *
 * It stays well under `POLL_MS` on purpose: a budget at or above the interval
 * would let a hung attempt swallow the next tick entirely.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
/**
 * A failed attempt used to get its next chance from the fixed 30s tick, which
 * for a sixty-second lease lands exactly when that lease expires — one failure
 * put display on the edge of going blank with no chance to recover.
 *
 * These bounded retries cover FAST failures (transport error, 5xx, DNS), which
 * return in milliseconds and leave the whole budget intact. A slow failure that
 * burns the full timeout cannot be retried inside the lease, and should not be:
 * a lease the server will not renew in time is one that ought to lapse.
 */
export const RETRY_BACKOFF_MS = [1_000, 3_000] as const;
/**
 * The largest delay a single `setTimeout` can name. This bounds one timer
 * SEGMENT and nothing else: `armExpiry` and the `waiting` boundary both cut a
 * longer wait into segments of at most this, so no individual timer overflows
 * into firing immediately.
 *
 * It is NOT a bound on how long display may be authorized. Those are two
 * different questions, and the whole of OPEND-3366 is what happens when one
 * answer is used for both. There is no lease bound left for it to be mistaken
 * for — {@link resolveAuthorizationDeadline} explains why none can exist — and
 * this value must not acquire a second job to become one again.
 */
const MAX_TIMER_MS = 2_147_483_647;
/** Only a failure carrying the server's own withdrawal may end a live lease. */
export const touchpointWithdrawsDisplay = (error: unknown) =>
	typeof error === "object" && error !== null && (error as { touchpointWithdrawal?: unknown }).touchpointWithdrawal === true;

/**
 * One scheduling implementation for both runtime adapters. A response supplies
 * server-relative authority, never a client activation time. Renewing the same
 * immutable decision keeps its mount identity while replacing its lease.
 */
export function useTouchpointLifecycle<T>({ enabled, identity, load, onError }: TouchpointLifecycleOptions<T>) {
	const [state, setState] = useState<{ identity: string | null; current: T | null; generation: number; status: LifecycleStatus }>({ identity: null, current: null, generation: 0, status: null });
	const generation = useRef(0);
	const lease = useRef<{ identity: string; key: string; value: T; generation: number; start: Clock; validForMs: number } | null>(null);
	const inputs = useRef({ enabled, identity, onError });
	inputs.current = { enabled, identity, onError };
	const clearRef = useRef<() => void>(() => {});
	const clear = useCallback(() => clearRef.current(), []);
	const isCurrent = useCallback((expected: number) => {
		const current = lease.current;
		return Boolean(current && inputs.current.enabled && current.identity === inputs.current.identity && current.generation === expected && elapsed(current.start) < current.validForMs && !document.hidden);
	}, []);

	useEffect(() => {
		let stopped = false;
		let ended = false;
		// Suspend display during recovery; a no-decision reply may retain only the original, unextended lease.
		let revalidationLease: typeof lease.current = null;
		let request: AbortController | null = null;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let expiryTimer: ReturnType<typeof setTimeout> | undefined;
		let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let retryIndex = 0;
		/** When the current cycle began, so retries can be kept inside it. */
		let cycleStart: Clock | null = null;
		let status: LifecycleStatus = enabled && identity ? "loading" : null;
		const publish = () => {
			if (stopped) return;
			const next = { identity, current: lease.current?.value ?? null, generation: generation.current, status };
			setState(previous => previous.identity === next.identity && previous.current === next.current && previous.generation === next.generation && previous.status === next.status ? previous : next);
		};
		const cancelRequest = () => {
			request?.abort();
			request = null;
			clearTimeout(timeout);
		};
		const revoke = () => {
			cancelRequest();
			clearTimeout(expiryTimer);
			clearTimeout(boundaryTimer);
			clearTimeout(retryTimer);
			lease.current = null;
			++generation.current;
			publish();
		};
		/**
		 * A timeout or transport failure is not a revocation. Cancel the attempt
		 * and keep display authority the server already granted; `armExpiry`
		 * still retires it at its own deadline, so one poll may be missed and a
		 * second consecutive failure lets the lease lapse on its own. A lease
		 * `wake` set aside is judged the same way — by its own window, not by the
		 * fact that nothing is on screen while it is being revalidated.
		 */
		const abandonAttempt = (error: unknown) => {
			cancelRequest();
			// Judge the lease that is still recoverable — the active one, or the
			// one `wake` set aside — by its OWN window. Asking whether there is an
			// ACTIVE lease and calling "none" expired is what made a single
			// failure permanent: `wake` empties `lease.current` before it
			// revalidates, so the next failure met that branch, spent the
			// set-aside lease too, and the retry that succeeded came back
			// `{kind:"retain"}` with nothing left to restore.
			const recoverable = lease.current ?? revalidationLease;
			if (touchpointWithdrawsDisplay(error) || !recoverable || elapsed(recoverable.start) >= recoverable.validForMs) {
				revalidationLease = null;
				status = "error";
				revoke();
			}
			// Scheduled after any revoke above, which clears the retry timer: an
			// authoritative withdrawal must not be retried back onto the screen.
			//
			// A retry must also finish inside the cycle that spawned it. `refresh`
			// declines to start while a request is in flight, so a chain that ran
			// past the next tick would not merely be late — it would swallow that
			// tick entirely. Requiring room for the retry AND its full budget is
			// what makes "retries cover fast failures" true in the code and not
			// only in this comment: a failure that burned the whole budget leaves
			// no room by construction, so it is never retried.
			const delay = RETRY_BACKOFF_MS[retryIndex] ?? 0;
			const remainingInCycle = cycleStart === null ? 0 : POLL_MS - elapsed(cycleStart);
			if (
				!touchpointWithdrawsDisplay(error) &&
				retryIndex < RETRY_BACKOFF_MS.length &&
				delay + REQUEST_TIMEOUT_MS <= remainingInCycle
			) {
				retryIndex += 1;
				clearTimeout(retryTimer);
				retryTimer = setTimeout(() => void refresh(true), delay);
			}
			inputs.current.onError?.(error);
		};
		clearRef.current = () => { revalidationLease = null; revoke(); };
		revoke();
		if (!enabled || !identity) return () => { stopped = true; revoke(); };

		const armExpiry = () => {
			clearTimeout(expiryTimer);
			const tick = () => {
				const current = lease.current;
				if (stopped || !current) return;
				const remaining = current.validForMs - elapsed(current.start);
				if (remaining <= 0) revoke();
				else expiryTimer = setTimeout(tick, Math.min(remaining, MAX_TIMER_MS));
			};
			tick();
		};
		/**
		 * `retrying` distinguishes a scheduled retry from a fresh cycle. Only a
		 * fresh cycle restores the retry budget: without that, the first cycle to
		 * exhaust its retries would leave every later cycle with none.
		 */
		const refresh = async (retrying = false) => {
			if (stopped || ended || request || document.hidden) return;
			if (!retrying) {
				retryIndex = 0;
				cycleStart = clock();
				clearTimeout(retryTimer);
			}
			const controller = new AbortController();
			const started = clock();
			request = controller;
			const ownsRequest = () => !stopped && request === controller && !controller.signal.aborted;
			timeout = setTimeout(() => {
				if (!ownsRequest()) return;
				abandonAttempt(new Error("touchpoint_request_timeout"));
			}, REQUEST_TIMEOUT_MS);
			try {
				const result = await load(controller.signal, lease.current?.value ?? revalidationLease?.value ?? null);
				if (!ownsRequest()) return;
				clearTimeout(timeout);
				request = null;
				// A completed attempt restores the full retry budget for the next one.
				retryIndex = 0;
				clearTimeout(retryTimer);
				if (result.kind === "retain") {
					if (!lease.current && revalidationLease && elapsed(revalidationLease.start) < revalidationLease.validForMs) {
						lease.current = { ...revalidationLease, generation: generation.current };
						status = "active";
						publish();
						armExpiry();
					}
					revalidationLease = null;
					return;
				}
				if (result.kind === "clear") {
					revalidationLease = null;
					ended = result.ended === true;
					status = ended ? "ended" : null;
					revoke();
					return;
				}
				if (result.kind === "waiting") {
					revalidationLease = null;
					if (!Number.isFinite(result.retryAfterMs)) throw new Error("touchpoint_invalid_timing");
					status = "before";
					revoke();
					const retry = () => {
						if (stopped) return;
						const remaining = result.retryAfterMs - elapsed(started);
						if (remaining > MAX_TIMER_MS) boundaryTimer = setTimeout(retry, MAX_TIMER_MS);
						else boundaryTimer = setTimeout(() => void refresh(), Math.max(100, remaining));
					};
					retry();
					return;
				}
				status = "active";
				clearTimeout(boundaryTimer);
				if (!Number.isFinite(result.validForMs) || result.validForMs <= elapsed(started)) {
					revoke();
					return;
				}
				const previous = lease.current ?? revalidationLease;
				// A lease that is STILL MOUNTED renews; only one that has to be
				// resumed from the side has to prove it is still inside its window.
				//
				// Asking `elapsed` in both cases made a clock step forward count a
				// renewal as a new presentation — a rebuilt host and a replayed
				// entry animation for a campaign that never left the screen
				// (OPEND-3378). It also cannot be right: nothing evaluates `elapsed`
				// until something asks, so a step alone tears nothing down, and
				// there is no withdrawal for that re-mount to correspond to. A
				// mounted lease that has genuinely lapsed is not reachable here
				// either — `armExpiry` retires it, which empties `lease.current`.
				const resumed = previous !== null && previous !== lease.current;
				const same =
					previous?.key === result.key &&
					previous.identity === identity &&
					(!resumed || elapsed(previous.start) < previous.validForMs);
				if (!same) ++generation.current;
				lease.current = { identity, key: result.key, value: same ? previous.value : result.value, generation: generation.current, start: started, validForMs: result.validForMs };
				revalidationLease = null;
				publish();
				armExpiry();
			} catch (error) {
				if (stopped || controller.signal.aborted) return;
				abandonAttempt(error);
			} finally {
				if (request === controller) {
					request = null;
					clearTimeout(timeout);
				}
			}
		};
		/**
		 * Withdraw display first and ask afterwards. Reserved for the cases where
		 * the client already knows the authority is gone — the lease lapsed, the
		 * identity changed, the content failed verification — never for a page
		 * that merely came back.
		 */
		const wake = () => {
			if (stopped || ended) return;
			revalidationLease = lease.current ?? revalidationLease;
			status = document.hidden ? status : "loading";
			revoke();
			if (!document.hidden) void refresh();
		};
		/**
		 * Returning to the page is not evidence that the activity ended.
		 *
		 * `online`, `pageshow` and `visibilitychange` used to run `wake`, which
		 * revoked synchronously and left nothing on screen while the revalidation
		 * it started was still in flight — so switching Wi-Fi, waking from sleep
		 * or tabbing away tore down a campaign the server had authorized. Worse,
		 * an emptied lease made `abandonAttempt`'s `!lease.current` branch true,
		 * so one failed revalidation dropped the saved lease too and the activity
		 * could never be restored for the rest of the session.
		 *
		 * A lease that is still inside the window the server granted therefore
		 * keeps its mount and revalidates in the background. Only a lapsed lease
		 * falls through to `wake`. A hidden page cancels the attempt in flight,
		 * because no answer can be acted on while `isCurrent` fences it, and
		 * leaves the lease exactly as it was: `armExpiry` still retires it on the
		 * server's own deadline whether the page is watching or not.
		 */
		const resume = () => {
			if (stopped || ended) return;
			if (document.hidden) {
				cancelRequest();
				return;
			}
			const current = lease.current;
			if (current && elapsed(current.start) < current.validForMs) void refresh();
			else wake();
		};
		const offline = () => cancelRequest();
		void refresh();
		const interval = setInterval(() => void refresh(), POLL_MS);
		window.addEventListener("focus", resume);
		window.addEventListener("online", resume);
		window.addEventListener("pageshow", resume);
		window.addEventListener("offline", offline);
		document.addEventListener("visibilitychange", resume);
		return () => {
			stopped = true;
			revoke();
			clearTimeout(retryTimer);
			clearInterval(interval);
			window.removeEventListener("focus", resume);
			window.removeEventListener("online", resume);
			window.removeEventListener("pageshow", resume);
			window.removeEventListener("offline", offline);
			document.removeEventListener("visibilitychange", resume);
		};
	}, [enabled, identity, load]);

	return {
		current: enabled && state.identity === identity ? state.current : null,
		status: enabled && state.identity === identity ? state.status : null,
		generation: state.generation,
		clear,
		isCurrent,
		get deadline() {
			const current = lease.current;
			return current && inputs.current.enabled && current.identity === inputs.current.identity ? Date.now() + Math.max(0, current.validForMs - elapsed(current.start)) : 0;
		},
	};
}


/**
 * A host that is laid out but still reports no box has not been committed yet;
 * one that reports a box while the page is hidden was never shown. Neither can
 * be decided from a single sample, so the warning only reports, never resolves.
 */
export const VISIBILITY_WARNING_MS = 5_000;

export type TouchpointVisibilityWatch = Readonly<{
	element: HTMLElement;
	isCurrent: () => boolean;
	onVisible: () => void;
	onSlow?: (code: string) => void;
	slowAfterMs?: number;
}>;

/**
 * Resolves the first moment a mounted host is really on screen, then stops.
 *
 * Sampling once cannot answer this. `hidden` is bound to React state, and a
 * frame scheduled in the same continuation as that state update can run before
 * React commits it — the host is then still `display: none` and reports no box.
 * Because the old callers never looked again, that one lost sample permanently
 * suppressed the receipt for the whole session. Three sources can change the
 * answer, so all three re-check: layout (`ResizeObserver`, which also fires the
 * initial observation), page visibility, and the caller's own re-mount.
 */
export function watchTouchpointVisibility({
	element,
	isCurrent,
	onVisible,
	onSlow,
	slowAfterMs = VISIBILITY_WARNING_MS,
}: TouchpointVisibilityWatch): () => void {
	let recorded = false;
	let stopped = false;
	let frame: number | undefined;
	let observer: ResizeObserver | undefined;
	let slowTimer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (frame !== undefined) cancelAnimationFrame(frame);
		frame = undefined;
		observer?.disconnect();
		if (slowTimer !== undefined) clearTimeout(slowTimer);
		document.removeEventListener("visibilitychange", check);
	};
	function check() {
		if (stopped || recorded || frame !== undefined) return;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			if (stopped || recorded) return;
			if (
				!isCurrent() ||
				document.hidden ||
				!element.isConnected ||
				element.hidden ||
				element.getClientRects().length === 0
			)
				return;
			recorded = true;
			stop();
			onVisible();
		});
	}
	// Layout is the strongest signal but the only optional one: a host without
	// `ResizeObserver` must still mount and still report, so its absence costs
	// this watch a wake-up source and never the display itself.
	observer =
		typeof ResizeObserver === "function" ? new ResizeObserver(check) : undefined;
	observer?.observe(element);
	document.addEventListener("visibilitychange", check);
	// A slow host is reported but keeps its watch: a late box still earns its
	// receipt, and dropping the watch here would recreate the lost-sample bug.
	slowTimer = setTimeout(() => {
		if (!recorded && !stopped) onSlow?.("touchpoint_visibility_slow");
	}, slowAfterMs);
	check();
	return stop;
}

type MountAdapter = Readonly<{
	content: WebTouchpointContent;
	placementKey: string;
	staticActions: readonly TouchpointStaticAction[];
	mode: "test" | "production";
	locale: string;
	isCurrent: () => boolean;
	dispatchAction: (id: string) => Promise<void>;
	requestClose?: () => void;
	onReady?: () => void;
	onVisible?: () => void;
	onCloseControlChange?: (available: boolean | null) => void;
	onError?: (code: string) => void;
}>;

/** Shared Test/Production host lifecycle. Late verification and mount completion
 * cannot resurrect a released host; each resource is disposed once. Adapters own
 * authorization, action transport and receipts, never the DOM lifecycle. */
export function mountTouchpoint(
	container: HTMLElement,
	adapter: MountAdapter,
): () => void {
	ensureWebTouchpointElement();
	const element = document.createElement(
		"opend-touchpoint",
	) as OpenDesignTouchpointElement;
	let cancelled = false,
		elementDisposed = false,
		verifiedDisposed = false;
	let verified: Awaited<ReturnType<typeof verifyWebTouchpoint>> | undefined;
	let stopVisibilityWatch: (() => void) | undefined;
	let observer: MutationObserver | undefined;
	const current = () => !cancelled && adapter.isCurrent();
	const dispose = () => {
		if (!elementDisposed) {
			elementDisposed = true;
			void element.dispose(verified?.resourceUrls).catch(() => undefined);
		}
		if (verified && !verifiedDisposed) {
			verifiedDisposed = true;
			verified.dispose();
		}
	};
	const fail = (code: string) => {
		emitWebTouchpointDiagnostic({ code });
		adapter.onCloseControlChange?.(false);
		adapter.onError?.(code);
	};
	adapter.onCloseControlChange?.(null);
	container.replaceChildren(element);
	void (async () => {
		try {
			verified = await verifyWebTouchpoint(adapter.content);
			if (!current()) {
				dispose();
				return;
			}
			const placement = adapter.content.manifest.placements.find(
				(p) => p.key === adapter.placementKey,
			);
			if (
				!placement ||
				adapter.content.placementKey !== adapter.placementKey ||
				!touchpointStaticActionsMatch(
					adapter.staticActions,
					placement.staticActions,
				)
			) {
				fail("touchpoint_decision_mismatch");
				dispose();
				return;
			}
			const context = webTouchpointContext(
				adapter.content,
				readWebTouchpointHostContext(
					adapter.locale,
					document.documentElement.classList.contains("dark")
						? "dark"
						: "light",
				),
			);
			if (!context) {
				fail("touchpoint_locale_unsupported");
				dispose();
				return;
			}
			await element.mount(
				verified.entryUrl,
				adapter.content.entryDigest,
				{ ...context, mode: adapter.mode },
				verified.resourceUrls,
				new Set(adapter.staticActions.map((a) => a.id)),
				{
					requestClose: adapter.requestClose
						? () => {
								if (current()) adapter.requestClose?.();
							}
						: undefined,
					dispatchAction: async (id) => {
						if (current()) await adapter.dispatchAction(id);
					},
					onDiagnostic: emitWebTouchpointDiagnostic,
				},
			);
			if (!current()) {
				dispose();
				return;
			}
			const onVisible = adapter.onVisible;
			if (onVisible)
				stopVisibilityWatch = watchTouchpointVisibility({
					element,
					isCurrent: current,
					onVisible,
					onSlow: (code) => emitWebTouchpointDiagnostic({ code }),
				});
			if (adapter.onCloseControlChange) {
				const update = () => {
					if (current())
						adapter.onCloseControlChange?.(
							hasWebTouchpointCloseControl(element),
						);
				};
				update();
				observer = new MutationObserver(update);
				const options: MutationObserverInit = {
					attributes: true,
					attributeFilter: [
						"aria-label",
						"aria-disabled",
						"aria-hidden",
						"class",
						"disabled",
						"hidden",
						"style",
						"title",
					],
					childList: true,
					characterData: true,
					subtree: true,
				};
				if (element.shadowRoot) observer.observe(element.shadowRoot, options);
				const dialog = element.closest('[role="dialog"]');
				if (dialog) observer.observe(dialog, options);
			}
			adapter.onReady?.();
		} catch (error) {
			if (current())
				fail(error instanceof Error ? error.message : "touchpoint_load_failed");
			dispose();
		}
	})();
	return () => {
		cancelled = true;
		observer?.disconnect();
		stopVisibilityWatch?.();
		adapter.onCloseControlChange?.(null);
		dispose();
		if (element.parentNode === container) container.replaceChildren();
	};
}
