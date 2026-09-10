import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  createActionFingerprint,
  type ConfirmationService,
  type ConfirmActionCommand,
  type SafeConfirmationRequiredResult,
} from "@driveguard/action-lifecycle";
import { ContextConflictDetector, ContextFreshnessEvaluator } from "@driveguard/context";
import { toUtcTimestamp, type ContextSnapshot } from "@driveguard/domain";
import {
  type PolicyDecision,
  type PolicyEngine,
  type PolicyEvaluationInput,
  type ToolPolicyProfileRegistry,
} from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import type { ExecutionResult, RecoveryReceipt, ReliableToolExecutor } from "@driveguard/executor";
import type {
  ConversationMemory,
  SessionCoordinator,
  SessionIdentityBinding,
} from "@driveguard/memory";
import {
  FORBIDDEN_TOOL_NAMES,
  FORMAL_TOOL_NAMES,
  type FormalToolName,
  type ToolDefinition,
  type ToolRegistry,
  ToolExecutionError,
} from "@driveguard/tools";

import { AgentRun, type AgentRunSnapshot } from "./agent-run.js";
import { ToolArgumentBinder } from "./argument-binder.js";
import {
  ContextLoader,
  ContextLoadFailure,
  selectEffectiveFreshness,
  type ContextFreshnessReport,
} from "./context-loader.js";
import {
  createConfirmedActionCompletion,
  type ConfirmedActionCompletion,
} from "./final-response.js";
import { CriticalPathGuard } from "./critical-path-guard.js";
import { GoalToolRouter, renderGoalBoundPrompt } from "./goal-router.js";
import { PiEventAdapter } from "./pi-event-adapter.js";
import {
  PiToolAdapter,
  type FormalToolExecutionEvidence,
  type Phase5RuntimeMode,
} from "./pi-tool-adapter.js";
import {
  PHASE_6_POLICY_NOTICE,
  PolicyControlError,
  PolicyGuardedToolHandler,
  type RuntimePolicyControlResult,
} from "./policy-guarded-tool-handler.js";
import {
  AgentRuntimeError,
  safeRuntimeError,
  sanitizeRuntimeText,
  type RuntimeFailure,
} from "./runtime-errors.js";
import {
  RuntimeEventFactory,
  type RuntimeEvent,
  type RuntimeEventMetadata,
  type RuntimeEventSink,
  type RuntimeEventType,
} from "./runtime-events.js";
import { AgentSession, AgentSessionStore, type AgentSessionSnapshot } from "./session.js";
import type { TrustedConfirmationChallengeChannel } from "./trusted-confirmation-channel.js";

export interface DriveGuardRuntimeOptions {
  readonly model: Model<string>;
  readonly streamFn: StreamFn;
  readonly contextLoader: ContextLoader;
  readonly toolRegistry: ToolRegistry;
  readonly clock: Clock;
  readonly mode?: Phase5RuntimeMode;
  readonly developmentExecutionOptIn?: boolean;
  readonly runIdFactory?: () => string;
  readonly traceIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly eventSink?: RuntimeEventSink;
  readonly sensitiveValues?: readonly string[];
  readonly policyEngine: PolicyEngine;
  readonly policyProfiles: ToolPolicyProfileRegistry;
  readonly confirmationService: ConfirmationService;
  readonly trustedConfirmationChallengeChannel: TrustedConfirmationChallengeChannel;
  readonly reliableExecutor: ReliableToolExecutor;
  readonly conversationMemory?: ConversationMemory;
  /** Maximum durable conversation messages restored into one model invocation. */
  readonly conversationHistoryLimit?: number;
  readonly sessionCoordinator?: SessionCoordinator;
  readonly assistantTextDeltaSink?: (event: {
    readonly delta: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly traceId: string;
  }) => void | Promise<void>;
  readonly modelUsageSink?: (event: {
    readonly runId: string;
    readonly sessionId: string;
    readonly traceId: string;
    readonly modelName: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cost: number;
    readonly isError: boolean;
    readonly providerDurationMs?: number;
  }) => void | Promise<void>;
  readonly goalToolRouter?: GoalToolRouter;
}

export interface AgentRunRequest {
  readonly sessionId: string;
  readonly prompt: string;
  readonly traceId?: string;
}

export interface AgentRunContextSummary {
  readonly snapshotId: ContextSnapshot["snapshotId"];
  readonly contextVersion: ContextSnapshot["contextVersion"];
  readonly vehicleVersion: ContextSnapshot["vehicle"]["version"];
  readonly tripVersion: ContextSnapshot["trip"]["version"];
  readonly freshness: ContextFreshnessReport;
}

export interface AgentRunResult {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly response: string;
  readonly run: AgentRunSnapshot;
  readonly events: readonly RuntimeEvent[];
  readonly runtimeMode: Phase5RuntimeMode;
  readonly safetyNotice: typeof PHASE_6_POLICY_NOTICE;
  readonly availableToolNames: readonly FormalToolName[];
  readonly toolExecutions: readonly FormalToolExecutionEvidence[];
  readonly policyDecisions: readonly PolicyDecision[];
  /** Safe for model/application display. Never contains a confirmation token. */
  readonly confirmationRequired: readonly SafeConfirmationRequiredResult[];
  readonly recoveryReceipts?: readonly RecoveryReceipt[];
  readonly context?: AgentRunContextSummary;
  readonly error?: RuntimeFailure;
}

interface MutableRunEvidence {
  context?: AgentRunContextSummary;
  availableToolNames: FormalToolName[];
  toolExecutions: FormalToolExecutionEvidence[];
  policyDecisions: PolicyDecision[];
  confirmationRequired: SafeConfirmationRequiredResult[];
  recoveryReceipts: RecoveryReceipt[];
}

