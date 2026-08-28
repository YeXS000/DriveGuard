import type { ContextSnapshot } from "@driveguard/domain";

import { ActionLifecycleError } from "./errors.js";
import { transitionPendingAction } from "./state-machine.js";
import type { ActionState, ExecutionAuthorization, PendingAction } from "./types.js";

export interface PendingActionRecord {
  readonly action: PendingAction;
  readonly originalContext: ContextSnapshot;
  readonly tokenHash: string | null;
  readonly confirmationId: string | null;
  readonly authorization: ExecutionAuthorization | null;
}

export interface PendingActionRepository {
  create(record: PendingActionRecord): void;
  get(actionId: string): PendingActionRecord | undefined;
  runExclusive<T>(actionId: string, operation: () => Promise<T>): Promise<T>;
  transition(
    actionId: string,
    nextState: ActionState,
    transitionedAt: PendingAction["updatedAt"],
  ): PendingActionRecord;
  acceptConfirmation(actionId: string, confirmationId: string): PendingActionRecord;
  authorize(
    actionId: string,
    authorization: ExecutionAuthorization,
    transitionedAt: PendingAction["updatedAt"],
  ): PendingActionRecord;
}

function cloneRecord(record: PendingActionRecord): PendingActionRecord {
  return Object.freeze({
    ...record,
    action: record.action,
    originalContext: record.originalContext,
    authorization: record.authorization,
  });
}

export class InMemoryPendingActionRepository implements PendingActionRepository {
  readonly #records = new Map<string, PendingActionRecord>();
  readonly #queues = new Map<string, Promise<void>>();

  create(record: PendingActionRecord): void {
    if (this.#records.has(record.action.actionId)) {
      throw new ActionLifecycleError(
        "INVALID_COMMAND",
        "Duplicate actionId",
        record.action.actionId,
      );
    }
    this.#records.set(record.action.actionId, cloneRecord(record));
  }

  get(actionId: string): PendingActionRecord | undefined {
    const record = this.#records.get(actionId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  async runExclusive<T>(actionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(actionId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.#queues.set(actionId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(actionId) === queued) this.#queues.delete(actionId);
    }
  }

  transition(
    actionId: string,
    nextState: ActionState,
    transitionedAt: PendingAction["updatedAt"],
  ): PendingActionRecord {
    const record = this.#require(actionId);
    const updated = cloneRecord({
      ...record,
      action: transitionPendingAction(record.action, nextState, transitionedAt),
    });
    this.#records.set(actionId, updated);
    return cloneRecord(updated);
  }

  acceptConfirmation(actionId: string, confirmationId: string): PendingActionRecord {
    const record = this.#require(actionId);
    const updated = cloneRecord({ ...record, tokenHash: null, confirmationId });
    this.#records.set(actionId, updated);
    return cloneRecord(updated);
  }

  authorize(
    actionId: string,
    authorization: ExecutionAuthorization,
    transitionedAt: PendingAction["updatedAt"],
  ): PendingActionRecord {
    const record = this.#require(actionId);
    if (record.authorization !== null) {
      throw new ActionLifecycleError(
        "AUTHORIZATION_ALREADY_ISSUED",
        "Action already has an ExecutionAuthorization",
        actionId,
        record.action.state,
      );
    }
    const updated = cloneRecord({
      ...record,
      action: transitionPendingAction(record.action, "READY_FOR_EXECUTION", transitionedAt),
      authorization,
    });
    this.#records.set(actionId, updated);
    return cloneRecord(updated);
  }

  #require(actionId: string): PendingActionRecord {
    const record = this.#records.get(actionId);
    if (record === undefined) {
      throw new ActionLifecycleError("ACTION_NOT_FOUND", "PendingAction was not found", actionId);
    }
    return record;
  }
}
