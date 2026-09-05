import {
  ActionLifecycleError,
  type PendingAction,
  type SafeConfirmationRequiredResult,
  type TrustedConfirmationChallenge,
} from "@driveguard/action-lifecycle";
import type {
  AgentRunResult,
  ProductionDriveGuardRuntime,
  RuntimeEvent,
} from "@driveguard/agent-runtime";
import { toUtcTimestamp } from "@driveguard/domain";
import type { ExecutionResult } from "@driveguard/executor";
import {
  InMemoryConversationRepository,
  InMemorySessionRepository,
  RepositoryConversationMemory,
} from "@driveguard/memory";
import { InMemoryExecutionRepository } from "@driveguard/persistence";

import {
  DriveGuardApiService,
  type Phase10RuntimeFactory,
  type Phase10RuntimeFactoryInput,
} from "../../apps/api/src/service.js";

const now = toUtcTimestamp(Date.now());

export function fakeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return Object.freeze({
    actionId: "action:test",
    toolName: "reserve_charging_slot",
    validatedArguments: Object.freeze({ stationId: "station-pudong-001" }),
    riskLevel: "R2",
    runId: "run:test",
    sessionId: "session:test",
    traceId: "trace:test",
    userId: "user:test",
    vehicleId: "vehicle:test",
    policyRuleId: "DG-POL-008",
    policyDecision: Object.freeze({
      decisionId: "decision:test",
      decision: "REQUIRE_CONFIRMATION",
      ruleId: "DG-POL-008",
      reasonCode: "CONFIRMATION_REQUIRED",
      toolName: "reserve_charging_slot",
      riskLevel: "R2",
      evaluatedAt: now,
      contextSnapshotId: "context:test",
      contextVersion: 1,
      runId: "run:test",
      sessionId: "session:test",
      traceId: "trace:test",
      actionFingerprint: "a".repeat(64),
    }) as never,
    contextSnapshotId: "context:test",
    contextVersion: 1,
    createdAt: now,
    expiresAt: toUtcTimestamp(Date.now() + 60_000),
    actionFingerprint: "a".repeat(64),
    confirmationSummary: "Reserve station-pudong-001",
    state: "AWAITING_CONFIRMATION",
    updatedAt: now,
    stateHistory: Object.freeze([
      Object.freeze({ from: null, to: "AWAITING_CONFIRMATION", transitionedAt: now }),
    ]),
    ...overrides,
  });
}

function transitioned(action: PendingAction, state: PendingAction["state"]): PendingAction {
  const at = toUtcTimestamp(Date.now());
  return Object.freeze({
    ...action,
    state,
    updatedAt: at,
    stateHistory: Object.freeze([
      ...action.stateHistory,
      Object.freeze({ from: action.state, to: state, transitionedAt: at }),
    ]),
  });
}

export const fakeExecution = Object.freeze({
  executionId: "execution:test",
  toolName: "reserve_charging_slot",
  status: "SUCCEEDED",
  attemptCount: 1,
  deduplicated: false,
  startedAt: now,
  completedAt: now,
  result: Object.freeze({ reservationId: "reservation:test" }),
}) as ExecutionResult;

export class FakePhase10RuntimeFactory implements Phase10RuntimeFactory {
  readonly actions = new Map<string, PendingAction>();
  readonly challenges = new Map<string, TrustedConfirmationChallenge>();
  readonly inputs: Phase10RuntimeFactoryInput[] = [];
  nextResult: AgentRunResult | undefined;
  delayRun = false;
  runRelease: (() => void) | undefined;
  cancelCalls = 0;
  confirmCalls = 0;
  getError: Error | undefined;
  rejectError: Error | undefined;
  cancelError: Error | undefined;
  confirmError: Error | undefined;
  createError: Error | undefined;
  disappearAfterConfirm = false;

