import type { UtcTimestamp } from "@driveguard/domain";

import { ExecutorFault } from "./errors.js";
import type {
  ExecutionAttempt,
  ExecutionRecord,
  ExecutionRequest,
  ExecutionState,
} from "./types.js";

const LEGAL: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = Object.freeze({
  CREATED: Object.freeze(["RUNNING", "REJECTED"] as const),
  RUNNING: Object.freeze(["SUCCEEDED", "FAILED", "RETRY_EXHAUSTED", "OUTCOME_UNKNOWN"] as const),
  SUCCEEDED: Object.freeze([]),
  FAILED: Object.freeze([]),
  RETRY_EXHAUSTED: Object.freeze([]),
  OUTCOME_UNKNOWN: Object.freeze([]),
  REJECTED: Object.freeze([]),
});

function freeze(record: ExecutionRecord): ExecutionRecord {
  for (const attempt of record.attempts) Object.freeze(attempt);
  Object.freeze(record.attempts);
  Object.freeze(record.stateHistory);
  return Object.freeze(record);
}

export class ExecutionRecordStore {
  readonly #records = new Map<string, ExecutionRecord>();

  create(request: ExecutionRequest, createdAt: UtcTimestamp): ExecutionRecord {
    if (this.#records.has(request.executionId)) {
      throw new ExecutorFault("EXECUTION_VALIDATION_ERROR", "Duplicate executionId");
    }
    const record = freeze({
      executionId: request.executionId,
      toolName: request.toolName,
      actionFingerprint: request.actionFingerprint,
      idempotencyKey: request.idempotencyKey,
      state: "CREATED",
      attempts: Object.freeze([]),
      stateHistory: Object.freeze([
        Object.freeze({ from: null, to: "CREATED", transitionedAt: createdAt }),
      ]),
      createdAt,
      updatedAt: createdAt,
    });
    this.#records.set(request.executionId, record);
    return record;
  }

  get(executionId: string): ExecutionRecord | undefined {
    return this.#records.get(executionId);
  }

  transition(executionId: string, next: ExecutionState, at: UtcTimestamp): ExecutionRecord {
    const current = this.#require(executionId);
    if (!LEGAL[current.state].includes(next)) {
      throw new ExecutorFault("INTERNAL_EXECUTION_ERROR", "Illegal execution transition");
    }
    const updated = freeze({
      ...current,
      state: next,
      updatedAt: at,
      stateHistory: [
        ...current.stateHistory,
        Object.freeze({ from: current.state, to: next, transitionedAt: at }),
      ],
    });
    this.#records.set(executionId, updated);
    return updated;
  }

  addAttempt(executionId: string, attempt: ExecutionAttempt): ExecutionRecord {
    const current = this.#require(executionId);
    if (current.state !== "RUNNING") {
      throw new ExecutorFault("INTERNAL_EXECUTION_ERROR", "Attempt requires RUNNING state");
    }
    const updated = freeze({
      ...current,
      updatedAt: attempt.completedAt,
      attempts: [...current.attempts, attempt],
    });
    this.#records.set(executionId, updated);
    return updated;
  }

  #require(executionId: string): ExecutionRecord {
    const record = this.#records.get(executionId);
    if (record === undefined) {
      throw new ExecutorFault("INTERNAL_EXECUTION_ERROR", "ExecutionRecord was not found");
    }
    return record;
  }
}
