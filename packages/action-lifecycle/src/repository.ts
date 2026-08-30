import type { ContextSnapshot } from "@driveguard/domain";

import { ActionLifecycleError } from "./errors.js";
import { assertPendingActionRecordIntegrity } from "./integrity.js";
import { transitionPendingAction } from "./state-machine.js";
import type { ActionState, ExecutionAuthorization, PendingAction } from "./types.js";

export interface PendingActionRecord {
  readonly action: PendingAction;
  readonly originalContext: ContextSnapshot;
  readonly tokenHash: string | null;
  readonly confirmationId: string | null;
  readonly authorization: ExecutionAuthorization | null;
  readonly authorizationConsumedAt?: PendingAction["updatedAt"] | null;
}

export interface PendingActionRepository {
  create(record: PendingActionRecord): Promise<void>;
  get(actionId: string): Promise<PendingActionRecord | undefined>;
  runExclusive<T>(actionId: string, operation: () => Promise<T>): Promise<T>;
  transition(
    actionId: string,
    nextState: ActionState,
    transitionedAt: PendingAction["updatedAt"],
  ): Promise<PendingActionRecord>;
  acceptConfirmation(
    actionId: string,
    confirmationId: string,
    transitionedAt: PendingAction["updatedAt"],
  ): Promise<PendingActionRecord>;
  authorize(
    actionId: string,
    authorization: ExecutionAuthorization,
    transitionedAt: PendingAction["updatedAt"],
  ): Promise<PendingActionRecord>;
  consumeAuthorization(
    actionId: string,
    consumedAt: PendingAction["updatedAt"],
  ): Promise<PendingActionRecord>;
}

function cloneRecord(record: PendingActionRecord): PendingActionRecord {
  assertPendingActionRecordIntegrity(record);
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

  async create(record: PendingActionRecord): Promise<void> {
    await Promise.resolve();
    if (this.#records.has(record.action.actionId)) {
      throw new ActionLifecycleError(
        "INVALID_COMMAND",
        "Duplicate actionId",
        record.action.actionId,
      );
    }
    this.#records.set(record.action.actionId, cloneRecord(record));
  }

  async get(actionId: string): Promise<PendingActionRecord | undefined> {
    await Promise.resolve();
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

  async transition(
    actionId: string,
    nextState: ActionState,
    transitionedAt: PendingAction["updatedAt"],
  ): Promise<PendingActionRecord> {
    await Promise.resolve();
    const record = this.#require(actionId);
    const updated = cloneRecord({
      ...record,
      action: transitionPendingAction(record.action, nextState, transitionedAt),
    });
    this.#records.set(actionId, updated);
    return cloneRecord(updated);
  }

  async acceptConfirmation(
    actionId: string,
    confirmationId: string,
    transitionedAt: PendingAction["updatedAt"],
  ): Promise<PendingActionRecord> {
    await Promise.resolve();
    const record = this.#require(actionId);
    const updated = cloneRecord({
      ...record,
      action: transitionPendingAction(record.action, "CONFIRMED", transitionedAt),
      tokenHash: null,
      confirmationId,
    });
    this.#records.set(actionId, updated);
    return cloneRecord(updated);
  }

  async authorize(
    actionId: string,
    authorization: ExecutionAuthorization,
    transitionedAt: PendingAction["updatedAt"],
  ): Promise<PendingActionRecord> {
    await Promise.resolve();
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

  async consumeAuthorization(
    actionId: string,
    consumedAt: PendingAction["updatedAt"],
  ): Promise<PendingActionRecord> {
    await Promise.resolve();
    const record = this.#require(actionId);
    if (record.authorizationConsumedAt != null) {
      throw new ActionLifecycleError(
        "AUTHORIZATION_ALREADY_USED",
        "ExecutionAuthorization was already consumed",
        actionId,
        record.action.state,
      );
    }
    const updated = cloneRecord({ ...record, authorizationConsumedAt: consumedAt });
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
