import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { toUtcTimestamp, timestampToEpochMs } from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";
import { FORMAL_TOOL_NAMES } from "@driveguard/tools";
import Schema from "typebox/schema";
import { isPolicyDecisionIssuedFor } from "@driveguard/policy";

import { createActionFingerprint } from "./canonical.js";
import { verifyExecutionAuthorizationForConsumption } from "./authorization-consumption.js";
import { ActionLifecycleError } from "./errors.js";
import {
  InMemoryActionLifecycleEventSink,
  type ActionLifecycleEvent,
  type ActionLifecycleEventSink,
  type ActionLifecycleEventType,
} from "./events.js";
import { assertPendingActionIntegrity } from "./integrity.js";
import { InMemoryPendingActionRepository, type PendingActionRecord } from "./repository.js";
import type { ContextRevalidator } from "./revalidator.js";
import { createConfirmationSummary } from "./summary.js";
import type {
  ActionRevalidationResult,
  BoundActionCommand,
  ConfirmActionCommand,
  ConsumeExecutionAuthorizationCommand,
  CreatePendingActionCommand,
  ExecutionAuthorization,
  PendingAction,
  SafeConfirmationRequiredResult,
  TrustedConfirmationChallenge,
} from "./types.js";

export const DEFAULT_CONFIRMATION_TTL_MS = 60_000;
export const DEFAULT_EXECUTION_AUTHORIZATION_TTL_MS = 10_000;

export interface ConfirmationServiceOptions {
  readonly clock: Clock;
  readonly revalidator: ContextRevalidator;
  readonly isTrustedDefinition: (definition: CreatePendingActionCommand["definition"]) => boolean;
  readonly eventSink?: ActionLifecycleEventSink;
  readonly actionIdFactory?: () => string;
  readonly confirmationIdFactory?: () => string;
  readonly authorizationIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly tokenGenerator?: () => string;
  readonly confirmationTtlMs?: number;
  readonly authorizationTtlMs?: number;
}

export interface PendingActionCreation {
  readonly action: PendingAction;
  readonly trustedChallenge: TrustedConfirmationChallenge;
  readonly safeResult: SafeConfirmationRequiredResult;
}

export interface ConfirmationOutcome {
  readonly action: PendingAction;
  readonly authorization: ExecutionAuthorization | null;
  readonly revalidation: ActionRevalidationResult;
}

const formalNames = new Set<string>(FORMAL_TOOL_NAMES);
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    throw new ActionLifecycleError("INVALID_COMMAND", "Action data must be cloneable");
  }
}

function positiveTtl(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new ActionLifecycleError("INVALID_COMMAND", `${name} is invalid`);
  }
  return value;
}

