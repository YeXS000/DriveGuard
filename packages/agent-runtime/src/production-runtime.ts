import { randomUUID } from "node:crypto";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { toUtcTimestamp, type ContextSnapshot } from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";
import {
  FORBIDDEN_TOOL_NAMES,
  FORMAL_TOOL_NAMES,
  type FormalToolName,
  type ToolDefinition,
  type ToolRegistry,
} from "@driveguard/tools";

import { AgentRun, type AgentRunSnapshot } from "./agent-run.js";
import { ContextLoader, type ContextFreshnessReport } from "./context-loader.js";
import { PiEventAdapter } from "./pi-event-adapter.js";
import {
  PHASE_5_PRE_POLICY_NOTICE,
  PiToolAdapter,
  type FormalToolExecutionEvidence,
  type Phase5RuntimeMode,
} from "./pi-tool-adapter.js";
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
  readonly safetyNotice: typeof PHASE_5_PRE_POLICY_NOTICE;
  readonly availableToolNames: readonly FormalToolName[];
  readonly toolExecutions: readonly FormalToolExecutionEvidence[];
  readonly context?: AgentRunContextSummary;
  readonly error?: RuntimeFailure;
}

interface MutableRunEvidence {
  context?: AgentRunContextSummary;
  availableToolNames: FormalToolName[];
  toolExecutions: FormalToolExecutionEvidence[];
}