export interface ProductionDriveGuardRuntime {
  readonly mode: Phase5RuntimeMode;
  readonly sessionCount: number;
  readonly confirmationService: ConfirmationService;
  readonly trustedConfirmationChallengeChannel: TrustedConfirmationChallengeChannel;
  cancel(sessionId: string): boolean;
  sessionSnapshot(sessionId: string): AgentSessionSnapshot | undefined;
  sessionSnapshots(): readonly AgentSessionSnapshot[];
  retentionSnapshot(): RuntimeRetentionSnapshot;
  confirmAndExecute(command: ConfirmActionCommand): Promise<ExecutionResult>;
  confirmAndComplete(command: ConfirmActionCommand): Promise<ConfirmedActionCompletion>;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface RuntimeRetentionSnapshot {
  readonly sessions: number;
  readonly contextBytes: number;
  readonly issuedRunIds: number;
  readonly issuedTraceIds: number;
  readonly issuedEventIds: number;
  readonly cancelledRunIds: number;
  readonly executionRecords: number;
  readonly idempotencyEntries: number;
}

const forbiddenNames = new Set<string>(FORBIDDEN_TOOL_NAMES);
const formalNames = new Set<string>(FORMAL_TOOL_NAMES);
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function safeIdFactory(prefix: string): () => string {
  return () => `${prefix}:${randomUUID()}`;
}

function validateRequest(request: AgentRunRequest): void {
  if (
    typeof request.sessionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.sessionId)
  ) {
    throw new AgentRuntimeError("INTERNAL_ERROR", "sessionId is invalid");
  }
  if (
    typeof request.prompt !== "string" ||
    request.prompt.trim().length === 0 ||
    request.prompt.length > 32_000
  ) {
    throw new AgentRuntimeError("INTERNAL_ERROR", "prompt is invalid");
  }
  if (
    request.traceId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.traceId)
  ) {
    throw new AgentRuntimeError("INTERNAL_ERROR", "traceId is invalid");
  }
}

function sessionPersistenceRuntimeError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/identity mismatch/iu.test(message)) {
    return new AgentRuntimeError("INTERNAL_ERROR", "Session identity boundary failed safely");
  }
  if (/session lease (?:was )?lost/iu.test(message)) {
    return new AgentRuntimeError("SESSION_BUSY", "Durable session lease was lost", true);
  }
  return new AgentRuntimeError(
    "CONTEXT_LOAD_FAILED",
    "Session persistence is temporarily unavailable",
    true,
  );
}

const ISSUED_RUN_ID_RETENTION = 256;
const ISSUED_EVENT_ID_RETENTION = 2_048;

function rememberIssuedId(issued: Set<string>, id: string, retention: number): void {
  issued.add(id);
  while (issued.size > retention) {
    const oldest = issued.values().next().value;
    if (oldest === undefined) return;
    issued.delete(oldest);
  }
}

/** @internal Construct only through createProductionDriveGuardRuntime. */
export class DriveGuardAgentRuntime implements ProductionDriveGuardRuntime {
  readonly mode: Phase5RuntimeMode;
  readonly #sessions: AgentSessionStore;
  readonly #contextLoader: ContextLoader;
  readonly #toolRegistry: ToolRegistry;
  readonly #clock: Clock;
  readonly #runIdFactory: () => string;
  readonly #traceIdFactory: () => string;
  readonly #eventFactory: RuntimeEventFactory;
  readonly #eventSink: RuntimeEventSink | undefined;
  readonly #sensitiveValues: readonly string[];
  readonly #policyEngine: PolicyEngine;
  readonly #policyProfiles: ToolPolicyProfileRegistry;
  readonly #reliableExecutor: ReliableToolExecutor;
  readonly #conversationMemory: ConversationMemory | undefined;
  readonly #sessionCoordinator: SessionCoordinator | undefined;
  readonly #assistantTextDeltaSink: DriveGuardRuntimeOptions["assistantTextDeltaSink"];
  readonly #modelUsageSink: DriveGuardRuntimeOptions["modelUsageSink"];
  readonly #goalToolRouter: GoalToolRouter;
  readonly #conversationHistoryLimit: number;
  readonly confirmationService: ConfirmationService;
  readonly trustedConfirmationChallengeChannel: TrustedConfirmationChallengeChannel;
  readonly #cancelledRunIds = new Set<string>();
  readonly #issuedRunIds = new Set<string>();
  readonly #issuedTraceIds = new Set<string>();
  readonly #issuedEventIds = new Set<string>();

