import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { canonicalSerialize, createActionFingerprint } from "@driveguard/action-lifecycle";
import { toUtcTimestamp, timestampToEpochMs } from "@driveguard/domain";
import {
  consumePolicyDecisionForExecution,
  isPolicyDecisionIssuedFor,
  isPolicyDecisionIssuedForExecution,
  type PolicyExecutionBinding,
} from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import {
  FORBIDDEN_TOOL_NAMES,
  FORMAL_TOOL_NAMES,
  type ToolDefinition,
  type ToolRegistry,
} from "@driveguard/tools";
import Schema from "typebox/schema";

import { CircuitBreaker } from "./circuit-breaker.js";
import type { DurableExecutionCoordinator } from "./durable.js";
import {
  authorizationErrorCode,
  classifyToolError,
  ExecutorFault,
  safeExecutionError,
} from "./errors.js";
import {
  InMemoryExecutionEventSink,
  type ExecutionEvent,
  type ExecutionEventSink,
  type ExecutionEventType,
} from "./events.js";
import { IdempotencyManager } from "./idempotency.js";
import { ExecutionRecordStore } from "./lifecycle.js";
import { RetryPolicy, SystemSleeper, type Sleeper } from "./retry.js";
import { AbortTimeoutController, type TimeoutController } from "./timeout.js";
import type {
  ExecutionAuthorizationConsumer,
  ExecutionErrorCode,
  ExecutionRequest,
  ExecutionResult,
  ExecutionState,
  SafeExecutionError,
} from "./types.js";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const formalNames = new Set<string>(FORMAL_TOOL_NAMES);
const forbiddenNames = new Set<string>(FORBIDDEN_TOOL_NAMES);

export interface ReliableToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly authorizationConsumer: ExecutionAuthorizationConsumer;
  readonly clock: Clock;
  readonly retryPolicy?: RetryPolicy;
  readonly sleeper?: Sleeper;
  readonly timeoutController?: TimeoutController;
  readonly idempotencyManager?: IdempotencyManager;
  readonly circuitBreaker?: CircuitBreaker;
  readonly eventSink?: ExecutionEventSink;
  readonly records?: ExecutionRecordStore;
  readonly durableCoordinator?: DurableExecutionCoordinator;
}

function safeIdentity(value: unknown, fallback: string): string {
  return typeof value === "string" && safeId.test(value) ? value : fallback;
}

function cloneResult(value: unknown): unknown {
  return structuredClone(value);
}

