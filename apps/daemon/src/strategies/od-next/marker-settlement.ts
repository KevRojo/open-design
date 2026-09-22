import type { StrategySettlementReasonV2 } from '@open-design/contracts';
import type { OdNextReply } from './protocol.js';
import type Database from 'better-sqlite3';
import { countRenderableQuestionForms } from '../../question-form-detect.js';
import { compareAndTransitionStrategyTaskExecution, getStrategyTaskExecution, type StrategyTaskExecutionRecord } from '../task-store.js';
import type { OdNextCoordinatorResult } from './coordinator.js';

export interface MarkerCompletionEvidence {
  physicalStatus: 'succeeded' | 'failed' | 'canceled';
  deliverableValid: boolean;
  truncated?: boolean;
  todoUnfinished?: boolean;
}

export function settleMarkerTurn(db: Database.Database, input: {
  taskExecutionId: string;
  runId: string;
  parsed: OdNextReply;
  completionEvidence?: MarkerCompletionEvidence;
  updatedAt?: number;
}): OdNextCoordinatorResult {
  const task = getStrategyTaskExecution(db, input.taskExecutionId);
  if (!task || task.latestRunId !== input.runId || task.outcome !== 'running') {
    throw new Error('Only the current running task can settle an assistant reply.');
  }
  const status = input.completionEvidence?.physicalStatus;
  const ready = status === 'succeeded' && markerMayContinue(task, input.parsed);
  const outcome = status === 'canceled' ? 'canceled'
    : status !== 'succeeded' ? 'blocked'
      : ready ? 'plan_ready' : 'completed';
  const reasonCodes = outcome === 'blocked' ? ['od_next_physical_run_not_succeeded'] : [];
  const settlementReason: StrategySettlementReasonV2 = status === 'canceled' ? 'canceled'
    : status !== 'succeeded' ? 'run_failed'
      : ready ? 'production_ready'
        : input.completionEvidence?.deliverableValid ? 'deliverable_valid'
          : countRenderableQuestionForms(input.parsed.visibleText) > 0 ? 'question'
            : input.completionEvidence?.truncated ? 'truncated'
              : input.completionEvidence?.todoUnfinished ? 'todo_unfinished'
                : task.executionIntent === 'plan_only' ? 'plan_only'
                  : input.parsed.visibleText.trim() ? 'text_only' : 'empty_reply';
  const settled = compareAndTransitionStrategyTaskExecution(db, {
    taskExecutionId: task.taskExecutionId, expectedRevision: task.revision,
    deliverableValid: input.completionEvidence?.deliverableValid === true,
    settlementReason,
    to: {
      route: task.route ?? 'full_plan', inputStage: task.inputStage,
      outcome, executionMode: task.executionMode ?? (ready ? 'simple' : null),
      executionIntent: task.executionIntent ?? 'produce',
    },
    ...(outcome === 'blocked' ? { blockedContext: { reasonCodes, visibleText: input.parsed.visibleText } } : {}),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  });
  return { action: outcome, task: settled, visibleText: input.parsed.visibleText, reasonCodes };
}

export function markerMayContinue(task: StrategyTaskExecutionRecord, parsed: OdNextReply): boolean {
  return parsed.productionReady === true
    && Boolean(parsed.visibleText.trim())
    && ['request', 'clarification'].includes(task.inputStage)
    && task.executionIntent !== 'plan_only'
    && task.route !== 'direct_edit'
    && !task.runs.some(run => run.inputStage === 'production')
    && countRenderableQuestionForms(parsed.visibleText) === 0;
}
