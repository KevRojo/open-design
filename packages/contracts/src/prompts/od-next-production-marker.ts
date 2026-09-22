import { serializeOdNextRequestTurnV1 } from './od-next-prompt-bundle.js';

/** Host-only identity for plain incremental request text; never sent as a wrapper. */
export const OD_NEXT_RESUME_REQUEST_SCHEMA = 'open-design.od-next-resume-request/v1' as const;

export const OD_NEXT_PRODUCTION_MARKER_PROTOCOL = 'OD Next production-marker/v1';

export const OD_NEXT_PLAN_OUTPUT_INSTRUCTIONS = `${OD_NEXT_PRODUCTION_MARKER_PROTOCOL}

Decide from the user's actual request whether a separate planning turn is needed.
When continuing an existing task with an actionable plan, follow the latest user
request and execute that plan directly; do not repeat a completed planning turn.
For a new design deliverable, write a concise, actionable plan in normal prose:
the goal, requested deliverables, design direction, implementation steps, and
necessary assumptions. Do not build the deliverables in this planning turn.
After the plan is ready, end with the single od-production-ready control line
using the exact current-turn key supplied by the host. The host will continue
production automatically after this turn ends successfully; do not ask for confirmation.
Do not emit the marker for a plan-only/no-write request, an unanswered question,
a non-design answer, an unfinished plan, or a direct edit already completed.
If information is sufficient, use reasonable stated assumptions instead of asking.
Plan mode requires editable Markdown documents.
Chat mode permits explicitly requested trivial file changes. Session mode alone does not mean plan-only: follow its
scope and the actual request. Never expand scope when the user answers a question.
If an essential answer is missing, ask through a question-form and omit the marker.
During production, execute the plan, then describe the actual files and remaining
gaps in prose. Never emit another production-ready marker in production.
Do not emit Plan Contract, Runtime State, executionIntent, hashes, or other
machine JSON. Host identity and lifecycle are recorded by Open Design.
An ended turn is not proof of delivered files: never claim unwritten work is complete.`;

export function renderOdNextProductionReadyInstructions(key: string): string {
  if (!/^[a-f0-9]+$/.test(key)) return '';
  return `Plan-to-production continuation:
Only when this turn finishes an actionable plan for a user-requested deliverable,
and production should follow automatically, write this exact line as the last
non-empty line of your response, outside code fences, quotes, or tool output:
<od-production-ready key="${key}" />
Copy this turn's key exactly. This line requests one production turn; it does
not claim delivery. Omit it for plan-only requests, pending questions, ordinary
answers, and already completed direct edits. Do not explain the control line.`;
}

export function composeOdNextMarkerProductionTurn(input: {
  taskExecutionId: string;
  taskRunIndex: number;
}): string {
  return serializeOdNextRequestTurnV1({
    ...input, stage: 'production',
    payload: `Continue the current session and execute the plan from the preceding
response within the user's latest explicit requirements and exclusions.
Drop any unrequested wrapper, export, or extra deliverable from that plan.
Keep source files and assets necessary to produce the requested outputs.
Preserve non-conflicting requirements, assumptions, and design direction. This is the production turn; do not re-plan or request
confirmation of the accepted plan. Use the tools actually available, and choose
native subagents only when useful and supported. No structured plan, capability
proof, Runtime State, or hash is required. Do not emit od-production-ready again.
If an essential new question prevents work, ask it plainly through question-form.
Finish with a concise description of files actually produced and any remaining
gaps. Never claim that a plan, a tool invocation, or an absent file is delivery.`,
  });
}