  create(input: Phase10RuntimeFactoryInput): ProductionDriveGuardRuntime {
    if (this.createError !== undefined) throw this.createError;
    this.inputs.push(input);
    const confirmationService = {
      get: (actionId: string): Promise<PendingAction | undefined> => {
        if (this.getError !== undefined) return Promise.reject(this.getError);
        return Promise.resolve(this.actions.get(actionId));
      },
      reject: (command: { actionId: string; sessionId: string; userId: string }) => {
        if (this.rejectError !== undefined) return Promise.reject(this.rejectError);
        const action = this.requireBound(command);
        const updated = transitioned(action, "REJECTED");
        this.actions.set(command.actionId, updated);
        return Promise.resolve(updated);
      },
      cancel: (command: { actionId: string; sessionId: string; userId: string }) => {
        if (this.cancelError !== undefined) return Promise.reject(this.cancelError);
        const action = this.requireBound(command);
        const updated = transitioned(action, "CANCELLED");
        this.actions.set(command.actionId, updated);
        return Promise.resolve(updated);
      },
    };
    return {
      mode: "development",
      sessionCount: 0,
      confirmationService: confirmationService as never,
      trustedConfirmationChallengeChannel: {
        publish: (challenge) => {
          this.challenges.set(challenge.actionId, challenge);
        },
        take: (actionId) => {
          const value = this.challenges.get(actionId);
          this.challenges.delete(actionId);
          return value;
        },
        discard: (actionId) => {
          this.challenges.delete(actionId);
        },
      },
      cancel: () => {
        this.cancelCalls += 1;
        this.runRelease?.();
        return true;
      },
      sessionSnapshot: () => undefined,
      sessionSnapshots: () => Object.freeze([]),
      confirmAndExecute: (command) => {
        this.confirmCalls += 1;
        if (this.confirmError !== undefined) return Promise.reject(this.confirmError);
        const action = this.requireBound(command);
        if (command.confirmationToken !== "credential:test") {
          return Promise.reject(
            new ActionLifecycleError("CONFIRMATION_TOKEN_INVALID", "invalid", command.actionId),
          );
        }
        if (this.disappearAfterConfirm) this.actions.delete(command.actionId);
        else this.actions.set(command.actionId, transitioned(action, "READY_FOR_EXECUTION"));
        return Promise.resolve(fakeExecution);
      },
      confirmAndComplete: (command) => {
        this.confirmCalls += 1;
        if (this.confirmError !== undefined) return Promise.reject(this.confirmError);
        const action = this.requireBound(command);
        if (command.confirmationToken !== "credential:test") {
          return Promise.reject(
            new ActionLifecycleError("CONFIRMATION_TOKEN_INVALID", "invalid", command.actionId),
          );
        }
        if (this.disappearAfterConfirm) this.actions.delete(command.actionId);
        else this.actions.set(command.actionId, transitioned(action, "READY_FOR_EXECUTION"));
        return Promise.resolve(
          Object.freeze({
            actionId: command.actionId,
            toolName: action.toolName,
            idempotencyKey: `confirmed:${command.actionId}`,
            execution: fakeExecution,
            stateRefresh: Object.freeze({ status: "REFRESHED" as const }),
            lifecycle: Object.freeze([
              "ACTION_PROPOSED" as const,
              "POLICY_CHECKED" as const,
              "CONFIRMATION_CREATED" as const,
              "USER_CONFIRMED" as const,
              "EXECUTING" as const,
              "EXECUTED" as const,
              "STATE_REFRESHED" as const,
              "FINAL_RESPONSE" as const,
            ]),
            response:
              "The requested action completed successfully, and the current state was refreshed.",
          }),
        );
      },
      run: async (request) => {
        if (this.delayRun) {
          await new Promise<void>((resolve) => {
            this.runRelease = resolve;
          });
        }
        const result = this.nextResult ?? fakeRunResult();
        const runtimeEvent: RuntimeEvent = Object.freeze({
          eventId: "event:started",
          eventType: "agent.run.started",
          runId: result.run.runId,
          sessionId: request.sessionId,
          traceId: result.run.traceId,
          timestamp: now,
        });
        await input.runtimeEventSink?.emit(runtimeEvent);
        await input.assistantTextDeltaSink?.({
          delta: "safe delta",
          runId: result.run.runId,
          sessionId: request.sessionId,
          traceId: result.run.traceId,
        });
        return result;
      },
    };
  }

  requireBound(command: { actionId: string; sessionId: string; userId: string }): PendingAction {
    const action = this.actions.get(command.actionId);
    if (action === undefined) {
      throw new ActionLifecycleError("ACTION_NOT_FOUND", "not found", command.actionId);
    }
    if (action.sessionId !== command.sessionId || action.userId !== command.userId) {
      throw new ActionLifecycleError(
        "CONFIRMATION_IDENTITY_MISMATCH",
        "identity mismatch",
        command.actionId,
      );
    }
    return action;
  }
}

export function fakeRunResult(
  options: {
    status?: AgentRunResult["status"];
    errorCode?: NonNullable<AgentRunResult["error"]>["code"];
    confirmation?: SafeConfirmationRequiredResult;
  } = {},
): AgentRunResult {
  const status = options.status ?? "succeeded";
  return Object.freeze({
    status,
    response: status === "succeeded" ? "safe response" : "",
    run: Object.freeze({
      runId: "run:test",
      sessionId: "session:test",
      traceId: "trace:test",
      createdAt: now,
      status: status === "succeeded" ? "RUN_SUCCEEDED" : "RUN_FAILED",
      statusHistory: Object.freeze([
        "RUN_CREATED",
        status === "succeeded" ? "RUN_SUCCEEDED" : "RUN_FAILED",
      ]),
    }) as never,
    events: Object.freeze([]),
    runtimeMode: "development",
    safetyNotice: "POLICY_GUARDED_TOOL_EXECUTION" as never,
    availableToolNames: Object.freeze([]),
    toolExecutions: Object.freeze([]),
    policyDecisions: Object.freeze([]),
    confirmationRequired: Object.freeze(
      options.confirmation === undefined ? [] : [options.confirmation],
    ),
    ...(options.errorCode === undefined
      ? {}
      : { error: { code: options.errorCode, message: "safe failure", retryable: false } }),
  });
}

export function createFakeApiHarness() {
  const sessions = new InMemorySessionRepository();
  const conversation = new RepositoryConversationMemory({
    sessions,
    conversation: new InMemoryConversationRepository(),
  });
  const executions = new InMemoryExecutionRepository();
  const factory = new FakePhase10RuntimeFactory();
  const service = new DriveGuardApiService({
    sessions,
    conversation,
    executions,
    runtimeFactory: factory,
  });
  return { sessions, conversation, executions, factory, service };
}
