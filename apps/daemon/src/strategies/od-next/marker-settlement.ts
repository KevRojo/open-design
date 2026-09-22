import type Database from 'better-sqlite3';
import { countRenderableQuestionForms } from '../../question-form-detect.js';
import { compareAndTransitionStrategyTaskExecution, getStrategyTaskExecution, type StrategyTaskExecutionRecord } from '../task-store.js';
import type { OdNextCoordinatorResult } from './coordinator.js';
import type { OdNextMachineProtocolResult } from './protocol.js';

export function settleMarkerTurn(db: Database.Database, input: {
  taskExecutionId: string;
  runId: string;
  parsed: OdNextMachineProtocolResult;
  completionEvidence?: { physicalStatus: 'succeeded' | 'failed' | 'canceled'; deliverableValid: boolean };
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
  const settled = compareAndTransitionStrategyTaskExecution(db, {
    taskExecutionId: task.taskExecutionId, expectedRevision: task.revision,
    deliverableValid: input.completionEvidence?.deliverableValid === true,
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

export function markerMayContinue(task: StrategyTaskExecutionRecord, parsed: OdNextMachineProtocolResult): boolean {
  return parsed.productionReady === true
    && Boolean(parsed.visibleText.trim())
    && ['request', 'clarification'].includes(task.inputStage)
    && task.executionIntent !== 'plan_only'
    && task.route !== 'direct_edit'
    && !task.runs.some(run => run.inputStage === 'production')
    && countRenderableQuestionForms(parsed.visibleText) === 0;
}