  constructor(options: DriveGuardRuntimeOptions) {
    this.mode = options.mode ?? "read_only";
    if (this.mode !== "read_only" && this.mode !== "development") {
      throw new AgentRuntimeError(
        "CONFIGURATION_ERROR",
        "PHASE_5_RUNTIME_MODE must be read_only or development",
      );
    }
    if (this.mode === "development" && options.developmentExecutionOptIn !== true) {
      throw new AgentRuntimeError(
        "CONFIGURATION_ERROR",
        "Development side-effect execution requires explicit NON_PRODUCTION opt-in",
      );
    }
    this.#contextLoader = options.contextLoader;
    this.#toolRegistry = options.toolRegistry;
    this.#clock = options.clock;
    this.#runIdFactory = options.runIdFactory ?? safeIdFactory("run");
    this.#traceIdFactory = options.traceIdFactory ?? safeIdFactory("trace");
    this.#eventFactory = new RuntimeEventFactory({
      clock: options.clock,
      eventIdFactory: options.eventIdFactory ?? safeIdFactory("event"),
    });
    this.#eventSink = options.eventSink;
    this.#sensitiveValues = Object.freeze([...(options.sensitiveValues ?? [])]);
    this.#policyEngine = options.policyEngine;
    this.#policyProfiles = options.policyProfiles;
    this.#reliableExecutor = options.reliableExecutor;
    this.#conversationMemory = options.conversationMemory;
    this.#sessionCoordinator = options.sessionCoordinator;
    this.#assistantTextDeltaSink = options.assistantTextDeltaSink;
    this.#modelUsageSink = options.modelUsageSink;
    this.#goalToolRouter = options.goalToolRouter ?? new GoalToolRouter();
    this.confirmationService = options.confirmationService;
    this.trustedConfirmationChallengeChannel = options.trustedConfirmationChallengeChannel;
    const conversationHistoryLimit = options.conversationHistoryLimit ?? 40;
    if (!Number.isSafeInteger(conversationHistoryLimit) || conversationHistoryLimit < 1) {
      throw new AgentRuntimeError(
        "CONFIGURATION_ERROR",
        "Conversation history limit must be a positive integer",
      );
    }
    this.#conversationHistoryLimit = conversationHistoryLimit;
    this.#sessions = new AgentSessionStore(async (sessionId, identity) => {
      if (options.conversationMemory !== undefined && identity === undefined) {
        throw new AgentRuntimeError(
          "CONFIGURATION_ERROR",
          "Durable conversation restore requires a bound session identity",
        );
      }
      return new AgentSession({
        sessionId,
        model: options.model,
        streamFn: options.streamFn,
        clock: options.clock,
        history:
          options.conversationMemory === undefined || identity === undefined
            ? []
            : options.conversationMemory.restoreRecent === undefined
              ? (await options.conversationMemory.restore(identity)).slice(
                  -conversationHistoryLimit,
                )
              : await options.conversationMemory.restoreRecent(identity, conversationHistoryLimit),
      });
    });
  }

  cancel(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    const run = session?.activeRun;
    if (session === undefined || run === undefined || run.isTerminal) return false;
    this.#cancelledRunIds.add(run.runId);
    session.abort();
    return true;
  }

  sessionSnapshot(sessionId: string): AgentSessionSnapshot | undefined {
    return this.#sessions.get(sessionId)?.snapshot();
  }

  sessionSnapshots(): readonly AgentSessionSnapshot[] {
    return this.#sessions.snapshots();
  }

  retentionSnapshot(): RuntimeRetentionSnapshot {
    const sessions = this.#sessions.snapshots();
    const executor = this.#reliableExecutor.retentionSnapshot();
    return Object.freeze({
      sessions: sessions.length,
      contextBytes: sessions.reduce((total, session) => total + session.contextBytes, 0),
      issuedRunIds: this.#issuedRunIds.size,
      issuedTraceIds: this.#issuedTraceIds.size,
      issuedEventIds: this.#issuedEventIds.size,
      cancelledRunIds: this.#cancelledRunIds.size,
      executionRecords: executor.executionRecords,
      idempotencyEntries: executor.idempotencyEntries,
    });
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  async confirmAndExecute(command: ConfirmActionCommand): Promise<ExecutionResult> {
    const pending = await this.confirmationService.get(command.actionId);
    if (pending === undefined) {
      throw new AgentRuntimeError("INTERNAL_ERROR", "Pending action was not found");
    }
    const coordinated =
      this.#sessionCoordinator === undefined
        ? true
        : await this.#sessionCoordinator.acquire(command.sessionId, pending.runId);
    if (!coordinated) {
      throw new AgentRuntimeError("SESSION_BUSY", "Agent session already has an active run");
    }
    let leaseLost = false;
    const leaseHeartbeat = this.#startSessionLeaseHeartbeat(
      command.sessionId,
      pending.runId,
      () => {
        leaseLost = true;
      },
    );
    try {
      const confirmed =
        pending.state === "READY_FOR_EXECUTION"
          ? await this.confirmationService.resumeReadyForExecution(command)
          : await this.confirmationService.confirm(command);
      if (leaseLost) throw new AgentRuntimeError("SESSION_BUSY", "Durable session lease was lost");
      if (confirmed.authorization === null) {
        throw new AgentRuntimeError(
          "POLICY_REPLAN_REQUIRED",
          "Confirmed action requires replanning before execution",
        );
      }
      const definition = this.#toolRegistry.get(confirmed.action.toolName);
      if (definition === undefined || definition.riskLevel !== confirmed.action.riskLevel) {
        throw new AgentRuntimeError("INTERNAL_ERROR", "Confirmed Tool definition is unavailable");
      }
      const authorization = confirmed.authorization;
      const result = await this.#reliableExecutor.execute({
        executionId: `execution:${randomUUID()}`,
        toolName: confirmed.action.toolName,
        validatedArguments: confirmed.action.validatedArguments,
        actionFingerprint: confirmed.action.actionFingerprint,
        runId: confirmed.action.runId,
        sessionId: confirmed.action.sessionId,
        userId: confirmed.action.userId,
        vehicleId: confirmed.action.vehicleId,
        traceId: confirmed.action.traceId,
        riskLevel: confirmed.action.riskLevel,
        policyDecision: confirmed.action.policyDecision,
        actionId: confirmed.action.actionId,
        authorizationId: authorization.authorizationId,
        contextSnapshotId: authorization.contextSnapshotId,
        contextVersion: authorization.contextVersion,
        idempotencyKey: `confirmed:${confirmed.action.actionId}`,
        createdAt: toUtcTimestamp(this.#clock.nowMs()),
      });
      return result;
    } finally {
      await Promise.allSettled([
        leaseHeartbeat.stop(),
        this.#sessionCoordinator?.release(command.sessionId, pending.runId) ?? Promise.resolve(),
      ]);
    }
  }

  async confirmAndComplete(command: ConfirmActionCommand): Promise<ConfirmedActionCompletion> {
    const pending = await this.confirmationService.get(command.actionId);
    if (pending === undefined) {
      throw new AgentRuntimeError("INTERNAL_ERROR", "Pending action was not found");
    }
    const execution = await this.confirmAndExecute(command);
    let stateRefresh: ConfirmedActionCompletion["stateRefresh"];
    try {
      const current = await this.#contextLoader.load();
      stateRefresh = Object.freeze({
        status: "REFRESHED",
        snapshotId: current.snapshot.snapshotId,
        contextVersion: current.snapshot.contextVersion,
      });
    } catch {
      stateRefresh = Object.freeze({ status: "UNAVAILABLE" });
    }
    return createConfirmedActionCompletion({
      command,
      toolName: pending.toolName,
      execution,
      stateRefresh,
    });
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    validateRequest(request);
    const generatedRunId = this.#generateId(this.#runIdFactory, "run", this.#issuedRunIds);
    const generatedTraceId =
      request.traceId === undefined
        ? this.#generateId(this.#traceIdFactory, "trace", this.#issuedTraceIds)
        : { id: request.traceId, failed: false };
    let runtimeBoundaryFailed = generatedRunId.failed || generatedTraceId.failed;
    const run = new AgentRun(
      {
        runId: generatedRunId.id,
        sessionId: request.sessionId,
        traceId: generatedTraceId.id,
        createdAt: toUtcTimestamp(this.#clock.nowMs()),
      },
      this.#clock,
    );
    const events: RuntimeEvent[] = [];
    const evidence: MutableRunEvidence = {
      availableToolNames: [],
      toolExecutions: [],
      policyDecisions: [],
      confirmationRequired: [],
      recoveryReceipts: [],
    };
    let sinkFailed = false;
    const fallbackEventFactory = new RuntimeEventFactory({
      clock: { nowMs: () => Date.now() },
      eventIdFactory: safeIdFactory("event-fallback"),
    });
    const createEvent = (
      eventType: RuntimeEventType,
      metadata?: RuntimeEventMetadata,
    ): RuntimeEvent => {
      try {
        const event = this.#eventFactory.create(eventType, run, metadata);
        if (
          typeof event.eventId !== "string" ||
          !safeIdPattern.test(event.eventId) ||
          this.#issuedEventIds.has(event.eventId)
        ) {
          throw new AgentRuntimeError("INTERNAL_ERROR", "Runtime Event ID is invalid or duplicate");
        }
        rememberIssuedId(this.#issuedEventIds, event.eventId, ISSUED_EVENT_ID_RETENTION);
        return event;
      } catch {
        runtimeBoundaryFailed = true;
        const fallback = fallbackEventFactory.create(eventType, run, metadata);
        rememberIssuedId(this.#issuedEventIds, fallback.eventId, ISSUED_EVENT_ID_RETENTION);
        return fallback;
      }
    };
    const emit = async (event: RuntimeEvent): Promise<void> => {
      events.push(event);
      try {
        await this.#eventSink?.emit(event);
      } catch {
        sinkFailed = true;
      }
    };
    const emitRuntime = async (
      eventType: RuntimeEventType,
      metadata?: RuntimeEventMetadata,
    ): Promise<void> => {
      const event = createEvent(eventType, metadata);
      this.#throwIfRuntimeBoundaryFailed(runtimeBoundaryFailed);
      await emit(event);
    };
    const startedEvent = createEvent("agent.run.started", {
      runtimeMode: this.mode,
      boundary: "POLICY_GUARDED",
    });
    if (runtimeBoundaryFailed) {
      const error = new AgentRuntimeError(
        "INTERNAL_ERROR",
        "Runtime identity or Event factory failed safely",
      );
      run.transition("RUN_FAILED");
      await emit(
        createEvent("agent.run.failed", {
          errorCode: error.code,
          runtimeMode: this.mode,
          boundary: "POLICY_GUARDED",
        }),
      );
      return this.#result(
        "failed",
        this.#safeFailureResponse(error),
        run,
        events,
        evidence,
        error.toFailure(),
      );
    }
    await emit(startedEvent);
    if (sinkFailed) {
      const error = new AgentRuntimeError("INTERNAL_ERROR", "Runtime event delivery failed safely");
      run.transition("RUN_FAILED");
      await emit(
        createEvent("agent.run.failed", {
          errorCode: error.code,
          runtimeMode: this.mode,
          boundary: "POLICY_GUARDED",
        }),
      );
      return this.#result(
        "failed",
        this.#safeFailureResponse(error),
        run,
        events,
        evidence,
        error.toFailure(),
      );
    }

    const coordinated =
      this.#sessionCoordinator === undefined
        ? true
        : await this.#sessionCoordinator.acquire(request.sessionId, run.runId);
    if (!coordinated) {
      const error = new AgentRuntimeError(
        "SESSION_BUSY",
        "Agent session already has an active run",
      );
      run.transition("RUN_FAILED");
      await emit(
        createEvent("agent.run.failed", {
          errorCode: error.code,
          runtimeMode: this.mode,
          boundary: "POLICY_GUARDED",
        }),
      );
      return this.#result(
        "failed",
        this.#safeFailureResponse(error),
        run,
        events,
        evidence,
        error.toFailure(),
      );
    }
    let sessionLeaseLost = false;
    let reliableExecutionCommitted = false;
    let reliableExecutionInFlight = false;
    let sessionForLease: AgentSession | undefined;
    const throwIfSessionLeaseLost = (): void => {
      if (sessionLeaseLost) {
        throw new AgentRuntimeError("SESSION_BUSY", "Durable session lease was lost");
      }
    };
    const leaseHeartbeat = this.#startSessionLeaseHeartbeat(request.sessionId, run.runId, () => {
      sessionLeaseLost = true;
      if (!reliableExecutionCommitted && !reliableExecutionInFlight) sessionForLease?.abort();
    });
    let session: AgentSession;
    let loaded: Awaited<ReturnType<ContextLoader["load"]>>;
    try {
      run.transition("CONTEXT_LOADING");
      loaded = await this.#contextLoader.load();
      run.attachContext(loaded.snapshot.snapshotId);
      const identity: SessionIdentityBinding = {
        sessionId: request.sessionId,
        userId: loaded.snapshot.user.userId,
        vehicleId: loaded.snapshot.vehicle.vehicleId,
        updatedAt: toUtcTimestamp(this.#clock.nowMs()),
      };
      await this.#conversationMemory?.bindIdentity(identity);
      session = await this.#sessions.getOrCreate(request.sessionId, identity);
      sessionForLease = session;
      throwIfSessionLeaseLost();
    } catch (error) {
      if (error instanceof ContextLoadFailure && error.recovery !== undefined) {
        evidence.recoveryReceipts.push(error.recovery);
      }
      await leaseHeartbeat.stop();
      await this.#sessionCoordinator?.release(request.sessionId, run.runId);
      const failure = sessionLeaseLost
        ? new AgentRuntimeError("SESSION_BUSY", "Durable session lease was lost")
        : error instanceof AgentRuntimeError
          ? error
          : sessionPersistenceRuntimeError(error);
      if (!run.isTerminal) run.transition("RUN_FAILED");
      await emit(
        createEvent("agent.run.failed", {
          errorCode: failure.code,
          runtimeMode: this.mode,
          boundary: "POLICY_GUARDED",
        }),
      );
      return this.#result(
        "failed",
        this.#safeFailureResponse(failure),
        run,
        events,
        evidence,
        failure.toFailure(),
      );
    }
    if (!session.acquire(run)) {
      await leaseHeartbeat.stop();
      await this.#sessionCoordinator?.release(request.sessionId, run.runId);
      const error = new AgentRuntimeError(
        "SESSION_BUSY",
        "Agent session already has an active run",
      );
      run.transition("RUN_FAILED");
      await emit(
        createEvent("agent.run.failed", {
          errorCode: error.code,
          runtimeMode: this.mode,
          boundary: "POLICY_GUARDED",
        }),
      );
      return this.#result(
        "failed",
        this.#safeFailureResponse(error),
        run,
        events,
        evidence,
        error.toFailure(),
      );
    }
    throwIfSessionLeaseLost();
    const transcriptCheckpoint = session.checkpoint();
    let toolAdapter: PiToolAdapter | undefined;

    try {
      evidence.context = Object.freeze({
        snapshotId: loaded.snapshot.snapshotId,
        contextVersion: loaded.snapshot.contextVersion,
        vehicleVersion: loaded.snapshot.vehicle.version,
        tripVersion: loaded.snapshot.trip.version,
        freshness: loaded.freshness,
      });
      await emitRuntime("context.loaded", {
        contextVersion: loaded.snapshot.contextVersion,
        contextFreshness: loaded.freshness.status,
        runtimeMode: this.mode,
        boundary: "POLICY_GUARDED",
      });
      this.#throwIfSinkFailed(sinkFailed);
      this.#throwIfCancelled(run);
      throwIfSessionLeaseLost();

      run.transition("CAPABILITY_RESOLUTION");
      let definitions: readonly ToolDefinition[];
      try {
        definitions = this.#toolRegistry.resolve({
          capabilities: loaded.snapshot.capabilities,
          services: loaded.services,
        });
      } catch {
        throw new AgentRuntimeError(
          "CAPABILITY_RESOLUTION_FAILED",
          "Dynamic Tool capability resolution failed",
        );
      }
      const modeAvailable = definitions.filter((definition) =>
        this.mode === "read_only" ? definition.riskLevel === "R0" : true,
      );
      const goalPlan = this.#goalToolRouter.plan(request.prompt, modeAvailable);
      const criticalPathGuard = new CriticalPathGuard();
      const criticalEnvelopes = criticalPathGuard.resolve(request.prompt, goalPlan, modeAvailable);
      const candidates = new Set<string>(goalPlan.candidateToolNames);
      const exposed = modeAvailable.filter((definition) => candidates.has(definition.name));
      if (definitions.some((definition) => !formalNames.has(definition.name))) {
        throw new AgentRuntimeError(
          "CAPABILITY_RESOLUTION_FAILED",
          "Non-formal capability reached the production Agent Runtime",
        );
      }
      if (exposed.some((definition) => forbiddenNames.has(definition.name))) {
        throw new AgentRuntimeError(
          "CAPABILITY_RESOLUTION_FAILED",
          "Forbidden RX capability reached the model Tool space",
        );
      }
      if (this.mode === "read_only" && exposed.some((definition) => definition.sideEffect)) {
        throw new AgentRuntimeError(
          "CAPABILITY_RESOLUTION_FAILED",
          "A side-effect capability reached read-only model Tool space",
        );
      }
      evidence.availableToolNames = exposed.map((definition) => definition.name as FormalToolName);
      await emitRuntime("capabilities.resolved", {
        availableToolCount: exposed.length,
        contextVersion: loaded.snapshot.contextVersion,
        runtimeMode: this.mode,
        boundary: "POLICY_GUARDED",
      });
      this.#throwIfSinkFailed(sinkFailed);
      const conflictDetector = new ContextConflictDetector();
      const confirmationIntents = new Set<string>();
      const providePolicyInput = async (
        definition: ToolDefinition,
        validatedArguments: unknown,
      ): Promise<PolicyEvaluationInput> => {
        const profile = this.#policyProfiles.get(definition.name);
        if (profile === undefined) throw new Error("Policy profile is unavailable");
        const evaluatedContext = definition.sideEffect ? await this.#contextLoader.load() : loaded;
        const conflict = definition.sideEffect
          ? conflictDetector.detect(
              loaded.snapshot,
              evaluatedContext.snapshot,
              profile.relevantContextPaths,
            )
          : undefined;
        const freshnessEvaluator = new ContextFreshnessEvaluator(this.#clock);
        const latestVersion = profile.freshnessRequirement.requiresLatest
          ? evaluatedContext.freshness.context.latestVersion
          : undefined;
        const freshness = selectEffectiveFreshness([
          freshnessEvaluator.evaluate(
            evaluatedContext.snapshot,
            profile.freshnessRequirement,
            latestVersion,
          ),
          freshnessEvaluator.evaluate(
            {
              ...evaluatedContext.snapshot,
              capturedAt: evaluatedContext.snapshot.vehicle.timestamp,
            },
            profile.freshnessRequirement,
            latestVersion,
          ),
          freshnessEvaluator.evaluate(
            {
              ...evaluatedContext.snapshot,
              capturedAt: evaluatedContext.snapshot.trip.timestamp,
            },
            profile.freshnessRequirement,
            latestVersion,
          ),
        ]);
        return {
          toolDefinition: definition,
          validatedArguments,
          trustedDefinition: true,
          contextSnapshot: evaluatedContext.snapshot,
          freshness,
          availability: {
            capabilities: evaluatedContext.snapshot.capabilities,
            services: evaluatedContext.services,
          },
          executionBinding: {
            runId: run.runId,
            sessionId: run.sessionId,
            traceId: run.traceId,
            actionFingerprint: createActionFingerprint({
              toolName: definition.name,
              validatedArguments,
              sessionId: run.sessionId,
              userId: evaluatedContext.snapshot.user.userId,
              vehicleId: evaluatedContext.snapshot.vehicle.vehicleId,
              contextSnapshotId: evaluatedContext.snapshot.snapshotId,
              contextVersion: evaluatedContext.snapshot.contextVersion,
            }),
          },
          ...(conflict === undefined ? {} : { conflict }),
        };
      };
      const policyGuard = new PolicyGuardedToolHandler({
        engine: this.#policyEngine,
        clock: this.#clock,
        isTrustedDefinition: (definition) => this.#toolRegistry.get(definition.name) === definition,
        inputProvider: providePolicyInput,
        observer: {
          evaluationStarted: async (toolName) => {
            await emitRuntime("policy.evaluation.started", {
              toolName,
              runtimeMode: this.mode,
              boundary: "POLICY_GUARDED",
            });
            this.#throwIfSinkFailed(sinkFailed);
          },
          decisionMade: async (policyDecision) => {
            evidence.policyDecisions.push(policyDecision);
            await emitRuntime("policy.decision.made", {
              toolName: policyDecision.toolName,
              decision: policyDecision.decision,
              ruleId: policyDecision.ruleId,
              reasonCode: policyDecision.reasonCode,
              ...(policyDecision.contextVersion === null
                ? {}
                : { contextVersion: policyDecision.contextVersion }),
              runtimeMode: this.mode,
              boundary: "POLICY_GUARDED",
            });
            this.#throwIfSinkFailed(sinkFailed);
          },
          executionBlocked: async (policyDecision) => {
            await emitRuntime("policy.execution.blocked", {
              toolName: policyDecision.toolName,
              decision: policyDecision.decision,
              ruleId: policyDecision.ruleId,
              ...(policyDecision.contextVersion === null
                ? {}
                : { contextVersion: policyDecision.contextVersion }),
              runtimeMode: this.mode,
              boundary: "POLICY_GUARDED",
            });
            this.#throwIfSinkFailed(sinkFailed);
          },
        },
        confirmationRequired: async (
          definition: ToolDefinition,
          validatedArguments: unknown,
          policyDecision: PolicyDecision,
          policyInput: PolicyEvaluationInput,
        ) => {
          throwIfSessionLeaseLost();
          const intentKey = createActionFingerprint({
            toolName: definition.name,
            validatedArguments,
            sessionId: run.sessionId,
            userId: policyInput.contextSnapshot.user.userId,
            vehicleId: policyInput.contextSnapshot.vehicle.vehicleId,
            contextSnapshotId: loaded.snapshot.snapshotId,
            contextVersion: loaded.snapshot.contextVersion,
          });
          if (confirmationIntents.has(intentKey)) return;
          confirmationIntents.add(intentKey);
          try {
            const created = await this.confirmationService.create({
              definition,
              validatedArguments,
              runId: run.runId,
              sessionId: run.sessionId,
              traceId: run.traceId,
              userId: policyInput.contextSnapshot.user.userId,
              vehicleId: policyInput.contextSnapshot.vehicle.vehicleId,
              policyDecision,
              contextSnapshot: policyInput.contextSnapshot,
            });
            try {
              await this.trustedConfirmationChallengeChannel.publish(created.trustedChallenge);
            } catch (error) {
              try {
                await this.confirmationService.cancel({
                  actionId: created.action.actionId,
                  sessionId: created.action.sessionId,
                  userId: created.action.userId,
                });
              } catch {
                // Preserve the original trusted-publication failure. cancel() transitions before emit.
              } finally {
                try {
                  this.trustedConfirmationChallengeChannel.discard(created.action.actionId);
                } catch {
                  // The original trusted-publication failure remains authoritative.
                }
              }
              throw error;
            }
            evidence.confirmationRequired.push(created.safeResult);
          } catch (error) {
            confirmationIntents.delete(intentKey);
            throw error;
          }
        },
        allowedExecution: async (definition, validatedArguments, policyDecision, policyInput) => {
          throwIfSessionLeaseLost();
          const actionFingerprint = createActionFingerprint({
            toolName: definition.name,
            validatedArguments,
            sessionId: run.sessionId,
            userId: policyInput.contextSnapshot.user.userId,
            vehicleId: policyInput.contextSnapshot.vehicle.vehicleId,
            contextSnapshotId: policyInput.contextSnapshot.snapshotId,
            contextVersion: policyInput.contextSnapshot.contextVersion,
          });
          reliableExecutionInFlight = true;
          const execution = await this.#reliableExecutor
            .execute({
              executionId: `execution:${randomUUID()}`,
              toolName: definition.name,
              validatedArguments,
              actionFingerprint,
              runId: run.runId,
              sessionId: run.sessionId,
              userId: policyInput.contextSnapshot.user.userId,
              vehicleId: policyInput.contextSnapshot.vehicle.vehicleId,
              traceId: run.traceId,
              riskLevel: definition.riskLevel,
              policyDecision,
              contextSnapshotId: policyInput.contextSnapshot.snapshotId,
              contextVersion: policyInput.contextSnapshot.contextVersion,
              idempotencyKey: `run:${run.runId}:${definition.name}:${actionFingerprint.slice(0, 24)}`,
              createdAt: toUtcTimestamp(this.#clock.nowMs()),
            })
            .finally(() => {
              reliableExecutionInFlight = false;
            });
          if (execution.recovery !== undefined) evidence.recoveryReceipts.push(execution.recovery);
          if (execution.status !== "SUCCEEDED") {
            throw new ToolExecutionError(
              execution.error?.code === "DEPENDENCY_TIMEOUT"
                ? "DEPENDENCY_TIMEOUT"
                : "DEPENDENCY_UNAVAILABLE",
              definition.name,
              execution.error?.message ?? "Reliable execution failed safely",
            );
          }
          reliableExecutionCommitted = true;
          return execution.result;
        },
      });
      for (const envelope of criticalEnvelopes) {
        if (envelope.supported && envelope.missingArguments.length > 0) continue;
        await emitRuntime("policy.evaluation.started", {
          toolName: envelope.toolMapping,
          runtimeMode: this.mode,
          boundary: "POLICY_GUARDED",
        });
        let precheckInput: unknown = {
          toolDefinition: { name: envelope.toolMapping },
          validatedArguments: envelope.knownArguments,
          trustedDefinition: false,
        };
        if (envelope.supported) {
          const definition = exposed.find((candidate) => candidate.name === envelope.toolMapping);
          if (definition !== undefined && envelope.missingArguments.length === 0) {
            precheckInput = await providePolicyInput(definition, envelope.knownArguments);
          }
        }
        const policyDecision = this.#policyEngine.evaluate(
          precheckInput,
          toUtcTimestamp(this.#clock.nowMs()),
        );
        evidence.policyDecisions.push(policyDecision);
        await emitRuntime("policy.decision.made", {
          toolName: policyDecision.toolName,
          decision: policyDecision.decision,
          ruleId: policyDecision.ruleId,
          reasonCode: policyDecision.reasonCode,
          ...(policyDecision.contextVersion === null
            ? {}
            : { contextVersion: policyDecision.contextVersion }),
          runtimeMode: this.mode,
          boundary: "POLICY_GUARDED",
        });
        this.#throwIfSinkFailed(sinkFailed);
      }
      toolAdapter = new PiToolAdapter(
        this.mode,
        (execution) => {
          evidence.toolExecutions.push(
            Object.freeze({
              toolName: execution.toolName,
              outcome: execution.outcome,
              completedAfterCancel: execution.completedAfterCancel,
              ...(execution.validatedArguments === undefined
                ? {}
                : { validatedArguments: structuredClone(execution.validatedArguments) }),
              ...(execution.result === undefined
                ? {}
                : { result: structuredClone(execution.result) }),
              ...(execution.policyControlResult === undefined
                ? {}
                : { policyControlResult: execution.policyControlResult }),
            }),
          );
        },
        policyGuard,
        (definition, proposed) =>
          new ToolArgumentBinder().bind(
            definition.name as FormalToolName,
            request.prompt,
            proposed,
          ),
      );
      session.setTools(toolAdapter.adaptAll(exposed));
      this.#throwIfCancelled(run);
      if (!reliableExecutionCommitted) throwIfSessionLeaseLost();

      run.transition("MODEL_RUNNING");
      await emitRuntime("model.started", {
        runtimeMode: this.mode,
        boundary: "POLICY_GUARDED",
      });
      this.#throwIfSinkFailed(sinkFailed);
      const piEvents = new PiEventAdapter({
        run,
        exposedToolNames: evidence.availableToolNames,
        boundary: "POLICY_GUARDED",
        eventFactory: {
          create: (eventType, _identity, metadata) => createEvent(eventType, metadata),
        },
        nowMs: () => this.#clock.nowMs(),
        emit: async (event) => {
          this.#throwIfRuntimeBoundaryFailed(runtimeBoundaryFailed);
          await emit(event);
          this.#throwIfSinkFailed(sinkFailed);
        },
        ...(this.#assistantTextDeltaSink === undefined
          ? {}
          : {
              assistantTextDelta: async (value: string) => {
                const delta = sanitizeRuntimeText(value, this.#sensitiveValues);
                if (delta.length > 0) {
                  await this.#assistantTextDeltaSink?.({
                    delta,
                    runId: run.runId,
                    sessionId: run.sessionId,
                    traceId: run.traceId,
                  });
                }
              },
            }),
        ...(this.#modelUsageSink === undefined
          ? {}
          : {
              modelUsage: async (usage) => {
                await this.#modelUsageSink?.({
                  ...usage,
                  runId: run.runId,
                  sessionId: run.sessionId,
                  traceId: run.traceId,
                });
              },
            }),
      });
      const unsubscribe = session.subscribe(piEvents.observe);
      try {
        await session.prompt(renderGoalBoundPrompt(goalPlan, request.prompt));
      } finally {
        unsubscribe();
      }

      const plannedToolNames = evidence.toolExecutions.map((execution) => execution.toolName);
      const completeness = criticalPathGuard.validate(criticalEnvelopes, plannedToolNames);
      if (completeness.status === "PLAN_INCOMPLETE") {
        let repairs;
        try {
          repairs = criticalPathGuard.constrainedRepair(criticalEnvelopes, plannedToolNames);
        } catch {
          throw new AgentRuntimeError(
            "TOOL_ERROR",
            "Critical plan is incomplete and cannot be repaired safely",
          );
        }
        if (repairs.length > 0) {
          if (run.status === "MODEL_RUNNING" || run.status === "MODEL_RESUMED") {
            run.transition("TOOL_REQUESTED");
            run.transition("TOOL_PROCESSING");
          }
          for (const [index, repair] of repairs.entries()) {
            const definition = exposed.find((candidate) => candidate.name === repair.toolName);
            if (definition === undefined) {
              throw new AgentRuntimeError("TOOL_ERROR", "Critical plan repair Tool is unavailable");
            }
            const toolCallId = `constrained-repair:${index + 1}`;
            await emitRuntime("tool.requested", {
              toolName: repair.toolName,
              toolCallId,
              planStatus: "PLAN_INCOMPLETE",
              runtimeMode: this.mode,
              boundary: "POLICY_GUARDED",
            });
            let repairError: unknown;
            try {
              await toolAdapter.adapt(definition).execute(toolCallId, repair.arguments);
            } catch (error) {
              repairError = error;
            }
            await emitRuntime("tool.completed", {
              toolName: repair.toolName,
              toolCallId,
              isError: repairError !== undefined,
              runtimeMode: this.mode,
              boundary: "POLICY_GUARDED",
            });
            if (repairError !== undefined && !(repairError instanceof PolicyControlError)) {
              throw new AgentRuntimeError("TOOL_ERROR", "Critical plan repair failed safely");
            }
          }
          if (run.status === "TOOL_PROCESSING") {
            run.transition("MODEL_RESUMED");
            await emitRuntime("model.resumed", {
              runtimeMode: this.mode,
              boundary: "POLICY_GUARDED",
            });
          }
        }
      }

      await toolAdapter.waitForIdle();
      this.#throwIfSinkFailed(sinkFailed);
      this.#throwIfCancelled(run);
      if (!reliableExecutionCommitted) throwIfSessionLeaseLost();
      const response = sanitizeRuntimeText(session.lastAssistantText(), this.#sensitiveValues);
      const sessionErrorMessage = session.errorMessage();
      if (sessionErrorMessage !== undefined) {
        throw new AgentRuntimeError(
          "MODEL_ERROR",
          sanitizeRuntimeText(sessionErrorMessage, this.#sensitiveValues),
          true,
        );
      }
      piEvents.assertComplete();
      const policyControl = evidence.toolExecutions.find(
        (execution) => execution.policyControlResult !== undefined,
      )?.policyControlResult;
      if (policyControl !== undefined) {
        throw new AgentRuntimeError(
          policyControl,
          this.#policyControlMessage(policyControl),
          policyControl === "POLICY_REPLAN_REQUIRED",
        );
      }
      if (piEvents.toolErrorCount > 0) {
        throw new AgentRuntimeError(
          "TOOL_ERROR",
          `${piEvents.toolErrorCount} formal Tool execution(s) failed`,
        );
      }
      if (run.status !== "MODEL_RUNNING" && run.status !== "MODEL_RESUMED") {
        throw new AgentRuntimeError(
          "INTERNAL_ERROR",
          "AgentRun did not return from model execution",
        );
      }
      if (!reliableExecutionCommitted) throwIfSessionLeaseLost();
      if (!(reliableExecutionCommitted && sessionLeaseLost)) {
        try {
          await this.#conversationMemory?.appendTurn({
            sessionId: request.sessionId,
            ownerId: run.runId,
            userMessageId: `message:${randomUUID()}`,
            userContent: sanitizeRuntimeText(request.prompt, this.#sensitiveValues),
            assistantMessageId: `message:${randomUUID()}`,
            assistantContent: response,
            createdAt: toUtcTimestamp(this.#clock.nowMs()),
          });
        } catch (error) {
          throw sessionPersistenceRuntimeError(error);
        }
      }
      if (!reliableExecutionCommitted) throwIfSessionLeaseLost();
      const completedEvent = createEvent("agent.run.completed", {
        runtimeMode: this.mode,
        boundary: "POLICY_GUARDED",
      });
      this.#throwIfRuntimeBoundaryFailed(runtimeBoundaryFailed);
      try {
        await this.#eventSink?.emit(completedEvent);
      } catch {
        sinkFailed = true;
      }
      this.#throwIfSinkFailed(sinkFailed);
      events.push(completedEvent);
      run.transition("RUN_SUCCEEDED");
      return this.#result("succeeded", response, run, events, evidence);
    } catch (error) {
      await toolAdapter?.waitForIdle();
      const cancelled = this.#cancelledRunIds.has(run.runId);
      const effectiveSessionLeaseLost = sessionLeaseLost && !reliableExecutionCommitted;
      const failure = effectiveSessionLeaseLost
        ? new AgentRuntimeError("SESSION_BUSY", "Durable session lease was lost")
        : cancelled
          ? new AgentRuntimeError("RUN_CANCELLED", "Agent run was cancelled")
          : safeRuntimeError(
              error,
              new AgentRuntimeError("INTERNAL_ERROR", "Agent runtime failed safely"),
              this.#sensitiveValues,
            );
      if (!run.isTerminal)
        run.transition(cancelled && !effectiveSessionLeaseLost ? "RUN_CANCELLED" : "RUN_FAILED");
      session.rollback(transcriptCheckpoint);
      await emit(
        createEvent("agent.run.failed", {
          errorCode: failure.code,
          runtimeMode: this.mode,
          boundary: "POLICY_GUARDED",
        }),
      );
      return this.#result(
        cancelled && !effectiveSessionLeaseLost ? "cancelled" : "failed",
        this.#safeFailureResponse(failure),
        run,
        events,
        evidence,
        failure.toFailure(),
      );
    } finally {
      this.#cancelledRunIds.delete(run.runId);
      session.trimHistory(this.#conversationHistoryLimit);
      session.release(run.runId);
      await Promise.allSettled([
        leaseHeartbeat.stop(),
        this.#sessionCoordinator?.release(request.sessionId, run.runId) ?? Promise.resolve(),
      ]);
    }
  }

  #startSessionLeaseHeartbeat(
    sessionId: string,
    ownerId: string,
    onLost: () => void,
  ): { readonly stop: () => Promise<void> } {
    const coordinator = this.#sessionCoordinator;
    const leaseDurationMs = coordinator?.leaseDurationMs;
    if (
      coordinator?.renew === undefined ||
      leaseDurationMs === undefined ||
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1
    ) {
      return { stop: () => Promise.resolve() };
    }
    const controller = new AbortController();
    const task = (async () => {
      const intervalMs = Math.max(1, Math.floor(leaseDurationMs / 4));
      while (!controller.signal.aborted) {
        try {
          await delay(intervalMs, undefined, { signal: controller.signal });
        } catch {
          return;
        }
        if (controller.signal.aborted) return;
        try {
          const renewal = coordinator.renew(sessionId, ownerId);
          const renewed = await Promise.race([
            renewal,
            delay(Math.max(1, Math.floor(leaseDurationMs / 4))).then(() => false),
          ]);
          if (!renewed) {
            onLost();
            return;
          }
        } catch {
          onLost();
          return;
        }
      }
    })();
    return {
      stop: async () => {
        controller.abort();
        await task;
      },
    };
  }

  #throwIfCancelled(run: AgentRun): void {
    if (this.#cancelledRunIds.has(run.runId)) {
      throw new AgentRuntimeError("RUN_CANCELLED", "Agent run was cancelled");
    }
  }

  #policyControlMessage(control: RuntimePolicyControlResult): string {
    switch (control) {
      case "POLICY_DENIED":
        return "Deterministic Policy denied Tool execution";
      case "POLICY_REPLAN_REQUIRED":
        return "Deterministic Policy requires a fresh plan";
      case "POLICY_CONFIRMATION_REQUIRED":
        return "Deterministic Policy requires the Phase 7 confirmation flow";
    }
  }

  #safeFailureResponse(failure: AgentRuntimeError): string {
    switch (failure.code) {
      case "POLICY_CONFIRMATION_REQUIRED":
        return "User confirmation is required before this action can proceed.";
      case "CONTEXT_LOAD_FAILED":
        return "Current vehicle or trip state is temporarily unavailable after a bounded retry. No action was executed, and the requested result cannot be confirmed.";
      case "TOOL_ERROR":
        return "The requested operation did not complete after bounded recovery. The system stopped safely and cannot confirm the result.";
      case "POLICY_DENIED":
        return "Deterministic safety policy denied the requested operation. No action was executed.";
      case "POLICY_REPLAN_REQUIRED":
        return "The current context changed or is stale. No action was executed; a fresh plan is required.";
      case "RUN_CANCELLED":
        return "The request was cancelled before completion. The result cannot be confirmed.";
      default:
        return "The request failed safely. No action was executed, and the current result cannot be confirmed.";
    }
  }

  #throwIfSinkFailed(sinkFailed: boolean): void {
    if (sinkFailed) {
      throw new AgentRuntimeError("INTERNAL_ERROR", "Runtime event delivery failed safely");
    }
  }

  #throwIfRuntimeBoundaryFailed(failed: boolean): void {
    if (failed) {
      throw new AgentRuntimeError(
        "INTERNAL_ERROR",
        "Runtime identity or Event factory failed safely",
      );
    }
  }

  #generateId(
    factory: () => string,
    prefix: string,
    issued: Set<string>,
  ): { readonly id: string; readonly failed: boolean } {
    try {
      const id = factory();
      if (typeof id !== "string" || !safeIdPattern.test(id) || issued.has(id)) {
        throw new AgentRuntimeError("INTERNAL_ERROR", "Runtime ID is invalid or duplicate");
      }
      rememberIssuedId(issued, id, ISSUED_RUN_ID_RETENTION);
      return { id, failed: false };
    } catch {
      let fallback = `${prefix}-fallback:${randomUUID()}`;
      while (issued.has(fallback)) fallback = `${prefix}-fallback:${randomUUID()}`;
      rememberIssuedId(issued, fallback, ISSUED_RUN_ID_RETENTION);
      return { id: fallback, failed: true };
    }
  }

  #result(
    status: AgentRunResult["status"],
    response: string,
    run: AgentRun,
    events: readonly RuntimeEvent[],
    evidence: MutableRunEvidence,
    error?: RuntimeFailure,
  ): AgentRunResult {
    return Object.freeze({
      status,
      response,
      run: run.snapshot(),
      events: Object.freeze([...events]),
      runtimeMode: this.mode,
      safetyNotice: PHASE_6_POLICY_NOTICE,
      availableToolNames: Object.freeze([...evidence.availableToolNames]),
      toolExecutions: Object.freeze(
        evidence.toolExecutions.map((execution) =>
          Object.freeze({
            toolName: execution.toolName,
            outcome: execution.outcome,
            completedAfterCancel: execution.completedAfterCancel,
            ...(execution.validatedArguments === undefined
              ? {}
              : { validatedArguments: structuredClone(execution.validatedArguments) }),
            ...(execution.result === undefined
              ? {}
              : { result: structuredClone(execution.result) }),
            ...(execution.policyControlResult === undefined
              ? {}
              : { policyControlResult: execution.policyControlResult }),
          }),
        ),
      ),
      policyDecisions: Object.freeze([...evidence.policyDecisions]),
      confirmationRequired: Object.freeze([...evidence.confirmationRequired]),
      recoveryReceipts: Object.freeze(
        evidence.recoveryReceipts.map((receipt) => Object.freeze(structuredClone(receipt))),
      ),
      ...(evidence.context === undefined ? {} : { context: evidence.context }),
      ...(error === undefined ? {} : { error }),
    });
  }
}