export class ReliableToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #authorizationConsumer: ExecutionAuthorizationConsumer;
  readonly #clock: Clock;
  readonly #retryPolicy: RetryPolicy;
  readonly #sleeper: Sleeper;
  readonly #timeoutController: TimeoutController;
  readonly #idempotency: IdempotencyManager;
  readonly #circuitBreaker: CircuitBreaker;
  readonly #eventSink: ExecutionEventSink;
  readonly #records: ExecutionRecordStore;
  readonly #durableCoordinator: DurableExecutionCoordinator | undefined;
  readonly #durableOwnerContext = new AsyncLocalStorage<boolean>();

  constructor(options: ReliableToolExecutorOptions) {
    this.#registry = options.registry;
    this.#authorizationConsumer = options.authorizationConsumer;
    this.#clock = options.clock;
    this.#retryPolicy = options.retryPolicy ?? new RetryPolicy();
    this.#sleeper = options.sleeper ?? new SystemSleeper();
    this.#timeoutController = options.timeoutController ?? new AbortTimeoutController();
    this.#idempotency = options.idempotencyManager ?? new IdempotencyManager();
    this.#circuitBreaker = options.circuitBreaker ?? new CircuitBreaker({ clock: options.clock });
    this.#eventSink = options.eventSink ?? new InMemoryExecutionEventSink();
    this.#records = options.records ?? new ExecutionRecordStore();
    this.#durableCoordinator = options.durableCoordinator;
  }

  record(executionId: string) {
    return this.#records.get(executionId);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const fallbackAt = toUtcTimestamp(this.#clock.nowMs());
    let definition: ToolDefinition;
    let requestBinding: string;
    try {
      definition = this.#validate(request);
      requestBinding = this.#requestBinding(request);
    } catch (error) {
      const code = error instanceof ExecutorFault ? error.code : "EXECUTION_VALIDATION_ERROR";
      const rawRequest = typeof request === "object" && request !== null ? request : {};
      return Object.freeze({
        executionId: safeIdentity(Reflect.get(rawRequest, "executionId"), "invalid-execution"),
        toolName: safeIdentity(Reflect.get(rawRequest, "toolName"), "unknown-tool"),
        status: "REJECTED",
        attemptCount: 0,
        deduplicated: false,
        startedAt: fallbackAt,
        completedAt: fallbackAt,
        error: safeExecutionError(code),
      });
    }

    if (this.#durableCoordinator !== undefined && this.#durableOwnerContext.getStore() !== true) {
      return this.#durableCoordinator.execute(request, requestBinding, async () =>
        this.#durableOwnerContext.run(true, async () => {
          const result = await this.execute(request);
          const record = this.#records.get(request.executionId);
          if (record === undefined) {
            throw new ExecutorFault(
              "INTERNAL_EXECUTION_ERROR",
              "Durable execution owner did not produce an ExecutionRecord",
            );
          }
          return { result, record };
        }),
      );
    }

    const acquisition = this.#idempotency.acquire(
      request.idempotencyKey,
      request.actionFingerprint,
      requestBinding,
    );
    if (acquisition.kind === "CONFLICT") {
      const existingRecord = this.#records.get(request.executionId);
      if (existingRecord === undefined) {
        this.#records.create(request, fallbackAt);
        return this.#reject(request, "IDEMPOTENCY_CONFLICT");
      }
      // A conflicting replay must never mutate the legitimate owner record.
      return this.#rejectionResult(
        request,
        "IDEMPOTENCY_CONFLICT",
        existingRecord.createdAt,
        fallbackAt,
      );
    }
    if (acquisition.kind === "DUPLICATE") {
      const existingRecord = this.#records.get(request.executionId);
      const createdDuplicateRecord = existingRecord === undefined;
      const duplicateRecord = createdDuplicateRecord
        ? this.#records.create(request, fallbackAt)
        : existingRecord;
      const original = await acquisition.result;
      const completedAt = toUtcTimestamp(this.#clock.nowMs());
      try {
        await this.#emit("execution.deduplicated", request, 0);
      } catch {
        if (createdDuplicateRecord) {
          this.#transitionDuplicate(request.executionId, "FAILED", completedAt);
        }
        if (!createdDuplicateRecord) {
          return Object.freeze({
            ...original,
            deduplicated: true,
            ...(original.result === undefined ? {} : { result: cloneResult(original.result) }),
          });
        }
        return Object.freeze({
          executionId: request.executionId,
          toolName: request.toolName,
          status: "FAILED",
          attemptCount: 0,
          deduplicated: true,
          startedAt: duplicateRecord.createdAt,
          completedAt,
          error: safeExecutionError("INTERNAL_EXECUTION_ERROR"),
        });
      }
      if (createdDuplicateRecord) {
        this.#transitionDuplicate(request.executionId, original.status, completedAt);
      }
      if (!createdDuplicateRecord) {
        return Object.freeze({
          ...original,
          deduplicated: true,
          ...(original.result === undefined ? {} : { result: cloneResult(original.result) }),
        });
      }
      return Object.freeze({
        executionId: request.executionId,
        toolName: request.toolName,
        status:
          original.status === "CREATED" || original.status === "RUNNING"
            ? "FAILED"
            : original.status,
        attemptCount: 0,
        deduplicated: true,
        startedAt: duplicateRecord.createdAt,
        completedAt,
        ...(original.result === undefined ? {} : { result: cloneResult(original.result) }),
        ...(original.error === undefined ? {} : { error: original.error }),
      });
    }

    try {
      this.#records.create(request, fallbackAt);
    } catch {
      const rejected = this.#validationFailure(request, fallbackAt);
      acquisition.complete(rejected);
      return rejected;
    }

    let result: ExecutionResult;
    try {
      result = await this.#executeOwner(request, definition);
    } catch {
      result = this.#finish(request, "FAILED", 0, safeExecutionError("INTERNAL_EXECUTION_ERROR"));
    }
    acquisition.complete(result);
    return result;
  }

  #validationFailure(
    request: ExecutionRequest,
    at: ExecutionResult["completedAt"],
  ): ExecutionResult {
    return Object.freeze({
      executionId: request.executionId,
      toolName: request.toolName,
      status: "REJECTED",
      attemptCount: 0,
      deduplicated: false,
      startedAt: at,
      completedAt: at,
      error: safeExecutionError("EXECUTION_VALIDATION_ERROR"),
    });
  }

  #validate(request: ExecutionRequest): ToolDefinition {
    if (typeof request !== "object" || request === null) {
      throw new ExecutorFault("EXECUTION_VALIDATION_ERROR", "Execution request must be an object");
    }
    for (const value of [
      request.executionId,
      request.toolName,
      request.runId,
      request.sessionId,
      request.userId,
      request.vehicleId,
      request.traceId,
      request.idempotencyKey,
    ]) {
      if (typeof value !== "string" || !safeId.test(value)) {
        throw new ExecutorFault("EXECUTION_VALIDATION_ERROR", "Execution identity is invalid");
      }
    }
    if (!fingerprintPattern.test(request.actionFingerprint)) {
      throw new ExecutorFault("EXECUTION_VALIDATION_ERROR", "Action fingerprint is invalid");
    }
    timestampToEpochMs(request.createdAt, "execution.createdAt");
    if (!formalNames.has(request.toolName) || forbiddenNames.has(request.toolName)) {
      throw new ExecutorFault("EXECUTION_VALIDATION_ERROR", "Tool is not executable");
    }
    const definition = this.#registry.get(request.toolName);
    if (
      definition === undefined ||
      definition.name !== request.toolName ||
      definition.riskLevel !== request.riskLevel
    ) {
      throw new ExecutorFault("EXECUTION_VALIDATION_ERROR", "Tool definition does not match");
    }
    try {
      if (!Schema.Compile(definition.inputSchema).Check(request.validatedArguments)) {
        throw new ExecutorFault("EXECUTION_VALIDATION_ERROR", "Tool arguments are invalid");
      }
      structuredClone(request.validatedArguments);
    } catch (error) {
      if (error instanceof ExecutorFault) throw error;
      throw new ExecutorFault("EXECUTION_VALIDATION_ERROR", "Tool arguments are invalid");
    }
    if (
      request.policyDecision.toolName !== request.toolName ||
      request.policyDecision.riskLevel !== request.riskLevel
    ) {
      throw new ExecutorFault("EXECUTION_NOT_AUTHORIZED", "Policy binding does not match");
    }
    if (
      (request.riskLevel === "R0" || request.riskLevel === "R1") &&
      (request.contextSnapshotId === undefined ||
        request.contextVersion === undefined ||
        createActionFingerprint({
          toolName: request.toolName,
          validatedArguments: request.validatedArguments,
          sessionId: request.sessionId,
          userId: request.userId,
          vehicleId: request.vehicleId,
          contextSnapshotId: request.contextSnapshotId,
          contextVersion: request.contextVersion,
        }) !== request.actionFingerprint)
    ) {
      throw new ExecutorFault(
        "EXECUTION_NOT_AUTHORIZED",
        "Execution subject does not match the action fingerprint",
      );
    }
    if (
      (request.riskLevel === "R0" || request.riskLevel === "R1") &&
      (!isPolicyDecisionIssuedFor(request.policyDecision, definition, request.validatedArguments) ||
        !isPolicyDecisionIssuedForExecution(
          request.policyDecision,
          definition,
          request.validatedArguments,
          this.#policyExecutionBinding(request),
        ))
    ) {
      throw new ExecutorFault("EXECUTION_NOT_AUTHORIZED", "Policy execution binding is invalid");
    }
    return definition;
  }

  #policyExecutionBinding(request: ExecutionRequest): PolicyExecutionBinding {
    if (
      request.contextSnapshotId === undefined ||
      request.contextVersion === undefined ||
      !safeId.test(request.contextSnapshotId) ||
      !Number.isSafeInteger(request.contextVersion) ||
      request.contextVersion < 1
    ) {
      throw new ExecutorFault("EXECUTION_NOT_AUTHORIZED", "Policy Context binding is invalid");
    }
    return {
      runId: request.runId,
      sessionId: request.sessionId,
      traceId: request.traceId,
      actionFingerprint: request.actionFingerprint,
      contextSnapshotId: request.contextSnapshotId,
      contextVersion: request.contextVersion,
    };
  }

  #requestBinding(request: ExecutionRequest): string {
    const canonical = canonicalSerialize({
      toolName: request.toolName,
      validatedArguments: request.validatedArguments,
      actionFingerprint: request.actionFingerprint,
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      vehicleId: request.vehicleId,
      traceId: request.traceId,
      riskLevel: request.riskLevel,
      policyDecision: request.policyDecision,
      actionId: request.actionId ?? null,
      authorizationId: request.authorizationId ?? null,
      contextSnapshotId: request.contextSnapshotId ?? null,
      contextVersion: request.contextVersion ?? null,
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  }

  async #executeOwner(
    request: ExecutionRequest,
    definition: ToolDefinition,
  ): Promise<ExecutionResult> {
    if (request.riskLevel === "R0" || request.riskLevel === "R1") {
      if (
        request.policyDecision.decision !== "ALLOW" ||
        !consumePolicyDecisionForExecution(
          request.policyDecision,
          definition,
          request.validatedArguments,
          this.#policyExecutionBinding(request),
        )
      ) {
        return this.#reject(request, "EXECUTION_NOT_AUTHORIZED");
      }
    } else {
      if (
        request.policyDecision.decision !== "REQUIRE_CONFIRMATION" ||
        request.actionId === undefined ||
        request.authorizationId === undefined ||
        request.contextSnapshotId === undefined ||
        request.contextVersion === undefined
      ) {
        return this.#reject(request, "EXECUTION_NOT_AUTHORIZED");
      }
      try {
        await this.#authorizationConsumer.consumeExecutionAuthorization({
          authorizationId: request.authorizationId,
          actionId: request.actionId,
          actionFingerprint: request.actionFingerprint,
          toolName: definition.name as (typeof FORMAL_TOOL_NAMES)[number],
          sessionId: request.sessionId,
          userId: request.userId,
          vehicleId: request.vehicleId,
          contextSnapshotId: request.contextSnapshotId,
          contextVersion: request.contextVersion,
          validatedArguments: request.validatedArguments,
        });
      } catch (error) {
        return this.#reject(request, authorizationErrorCode(error));
      }
      try {
        await this.#emit("authorization.consumed", request, 0);
      } catch {
        return this.#reject(request, "INTERNAL_EXECUTION_ERROR");
      }
    }

    this.#records.transition(request.executionId, "RUNNING", toUtcTimestamp(this.#clock.nowMs()));
    try {
      await this.#emit("execution.started", request, 0);
    } catch {
      return this.#finish(request, "FAILED", 0, safeExecutionError("INTERNAL_EXECUTION_ERROR"));
    }
    const circuitKey = [...definition.requiredServices].sort().join("+") || definition.name;
    const retrySafe =
      !definition.sideEffect ||
      definition.idempotencyHint === "READ_ONLY" ||
      definition.idempotencyHint === "IDEMPOTENT";

    for (let attempt = 1; attempt <= this.#retryPolicy.maxAttempts; attempt += 1) {
      const permit = this.#circuitBreaker.acquire(circuitKey);
      if (!permit.allowed) {
        return this.#finish(request, "FAILED", attempt - 1, safeExecutionError("CIRCUIT_OPEN"));
      }
      if (permit.state === "HALF_OPEN") {
        try {
          await this.#emit("circuit.half_open", request, attempt);
        } catch {
          this.#circuitBreaker.failed(circuitKey);
          return this.#finish(
            request,
            "FAILED",
            attempt - 1,
            safeExecutionError("INTERNAL_EXECUTION_ERROR"),
          );
        }
      }
      const attemptStartedAt = toUtcTimestamp(this.#clock.nowMs());
      try {
        await this.#emit("execution.attempt.started", request, attempt);
      } catch {
        if (permit.state === "HALF_OPEN") this.#circuitBreaker.failed(circuitKey);
        return this.#finish(
          request,
          "FAILED",
          attempt - 1,
          safeExecutionError("INTERNAL_EXECUTION_ERROR"),
        );
      }
      try {
        const value = await this.#timeoutController.run(definition.timeoutHintMs, (signal) =>
          definition.execute(request.validatedArguments, {
            signal,
            attempt,
            idempotencyKey: request.idempotencyKey,
          }),
        );
        const attemptCompletedAt = toUtcTimestamp(this.#clock.nowMs());
        this.#records.addAttempt(request.executionId, {
          attempt,
          startedAt: attemptStartedAt,
          completedAt: attemptCompletedAt,
          outcome: "SUCCEEDED",
        });
        const circuit = this.#circuitBreaker.succeeded(circuitKey);
        if (circuit.previous !== "CLOSED") {
          try {
            await this.#emit("circuit.closed", request, attempt);
          } catch {
            return this.#finishAfterSuccessfulEffectEventFailure(request, definition, attempt);
          }
        }
        try {
          await this.#emit("execution.succeeded", request, attempt);
        } catch {
          return this.#finishAfterSuccessfulEffectEventFailure(request, definition, attempt);
        }
        return this.#finish(request, "SUCCEEDED", attempt, undefined, cloneResult(value));
      } catch (error) {
        const classified = classifyToolError(error, definition.sideEffect, retrySafe);
        const attemptCompletedAt = toUtcTimestamp(this.#clock.nowMs());
        this.#records.addAttempt(request.executionId, {
          attempt,
          startedAt: attemptStartedAt,
          completedAt: attemptCompletedAt,
          outcome: classified.code === "DEPENDENCY_TIMEOUT" ? "TIMED_OUT" : "FAILED",
          errorCode: classified.code,
        });
        let circuitOpened = false;
        let circuitClosed = false;
        if (classified.classification !== "NON_RETRYABLE") {
          const circuit = this.#circuitBreaker.failed(circuitKey);
          circuitOpened = circuit.previous !== "OPEN" && circuit.current === "OPEN";
        } else if (permit.state === "HALF_OPEN") {
          // A definitive dependency response proves reachability and releases the probe.
          const circuit = this.#circuitBreaker.succeeded(circuitKey);
          circuitClosed = circuit.previous !== "CLOSED";
        }
        try {
          await this.#emit("execution.attempt.failed", request, attempt, classified.code);
        } catch {
          return this.#finishAfterFailedAttemptEventFailure(
            request,
            classified.classification,
            attempt,
          );
        }
        if (circuitOpened) {
          try {
            await this.#emit("circuit.opened", request, attempt);
          } catch {
            return this.#finishAfterFailedAttemptEventFailure(
              request,
              classified.classification,
              attempt,
            );
          }
        }
        if (circuitClosed) {
          try {
            await this.#emit("circuit.closed", request, attempt);
          } catch {
            return this.#finish(request, "FAILED", attempt, safeExecutionError(classified.code));
          }
        }
        if (classified.classification === "AMBIGUOUS_SIDE_EFFECT") {
          try {
            await this.#emit("execution.outcome_unknown", request, attempt, classified.code);
          } catch {
            // Preserve the conservative Tool outcome even when audit delivery fails.
          }
          return this.#finish(
            request,
            "OUTCOME_UNKNOWN",
            attempt,
            safeExecutionError("OUTCOME_UNKNOWN"),
          );
        }
        if (!this.#retryPolicy.shouldRetry(classified.classification, attempt)) {
          const exhausted = classified.classification === "RETRYABLE";
          const status = exhausted ? "RETRY_EXHAUSTED" : "FAILED";
          const safeError = safeExecutionError(exhausted ? "RETRY_EXHAUSTED" : classified.code);
          try {
            await this.#emit("execution.failed", request, attempt, safeError.code);
          } catch {
            // Preserve the already known Tool failure while failing audit delivery closed.
          }
          return this.#finish(request, status, attempt, safeError);
        }
        const delayMs = this.#retryPolicy.delayForRetry(attempt);
        try {
          await this.#emit("execution.retry.scheduled", request, attempt, classified.code, delayMs);
          await this.#sleeper.sleep(delayMs);
        } catch {
          return this.#finish(
            request,
            "FAILED",
            attempt,
            safeExecutionError("INTERNAL_EXECUTION_ERROR"),
          );
        }
      }
    }
    return this.#finish(
      request,
      "RETRY_EXHAUSTED",
      this.#retryPolicy.maxAttempts,
      safeExecutionError("RETRY_EXHAUSTED"),
    );
  }

  #reject(request: ExecutionRequest, code: ExecutionErrorCode): ExecutionResult {
    const at = toUtcTimestamp(this.#clock.nowMs());
    const record = this.#records.get(request.executionId);
    if (record?.state === "CREATED") this.#records.transition(request.executionId, "REJECTED", at);
    return this.#rejectionResult(request, code, record?.createdAt ?? at, at);
  }

  #rejectionResult(
    request: ExecutionRequest,
    code: ExecutionErrorCode,
    startedAt: ExecutionResult["startedAt"],
    completedAt: ExecutionResult["completedAt"],
  ): ExecutionResult {
    return Object.freeze({
      executionId: request.executionId,
      toolName: request.toolName,
      status: "REJECTED",
      attemptCount: 0,
      deduplicated: false,
      startedAt,
      completedAt,
      error: safeExecutionError(code),
    });
  }

  #finishAfterSuccessfulEffectEventFailure(
    request: ExecutionRequest,
    definition: ToolDefinition,
    attempt: number,
  ): ExecutionResult {
    const status = definition.sideEffect ? "OUTCOME_UNKNOWN" : "FAILED";
    return this.#finish(
      request,
      status,
      attempt,
      safeExecutionError(definition.sideEffect ? "OUTCOME_UNKNOWN" : "INTERNAL_EXECUTION_ERROR"),
    );
  }

  #finishAfterFailedAttemptEventFailure(
    request: ExecutionRequest,
    classification: "RETRYABLE" | "NON_RETRYABLE" | "AMBIGUOUS_SIDE_EFFECT",
    attempt: number,
  ): ExecutionResult {
    if (classification === "AMBIGUOUS_SIDE_EFFECT") {
      return this.#finish(
        request,
        "OUTCOME_UNKNOWN",
        attempt,
        safeExecutionError("OUTCOME_UNKNOWN"),
      );
    }
    return this.#finish(request, "FAILED", attempt, safeExecutionError("INTERNAL_EXECUTION_ERROR"));
  }

  #finish(
    request: ExecutionRequest,
    status: Exclude<ExecutionState, "CREATED" | "RUNNING" | "REJECTED">,
    attemptCount: number,
    error?: SafeExecutionError,
    result?: unknown,
  ): ExecutionResult {
    const at = toUtcTimestamp(this.#clock.nowMs());
    const record = this.#records.get(request.executionId);
    if (record?.state === "RUNNING") this.#records.transition(request.executionId, status, at);
    return Object.freeze({
      executionId: request.executionId,
      toolName: request.toolName,
      status,
      attemptCount,
      deduplicated: false,
      startedAt: record?.createdAt ?? at,
      completedAt: at,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    });
  }

  #transitionDuplicate(
    executionId: string,
    status: ExecutionState,
    at: ExecutionResult["completedAt"],
  ): void {
    const record = this.#records.get(executionId);
    if (record?.state !== "CREATED") return;
    if (status === "REJECTED") {
      this.#records.transition(executionId, "REJECTED", at);
      return;
    }
    this.#records.transition(executionId, "RUNNING", at);
    this.#records.transition(
      executionId,
      status === "CREATED" || status === "RUNNING" ? "FAILED" : status,
      at,
    );
  }

  async #emit(
    eventType: ExecutionEventType,
    request: ExecutionRequest,
    attempt: number,
    errorCode?: string,
    delayMs?: number,
  ): Promise<void> {
    const event = Object.freeze({
      eventType,
      executionId: request.executionId,
      runId: request.runId,
      sessionId: request.sessionId,
      traceId: request.traceId,
      ...(request.actionId === undefined ? {} : { actionId: request.actionId }),
      toolName: request.toolName,
      attempt,
      timestamp: toUtcTimestamp(this.#clock.nowMs()),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(delayMs === undefined ? {} : { delayMs }),
    }) as ExecutionEvent;
    try {
      await this.#eventSink.emit(event);
    } catch {
      throw new ExecutorFault("INTERNAL_EXECUTION_ERROR", "Execution event delivery failed");
    }
  }
}