export interface ProductionDriveGuardRuntime {
  readonly mode: Phase5RuntimeMode;
  readonly sessionCount: number;
  cancel(sessionId: string): boolean;
  sessionSnapshot(sessionId: string): AgentSessionSnapshot | undefined;
  sessionSnapshots(): readonly AgentSessionSnapshot[];
  run(request: AgentRunRequest): Promise<AgentRunResult>;
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
    this.#sessions = new AgentSessionStore(
      (sessionId) =>
        new AgentSession({
          sessionId,
          model: options.model,
          streamFn: options.streamFn,
          clock: options.clock,
        }),
    );
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

  get sessionCount(): number {
    return this.#sessions.size;
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
    const evidence: MutableRunEvidence = { availableToolNames: [], toolExecutions: [] };
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
        this.#issuedEventIds.add(event.eventId);
        return event;
      } catch {
        runtimeBoundaryFailed = true;
        const fallback = fallbackEventFactory.create(eventType, run, metadata);
        this.#issuedEventIds.add(fallback.eventId);
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
      boundary: "PRE_POLICY",
    });
    if (runtimeBoundaryFailed || sinkFailed) {
      const error = new AgentRuntimeError(
        "INTERNAL_ERROR",
        runtimeBoundaryFailed
          ? "Runtime identity or Event factory failed safely"
          : "Runtime event delivery failed safely",
      );
      run.transition("RUN_FAILED");
      await emit(
        createEvent("agent.run.failed", {
          errorCode: error.code,
          runtimeMode: this.mode,
          boundary: "PRE_POLICY",
        }),
      );
      return this.#result("failed", "", run, events, evidence, error.toFailure());
    }
    await emit(startedEvent);
    if (sinkFailed) {
      const error = new AgentRuntimeError("INTERNAL_ERROR", "Runtime event delivery failed safely");
      run.transition("RUN_FAILED");
      await emit(
        createEvent("agent.run.failed", {
          errorCode: error.code,
          runtimeMode: this.mode,
          boundary: "PRE_POLICY",
        }),
      );
      return this.#result("failed", "", run, events, evidence, error.toFailure());
    }

    const session = this.#sessions.getOrCreate(request.sessionId);
    if (!session.acquire(run)) {
      const error = new AgentRuntimeError(
        "SESSION_BUSY",
        "Agent session already has an active run",
      );
      run.transition("RUN_FAILED");
      await emit(
        createEvent("agent.run.failed", {
          errorCode: error.code,
          runtimeMode: this.mode,
          boundary: "PRE_POLICY",
        }),
      );
      return this.#result("failed", "", run, events, evidence, error.toFailure());
    }
    const transcriptCheckpoint = session.checkpoint();
    let toolAdapter: PiToolAdapter | undefined;

    try {
      run.transition("CONTEXT_LOADING");
      const loaded = await this.#contextLoader.load();
      run.attachContext(loaded.snapshot.snapshotId);
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
        boundary: "PRE_POLICY",
      });
      this.#throwIfSinkFailed(sinkFailed);
      if (loaded.freshness.status !== "FRESH") {
        throw new AgentRuntimeError(
          "CONTEXT_INVALID",
          `Current context freshness is ${loaded.freshness.status}`,
          loaded.freshness.status === "STALE",
        );
      }
      this.#throwIfCancelled(run);

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
      const exposed = definitions.filter((definition) =>
        this.mode === "read_only" ? definition.riskLevel === "R0" : true,
      );
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
        boundary: "PRE_POLICY",
      });
      this.#throwIfSinkFailed(sinkFailed);
      toolAdapter = new PiToolAdapter(this.mode, (execution) => {
        evidence.toolExecutions.push(
          Object.freeze({
            toolName: execution.toolName,
            outcome: execution.outcome,
            completedAfterCancel: execution.completedAfterCancel,
            ...(execution.result === undefined
              ? {}
              : { result: structuredClone(execution.result) }),
          }),
        );
      });
      session.setTools(toolAdapter.adaptAll(exposed));
      this.#throwIfCancelled(run);

      run.transition("MODEL_RUNNING");
      await emitRuntime("model.started", {
        runtimeMode: this.mode,
        boundary: "PRE_POLICY",
      });
      this.#throwIfSinkFailed(sinkFailed);
      const piEvents = new PiEventAdapter({
        run,
        exposedToolNames: evidence.availableToolNames,
        eventFactory: {
          create: (eventType, _identity, metadata) => createEvent(eventType, metadata),
        },
        emit: async (event) => {
          this.#throwIfRuntimeBoundaryFailed(runtimeBoundaryFailed);
          await emit(event);
          this.#throwIfSinkFailed(sinkFailed);
        },
      });
      const unsubscribe = session.subscribe(piEvents.observe);
      try {
        await session.prompt(request.prompt);
      } finally {
        unsubscribe();
      }

      await toolAdapter.waitForIdle();
      this.#throwIfSinkFailed(sinkFailed);
      this.#throwIfCancelled(run);
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
      const completedEvent = createEvent("agent.run.completed", {
        runtimeMode: this.mode,
        boundary: "PRE_POLICY",
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
      const failure = cancelled
        ? new AgentRuntimeError("RUN_CANCELLED", "Agent run was cancelled")
        : safeRuntimeError(
            error,
            new AgentRuntimeError("INTERNAL_ERROR", "Agent runtime failed safely"),
            this.#sensitiveValues,
          );
      if (!run.isTerminal) run.transition(cancelled ? "RUN_CANCELLED" : "RUN_FAILED");
      session.rollback(transcriptCheckpoint);
      await emit(
        createEvent("agent.run.failed", {
          errorCode: failure.code,
          runtimeMode: this.mode,
          boundary: "PRE_POLICY",
        }),
      );
      return this.#result(
        cancelled ? "cancelled" : "failed",
        "",
        run,
        events,
        evidence,
        failure.toFailure(),
      );
    } finally {
      this.#cancelledRunIds.delete(run.runId);
      session.release(run.runId);
    }
  }

  #throwIfCancelled(run: AgentRun): void {
    if (this.#cancelledRunIds.has(run.runId)) {
      throw new AgentRuntimeError("RUN_CANCELLED", "Agent run was cancelled");
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
      issued.add(id);
      return { id, failed: false };
    } catch {
      let fallback = `${prefix}-fallback:${randomUUID()}`;
      while (issued.has(fallback)) fallback = `${prefix}-fallback:${randomUUID()}`;
      issued.add(fallback);
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
      safetyNotice: PHASE_5_PRE_POLICY_NOTICE,
      availableToolNames: Object.freeze([...evidence.availableToolNames]),
      toolExecutions: Object.freeze(
        evidence.toolExecutions.map((execution) =>
          Object.freeze({
            toolName: execution.toolName,
            outcome: execution.outcome,
            completedAfterCancel: execution.completedAfterCancel,
            ...(execution.result === undefined
              ? {}
              : { result: structuredClone(execution.result) }),
          }),
        ),
      ),
      ...(evidence.context === undefined ? {} : { context: evidence.context }),
      ...(error === undefined ? {} : { error }),
    });
  }
}
