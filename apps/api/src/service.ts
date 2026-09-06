import { randomUUID } from "node:crypto";

import type { ActionLifecycleEventSink, PendingAction } from "@driveguard/action-lifecycle";
import {
  AgentRuntimeError,
  type ConfirmedActionCompletion,
  type ProductionDriveGuardRuntime,
  type RuntimeEventSink,
} from "@driveguard/agent-runtime";
import { toUtcTimestamp, timestampToEpochMs, type UtcTimestamp } from "@driveguard/domain";
import type { ExecutionEventSink, ExecutionResult } from "@driveguard/executor";
import type {
  ConversationMemory,
  ConversationMessage,
  SessionRepository,
} from "@driveguard/memory";
import type { ExecutionEnvelope, ExecutionRepository } from "@driveguard/persistence";

import { actionApiError, ApiError, runtimeApiError } from "./errors.js";
import { createRuntimePublicEventSink, publicEvent, type PublicEventEmitter } from "./events.js";

export const DEVELOPMENT_IDENTITY_BOUNDARY = "DEVELOPMENT_IDENTITY_BOUNDARY";

export interface DevelopmentIdentity {
  readonly userId: string;
  readonly vehicleId: string;
}

export interface Phase10RuntimeFactoryInput {
  readonly identity: DevelopmentIdentity;
  readonly prompt?: string;
  readonly runtimeEventSink?: RuntimeEventSink;
  readonly actionLifecycleEventSink?: ActionLifecycleEventSink;
  readonly executionEventSink?: ExecutionEventSink;
  readonly assistantTextDeltaSink?: (event: {
    readonly delta: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly traceId: string;
  }) => void | Promise<void>;
}

export interface Phase10RuntimeFactory {
  create(input: Phase10RuntimeFactoryInput): ProductionDriveGuardRuntime;
}

export interface ApiActionView {
  readonly actionId: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly parameters: unknown;
  readonly summary: string;
  readonly riskLevel: "R2" | "R3";
  readonly state: PendingAction["state"];
  readonly expiresAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface ApiConfirmationView extends ApiActionView {
  readonly confirmationCredential: string;
}

export interface ApiMessageResult {
  readonly status: "completed" | "confirmation_required" | "cancelled" | "failed";
  readonly response: string;
  readonly runId: string;
  readonly traceId: string;
  readonly context: unknown;
  readonly policyDecisions: readonly Readonly<Record<string, unknown>>[];
  readonly actions: readonly ApiConfirmationView[];
  readonly errorCode?: string;
}

export interface ApiSessionView {
  readonly sessionId: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly messages: readonly ConversationMessage[];
  readonly identityBoundary: typeof DEVELOPMENT_IDENTITY_BOUNDARY;
}

export interface ApiExecutionView {
  readonly executionId: string;
  readonly actionId: string | null;
  readonly sessionId: string;
  readonly tool: string;
  readonly state: ExecutionEnvelope["record"]["state"];
  readonly attempts: ExecutionEnvelope["record"]["attempts"];
  readonly result: ExecutionResult | null;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

function actionView(action: PendingAction): ApiActionView {
  return Object.freeze({
    actionId: action.actionId,
    sessionId: action.sessionId,
    tool: action.toolName,
    parameters: structuredClone(action.validatedArguments),
    summary: action.confirmationSummary,
    riskLevel: action.riskLevel,
    state: action.state,
    expiresAt: action.expiresAt,
    updatedAt: action.updatedAt,
  });
}

function sameIdentity(
  record: { readonly userId?: string; readonly vehicleId?: string },
  identity: DevelopmentIdentity,
): boolean {
  return record.userId === identity.userId && record.vehicleId === identity.vehicleId;
}

export class DriveGuardApiService {
  readonly #sessions: SessionRepository;
  readonly #conversation: ConversationMemory;
  readonly #executions: ExecutionRepository;
  readonly #runtimeFactory: Phase10RuntimeFactory;
  readonly #active = new Map<string, ProductionDriveGuardRuntime>();
  readonly #agentTimeoutMs: number;

  constructor(options: {
    readonly sessions: SessionRepository;
    readonly conversation: ConversationMemory;
    readonly executions: ExecutionRepository;
    readonly runtimeFactory: Phase10RuntimeFactory;
    readonly agentTimeoutMs?: number;
  }) {
    this.#sessions = options.sessions;
    this.#conversation = options.conversation;
    this.#executions = options.executions;
    this.#runtimeFactory = options.runtimeFactory;
    this.#agentTimeoutMs = options.agentTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#agentTimeoutMs) || this.#agentTimeoutMs < 100) {
      throw new TypeError("agentTimeoutMs must be an integer of at least 100ms");
    }
  }

  get activeRequestCount(): number {
    return this.#active.size;
  }