function generatedId(factory: () => string, name: string): string {
  let value: unknown;
  try {
    value = factory();
  } catch {
    throw new ActionLifecycleError("INTERNAL_ERROR", `${name} generation failed safely`);
  }
  if (typeof value !== "string" || !safeIdPattern.test(value)) {
    throw new ActionLifecycleError("INTERNAL_ERROR", `${name} generation failed safely`);
  }
  return value;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function generatedToken(factory: () => string): string {
  let token: unknown;
  try {
    token = factory();
  } catch {
    throw new ActionLifecycleError("INTERNAL_ERROR", "Confirmation token generation failed safely");
  }
  if (typeof token !== "string" || token.length < 8 || token.length > 1_024) {
    throw new ActionLifecycleError("INTERNAL_ERROR", "Confirmation token generation failed safely");
  }
  return token;
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requireBoundCommand(command: BoundActionCommand): void {
  for (const [name, value] of Object.entries({
    actionId: command.actionId,
    sessionId: command.sessionId,
    userId: command.userId,
  })) {
    if (typeof value !== "string" || !safeIdPattern.test(value)) {
      throw new ActionLifecycleError("INVALID_COMMAND", `${name} is invalid`);
    }
  }
}

function terminalRevalidation(
  reason: ActionRevalidationResult["reason"],
): ActionRevalidationResult {
  return Object.freeze({
    status: "REPLAN_REQUIRED",
    reason,
    currentContext: null,
    freshness: null,
    conflict: null,
  });
}

export class ConfirmationService {
  readonly #clock: Clock;
  readonly #revalidator: ContextRevalidator;
  readonly #isTrustedDefinition: ConfirmationServiceOptions["isTrustedDefinition"];
  readonly #repository: InMemoryPendingActionRepository;
  readonly #eventSink: ActionLifecycleEventSink;
  readonly #actionIdFactory: () => string;
  readonly #confirmationIdFactory: () => string;
  readonly #authorizationIdFactory: () => string;
  readonly #eventIdFactory: () => string;
  readonly #tokenGenerator: () => string;
  readonly #confirmationTtlMs: number;
  readonly #authorizationTtlMs: number;

  constructor(options: ConfirmationServiceOptions) {
    this.#clock = options.clock;
    this.#revalidator = options.revalidator;
    this.#isTrustedDefinition = options.isTrustedDefinition;
    this.#repository = new InMemoryPendingActionRepository();
    this.#eventSink = options.eventSink ?? new InMemoryActionLifecycleEventSink();
    this.#actionIdFactory = options.actionIdFactory ?? (() => `action:${randomUUID()}`);
    this.#confirmationIdFactory =
      options.confirmationIdFactory ?? (() => `confirmation:${randomUUID()}`);
    this.#authorizationIdFactory =
      options.authorizationIdFactory ?? (() => `authorization:${randomUUID()}`);
    this.#eventIdFactory = options.eventIdFactory ?? (() => `action-event:${randomUUID()}`);
    this.#tokenGenerator = options.tokenGenerator ?? (() => randomBytes(32).toString("base64url"));
    this.#confirmationTtlMs = positiveTtl(
      options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS,
      "confirmationTtlMs",
    );
    this.#authorizationTtlMs = positiveTtl(
      options.authorizationTtlMs ?? DEFAULT_EXECUTION_AUTHORIZATION_TTL_MS,
      "authorizationTtlMs",
    );
  }

  async create(command: CreatePendingActionCommand): Promise<PendingActionCreation> {
    const definition = command.definition;
    const trustedDefinition = (() => {
      try {
        return this.#isTrustedDefinition(definition);
      } catch {
        return false;
      }
    })();
    if (
      command.policyDecision.decision !== "REQUIRE_CONFIRMATION" ||
      !isPolicyDecisionIssuedFor(command.policyDecision, definition, command.validatedArguments) ||
      !trustedDefinition ||
      command.policyDecision.toolName !== definition.name ||
      command.policyDecision.riskLevel !== definition.riskLevel ||
      command.policyDecision.contextSnapshotId !== command.contextSnapshot.snapshotId ||
      command.policyDecision.contextVersion !== command.contextSnapshot.contextVersion ||
      !formalNames.has(definition.name) ||
      (definition.riskLevel !== "R2" && definition.riskLevel !== "R3")
    ) {
      throw new ActionLifecycleError(
        "INVALID_COMMAND",
        "Only a bound REQUIRE_CONFIRMATION decision can create a PendingAction",
      );
    }
    for (const [name, value] of Object.entries({
      runId: command.runId,
      sessionId: command.sessionId,
      traceId: command.traceId,
      userId: command.userId,
      vehicleId: command.vehicleId,
    })) {
      if (typeof value !== "string" || !safeIdPattern.test(value)) {
        throw new ActionLifecycleError("INVALID_COMMAND", `${name} is invalid`);
      }
    }
    const originalContext = cloneAndFreeze(command.contextSnapshot);
    if (
      command.userId !== originalContext.user.userId ||
      command.vehicleId !== originalContext.vehicle.vehicleId
    ) {
      throw new ActionLifecycleError(
        "INVALID_COMMAND",
        "Action identity must match the bound Context snapshot",
      );
    }
    const nowMs = this.#clock.nowMs();
    const createdAt = toUtcTimestamp(nowMs);
    const expiresAt = toUtcTimestamp(nowMs + this.#confirmationTtlMs);
    const actionId = generatedId(this.#actionIdFactory, "actionId");
    const validatedArguments = cloneAndFreeze(command.validatedArguments);
    try {
      if (!Schema.Compile(definition.inputSchema).Check(validatedArguments)) {
        throw new ActionLifecycleError(
          "INVALID_COMMAND",
          "PendingAction arguments failed the Tool Contract",
        );
      }
    } catch (error) {
      if (error instanceof ActionLifecycleError) throw error;
      throw new ActionLifecycleError("INVALID_COMMAND", "Tool Contract could not be validated");
    }
    const confirmationSummary = createConfirmationSummary(definition, validatedArguments);
    const actionFingerprint = createActionFingerprint({
      toolName: definition.name,
      validatedArguments,
      sessionId: command.sessionId,
      userId: command.userId,
      vehicleId: command.vehicleId,
      contextSnapshotId: originalContext.snapshotId,
      contextVersion: originalContext.contextVersion,
    });
    const action = deepFreeze({
      actionId,
      toolName: definition.name,
      validatedArguments,
      riskLevel: definition.riskLevel,
      runId: command.runId,
      sessionId: command.sessionId,
      traceId: command.traceId,
      userId: command.userId,
      vehicleId: command.vehicleId,
      policyRuleId: command.policyDecision.ruleId,
      policyDecision: cloneAndFreeze(command.policyDecision),
      contextSnapshotId: originalContext.snapshotId,
      contextVersion: originalContext.contextVersion,
      createdAt,
      expiresAt,
      actionFingerprint,
      confirmationSummary,
      state: "AWAITING_CONFIRMATION" as const,
      updatedAt: createdAt,
      stateHistory: Object.freeze([
        Object.freeze({
          from: null,
          to: "AWAITING_CONFIRMATION" as const,
          transitionedAt: createdAt,
        }),
      ]),
    }) as PendingAction;
    const confirmationToken = generatedToken(this.#tokenGenerator);
    this.#repository.create({
      action,
      originalContext,
      tokenHash: tokenHash(confirmationToken),
      confirmationId: null,
      authorization: null,
      authorizationConsumedAt: null,
    });
    try {
      await this.#emit(
        "action.pending.created",
        this.#repository.get(actionId) as PendingActionRecord,
      );
    } catch (error) {
      const cancelled = this.#repository.transition(actionId, "CANCELLED", createdAt);
      try {
        await this.#emit("action.cancelled", cancelled, "PENDING_EVENT_DELIVERY_FAILED");
      } catch {
        // The original boundary failure remains authoritative; the action is already terminal.
      }
      throw error;
    }
    return deepFreeze({
      action,
      trustedChallenge: {
        actionId,
        confirmationToken,
        sessionId: command.sessionId,
        userId: command.userId,
        expiresAt,
      },
      safeResult: {
        actionId,
        toolName: action.toolName,
        riskLevel: action.riskLevel,
        expiresAt,
        summary: action.confirmationSummary,
      },
    });
  }

  get(actionId: string): PendingAction | undefined {
    return this.#repository.get(actionId)?.action;
  }

  async consumeExecutionAuthorization(
    command: ConsumeExecutionAuthorizationCommand,
  ): Promise<ExecutionAuthorization> {
    if (
      typeof command.actionId !== "string" ||
      !safeIdPattern.test(command.actionId) ||
      typeof command.sessionId !== "string" ||
      !safeIdPattern.test(command.sessionId) ||
      typeof command.authorizationId !== "string" ||
      !safeIdPattern.test(command.authorizationId) ||
      typeof command.actionFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(command.actionFingerprint) ||
      !formalNames.has(command.toolName) ||
      typeof command.contextSnapshotId !== "string" ||
      !safeIdPattern.test(command.contextSnapshotId) ||
      !Number.isSafeInteger(command.contextVersion) ||
      command.contextVersion < 1
    ) {
      throw new ActionLifecycleError(
        "AUTHORIZATION_MISMATCH",
        "ExecutionAuthorization binding is invalid",
        command.actionId,
      );
    }
    return this.#repository.runExclusive(command.actionId, () => {
      const record = this.#repository.get(command.actionId);
      if (record === undefined) {
        throw new ActionLifecycleError(
          "AUTHORIZATION_MISMATCH",
          "ExecutionAuthorization does not match a trusted action",
          command.actionId,
        );
      }
      const nowMs = this.#clock.nowMs();
      const authorization = verifyExecutionAuthorizationForConsumption(record, command, nowMs);
      this.#repository.consumeAuthorization(command.actionId, toUtcTimestamp(nowMs));
      return Promise.resolve(authorization);
    });
  }

  async confirm(command: ConfirmActionCommand): Promise<ConfirmationOutcome> {
    requireBoundCommand(command);
    if (
      typeof command.confirmationToken !== "string" ||
      command.confirmationToken.length < 1 ||
      command.confirmationToken.length > 1_024
    ) {
      throw new ActionLifecycleError(
        "CONFIRMATION_TOKEN_INVALID",
        "Confirmation token is invalid",
        command.actionId,
      );
    }
    return this.#repository.runExclusive(command.actionId, async () => {
      let record = this.#require(command.actionId);
      this.#requireAwaiting(record);
      const nowMs = this.#clock.nowMs();
      if (nowMs >= timestampToEpochMs(record.action.expiresAt, "expiresAt")) {
        record = this.#repository.transition(command.actionId, "EXPIRED", toUtcTimestamp(nowMs));
        await this.#emit("confirmation.expired", record);
        throw new ActionLifecycleError(
          "CONFIRMATION_EXPIRED",
          "Confirmation has expired",
          command.actionId,
          record.action.state,
        );
      }
      this.#requireIdentity(record, command);
      this.#requireIntegrity(record);
      if (
        record.tokenHash === null ||
        !safeHashEqual(record.tokenHash, tokenHash(command.confirmationToken))
      ) {
        throw new ActionLifecycleError(
          "CONFIRMATION_TOKEN_INVALID",
          "Confirmation token is invalid",
          command.actionId,
          record.action.state,
        );
      }
      const confirmedAt = toUtcTimestamp(nowMs);
      const confirmationId = generatedId(this.#confirmationIdFactory, "confirmationId");
      this.#repository.transition(command.actionId, "CONFIRMED", confirmedAt);
      record = this.#repository.acceptConfirmation(command.actionId, confirmationId);
      try {
        await this.#emit("confirmation.accepted", record);
        await this.#emit("action.revalidation.started", record);
      } catch (error) {
        await this.#replanAfterBoundaryFailure(record, "EVENT_DELIVERY_FAILED");
        throw error;
      }
      let revalidation: ActionRevalidationResult;
      try {
        revalidation = await this.#revalidator.revalidate(record.action, record.originalContext);
      } catch {
        revalidation = terminalRevalidation("CONTEXT_RELOAD_FAILED");
      }
      const completionMs = this.#clock.nowMs();
      if (revalidation.status !== "VALID" || revalidation.currentContext === null) {
        record = this.#repository.transition(
          command.actionId,
          "REPLAN_REQUIRED",
          toUtcTimestamp(completionMs),
        );
        await this.#emit("action.revalidation.failed", record, revalidation.reason);
        return deepFreeze({ action: record.action, authorization: null, revalidation });
      }
      const issuedAt = toUtcTimestamp(completionMs);
      let authorizationId: string;
      try {
        authorizationId = generatedId(this.#authorizationIdFactory, "authorizationId");
      } catch (error) {
        record = this.#repository.transition(
          command.actionId,
          "REPLAN_REQUIRED",
          toUtcTimestamp(completionMs),
        );
        await this.#emit("action.revalidation.failed", record, "AUTHORIZATION_GENERATION_FAILED");
        throw error;
      }
      const authorization = deepFreeze({
        authorizationId,
        actionId: record.action.actionId,
        actionFingerprint: record.action.actionFingerprint,
        toolName: record.action.toolName,
        riskLevel: record.action.riskLevel,
        confirmationId,
        policyRuleId: record.action.policyRuleId,
        contextSnapshotId: revalidation.currentContext.snapshotId,
        contextVersion: revalidation.currentContext.contextVersion,
        issuedAt,
        expiresAt: toUtcTimestamp(completionMs + this.#authorizationTtlMs),
      }) as ExecutionAuthorization;
      record = this.#repository.authorize(command.actionId, authorization, issuedAt);
      await this.#emit("action.ready_for_execution", record);
      return deepFreeze({ action: record.action, authorization, revalidation });
    });
  }

  async reject(command: BoundActionCommand): Promise<PendingAction> {
    return this.#terminal(command, "REJECTED", "confirmation.rejected");
  }

  async cancel(command: BoundActionCommand): Promise<PendingAction> {
    return this.#terminal(command, "CANCELLED", "action.cancelled");
  }

  async expire(actionId: string): Promise<PendingAction> {
    return this.#repository.runExclusive(actionId, async () => {
      let record = this.#require(actionId);
      if (record.action.state === "EXPIRED") return record.action;
      this.#requireAwaiting(record);
      const nowMs = this.#clock.nowMs();
      if (nowMs < timestampToEpochMs(record.action.expiresAt, "expiresAt")) {
        throw new ActionLifecycleError(
          "INVALID_COMMAND",
          "PendingAction has not expired",
          actionId,
          record.action.state,
        );
      }
      record = this.#repository.transition(actionId, "EXPIRED", toUtcTimestamp(nowMs));
      await this.#emit("confirmation.expired", record);
      return record.action;
    });
  }

  async #terminal(
    command: BoundActionCommand,
    state: "REJECTED" | "CANCELLED",
    eventType: "confirmation.rejected" | "action.cancelled",
  ): Promise<PendingAction> {
    requireBoundCommand(command);
    return this.#repository.runExclusive(command.actionId, async () => {
      let record = this.#require(command.actionId);
      this.#requireAwaiting(record);
      this.#requireIdentity(record, command);
      record = this.#repository.transition(
        command.actionId,
        state,
        toUtcTimestamp(this.#clock.nowMs()),
      );
      await this.#emit(eventType, record);
      return record.action;
    });
  }

  #require(actionId: string): PendingActionRecord {
    const record = this.#repository.get(actionId);
    if (record === undefined) {
      throw new ActionLifecycleError("ACTION_NOT_FOUND", "PendingAction was not found", actionId);
    }
    return record;
  }

  #requireAwaiting(record: PendingActionRecord): void {
    if (record.action.state !== "AWAITING_CONFIRMATION") {
      throw new ActionLifecycleError(
        "INVALID_STATE",
        "PendingAction is not awaiting confirmation",
        record.action.actionId,
        record.action.state,
      );
    }
  }

  #requireIdentity(record: PendingActionRecord, command: BoundActionCommand): void {
    if (record.action.sessionId !== command.sessionId || record.action.userId !== command.userId) {
      throw new ActionLifecycleError(
        "CONFIRMATION_IDENTITY_MISMATCH",
        "Confirmation identity does not match the PendingAction",
        record.action.actionId,
        record.action.state,
      );
    }
  }

  #requireIntegrity(record: PendingActionRecord): void {
    assertPendingActionIntegrity(record.action);
  }

  async #replanAfterBoundaryFailure(record: PendingActionRecord, reason: string): Promise<void> {
    if (record.action.state !== "CONFIRMED") return;
    const replanned = this.#repository.transition(
      record.action.actionId,
      "REPLAN_REQUIRED",
      toUtcTimestamp(this.#clock.nowMs()),
    );
    try {
      await this.#emit("action.revalidation.failed", replanned, reason);
    } catch {
      // Best-effort audit after the original sink failure; state is already fail-closed.
    }
  }

  async #emit(
    eventType: ActionLifecycleEventType,
    record: PendingActionRecord,
    reason?: string,
  ): Promise<void> {
    const event = Object.freeze({
      eventId: generatedId(this.#eventIdFactory, "eventId"),
      eventType,
      runId: record.action.runId,
      sessionId: record.action.sessionId,
      traceId: record.action.traceId,
      actionId: record.action.actionId,
      toolName: record.action.toolName,
      timestamp: toUtcTimestamp(this.#clock.nowMs()),
      state: record.action.state,
      ...(reason === undefined ? {} : { reason }),
    }) as ActionLifecycleEvent;
    try {
      await this.#eventSink.emit(event);
    } catch {
      throw new ActionLifecycleError(
        "INTERNAL_ERROR",
        "Action lifecycle event delivery failed safely",
        record.action.actionId,
        record.action.state,
      );
    }
  }
}