  cancelSession(sessionId: string): boolean {
    return this.#active.get(sessionId)?.cancel(sessionId) ?? false;
  }

  cancelAll(): number {
    let cancelled = 0;
    for (const [sessionId, runtime] of this.#active) {
      if (runtime.cancel(sessionId)) cancelled += 1;
    }
    return cancelled;
  }

  async createSession(
    identity: DevelopmentIdentity,
    requestedSessionId?: string,
  ): Promise<ApiSessionView> {
    const now = toUtcTimestamp(Date.now());
    const sessionId = requestedSessionId ?? `session:${randomUUID()}`;
    await this.#sessions.bindIdentity({
      sessionId,
      userId: identity.userId,
      vehicleId: identity.vehicleId,
      updatedAt: now,
    });
    return this.getSession(sessionId, identity);
  }

  async getSession(sessionId: string, identity: DevelopmentIdentity): Promise<ApiSessionView> {
    const record = await this.#sessions.get(sessionId);
    if (record === undefined || !sameIdentity(record, identity)) {
      throw new ApiError("SESSION_NOT_FOUND", "Session was not found", 404);
    }
    const messages = await this.#conversation.restore({
      sessionId,
      userId: identity.userId,
      vehicleId: identity.vehicleId,
      updatedAt: record.updatedAt,
    });
    return Object.freeze({
      sessionId,
      userId: identity.userId,
      vehicleId: identity.vehicleId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messages,
      identityBoundary: DEVELOPMENT_IDENTITY_BOUNDARY,
    });
  }

  async sendMessage(input: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly identity: DevelopmentIdentity;
    readonly emit?: PublicEventEmitter;
    readonly traceId?: string;
  }): Promise<ApiMessageResult> {
    await this.getSession(input.sessionId, input.identity);
    if (this.#active.has(input.sessionId)) {
      throw new ApiError("SESSION_BUSY", "Session already has an active request", 409);
    }
    const emit = input.emit ?? (() => undefined);
    const runtime = this.#runtimeFactory.create({
      identity: input.identity,
      prompt: input.prompt,
      runtimeEventSink: createRuntimePublicEventSink(emit),
      assistantTextDeltaSink: async (event) => {
        await emit(
          publicEvent({
            eventType: "assistant.delta",
            runId: event.runId,
            traceId: event.traceId,
            timestamp: toUtcTimestamp(Date.now()),
            data: { delta: event.delta },
          }),
        );
      },
    });
    this.#active.set(input.sessionId, runtime);
    const budgetTimer = setTimeout(() => runtime.cancel(input.sessionId), this.#agentTimeoutMs);
    budgetTimer.unref?.();
    try {
      const result = await runtime.run({
        sessionId: input.sessionId,
        prompt: input.prompt,
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      });
      const actions: ApiConfirmationView[] = [];
      for (const required of result.confirmationRequired) {
        const action = await runtime.confirmationService.get(required.actionId);
        const challenge = runtime.trustedConfirmationChallengeChannel.take(required.actionId);
        if (
          action === undefined ||
          challenge === undefined ||
          action.sessionId !== input.sessionId ||
          action.userId !== input.identity.userId ||
          challenge.sessionId !== input.sessionId ||
          challenge.userId !== input.identity.userId ||
          action.vehicleId !== input.identity.vehicleId
        ) {
          throw new ApiError("INTERNAL_ERROR", "Confirmation boundary failed safely", 500);
        }
        const view = Object.freeze({
          ...actionView(action),
          confirmationCredential: challenge.confirmationToken,
        });
        actions.push(view);
        await emit(
          publicEvent({
            eventType: "confirmation.required",
            runId: result.run.runId,
            traceId: result.run.traceId,
            timestamp: action.updatedAt,
            data: {
              action_id: view.actionId,
              tool: view.tool,
              parameters: view.parameters,
              summary: view.summary,
              risk_level: view.riskLevel,
              expires_at: view.expiresAt,
              confirmation_credential: view.confirmationCredential,
            },
          }),
        );
      }
      const status =
        actions.length > 0
          ? "confirmation_required"
          : result.status === "succeeded"
            ? "completed"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed";
      if (status === "completed" || status === "confirmation_required") {
        await emit(
          publicEvent({
            eventType: "assistant.completed",
            runId: result.run.runId,
            traceId: result.run.traceId,
            timestamp: toUtcTimestamp(Date.now()),
            data: { status, response: result.response },
          }),
        );
      }
      return Object.freeze({
        status,
        response: result.response,
        runId: result.run.runId,
        traceId: result.run.traceId,
        context: result.context ?? null,
        policyDecisions: Object.freeze(
          result.policyDecisions.map((decision) =>
            Object.freeze({
              tool: decision.toolName,
              decision: decision.decision,
              ruleId: decision.ruleId,
            }),
          ),
        ),
        actions: Object.freeze(actions),
        ...(result.error === undefined ? {} : { errorCode: result.error.code }),
      });
    } finally {
      clearTimeout(budgetTimer);
      if (this.#active.get(input.sessionId) === runtime) this.#active.delete(input.sessionId);
    }
  }

  async getAction(actionId: string, identity: DevelopmentIdentity): Promise<ApiActionView> {
    const runtime = this.#runtimeFactory.create({ identity });
    let action: PendingAction | undefined;
    try {
      action = await runtime.confirmationService.get(actionId);
    } catch (error) {
      throw actionApiError(error);
    }
    if (
      action === undefined ||
      action.userId !== identity.userId ||
      action.vehicleId !== identity.vehicleId
    ) {
      throw new ApiError("ACTION_NOT_FOUND", "Action was not found", 404);
    }
    return actionView(action);
  }

  async confirmAction(input: {
    readonly actionId: string;
    readonly sessionId: string;
    readonly confirmationCredential: string;
    readonly identity: DevelopmentIdentity;
  }): Promise<{
    readonly action: ApiActionView;
    readonly execution: ExecutionResult;
    readonly completion: ConfirmedActionCompletion;
  }> {
    const action = await this.#requireBoundAction(input.actionId, input.sessionId, input.identity);
    if (
      action.state === "AWAITING_CONFIRMATION" &&
      timestampToEpochMs(action.expiresAt, "expiresAt") <= Date.now()
    ) {
      throw new ApiError("ACTION_EXPIRED", "Action has expired", 409);
    }
    const runtime = this.#runtimeFactory.create({ identity: input.identity });
    try {
      const completion = await runtime.confirmAndComplete({
        actionId: input.actionId,
        confirmationToken: input.confirmationCredential,
        sessionId: input.sessionId,
        userId: input.identity.userId,
      });
      const updated = await runtime.confirmationService.get(input.actionId);
      if (updated === undefined) throw new Error("Action disappeared after confirmation");
      return Object.freeze({
        action: actionView(updated),
        execution: completion.execution,
        completion,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof AgentRuntimeError) throw runtimeApiError(error.code);
      throw actionApiError(error);
    }
  }

  async rejectAction(
    actionId: string,
    sessionId: string,
    identity: DevelopmentIdentity,
  ): Promise<ApiActionView> {
    await this.#requireBoundAction(actionId, sessionId, identity);
    const runtime = this.#runtimeFactory.create({ identity });
    try {
      return actionView(
        await runtime.confirmationService.reject({ actionId, sessionId, userId: identity.userId }),
      );
    } catch (error) {
      throw actionApiError(error);
    }
  }

  async cancelAction(
    actionId: string,
    sessionId: string,
    identity: DevelopmentIdentity,
  ): Promise<ApiActionView> {
    await this.#requireBoundAction(actionId, sessionId, identity);
    const runtime = this.#runtimeFactory.create({ identity });
    try {
      return actionView(
        await runtime.confirmationService.cancel({ actionId, sessionId, userId: identity.userId }),
      );
    } catch (error) {
      throw actionApiError(error);
    }
  }

  async getExecution(
    executionId: string,
    identity: DevelopmentIdentity,
  ): Promise<ApiExecutionView> {
    const envelope = await this.#executions.getEnvelope(executionId);
    if (
      envelope === undefined ||
      envelope.request.userId !== identity.userId ||
      envelope.request.vehicleId !== identity.vehicleId
    ) {
      throw new ApiError("EXECUTION_NOT_FOUND", "Execution was not found", 404);
    }
    return Object.freeze({
      executionId,
      actionId: envelope.request.actionId ?? null,
      sessionId: envelope.request.sessionId,
      tool: envelope.record.toolName,
      state: envelope.record.state,
      attempts: envelope.record.attempts,
      result: envelope.result,
      createdAt: envelope.record.createdAt,
      updatedAt: envelope.record.updatedAt,
    });
  }

  failureFor(result: ApiMessageResult): ApiError | undefined {
    return result.status === "failed" ? runtimeApiError(result.errorCode) : undefined;
  }

  async #requireBoundAction(
    actionId: string,
    sessionId: string,
    identity: DevelopmentIdentity,
  ): Promise<PendingAction> {
    const runtime = this.#runtimeFactory.create({ identity });
    const action = await runtime.confirmationService.get(actionId);
    if (
      action === undefined ||
      action.sessionId !== sessionId ||
      action.userId !== identity.userId ||
      action.vehicleId !== identity.vehicleId
    ) {
      throw new ApiError("ACTION_NOT_FOUND", "Action was not found", 404);
    }
    return action;
  }
}
