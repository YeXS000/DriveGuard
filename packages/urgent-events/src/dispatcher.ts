import { createHash, createHmac } from "node:crypto";

import {
  ConfirmationService,
  ContextRevalidator,
  createActionFingerprint,
  type ActionLifecycleEventSink,
  type PendingAction,
  type PendingActionRepository,
  type SafeConfirmationRequiredResult,
} from "@driveguard/action-lifecycle";
import { ContextLoader, selectEffectiveFreshness } from "@driveguard/agent-runtime";
import { ContextConflictDetector, ContextFreshnessEvaluator } from "@driveguard/context";
import { toUtcTimestamp, type ContextSnapshot } from "@driveguard/domain";
import type { ExecutionRequest, ExecutionResult, ReliableToolExecutor } from "@driveguard/executor";
import type { SessionCoordinator, SessionRepository } from "@driveguard/memory";
import {
  type PolicyDecision,
  type PolicyEngine,
  type PolicyEvaluationInput,
  type ToolPolicyProfileRegistry,
} from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import type { ToolRegistry } from "@driveguard/tools";
import Schema from "typebox/schema";

import { UrgentEventPermanentError, UrgentEventTransientError } from "./errors.js";
import type { UrgentEvent, UrgentEventSeverity } from "./model.js";
import {
  NOOP_URGENT_EVENT_OBSERVER,
  type UrgentEventObserver,
  type UrgentObservationType,
} from "./observer.js";
import type { UrgentActionCandidate } from "./planner.js";

export interface UrgentExecutionRecovery {
  get(executionId: string): Promise<
    | Readonly<{
        readonly request: ExecutionRequest;
        readonly result: ExecutionResult | null;
      }>
    | undefined
  >;
}

interface UrgentDispatchIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
}

export type UrgentActionDispatchResult =
  | Readonly<{
      readonly outcome: "EXECUTED";
      readonly policyDecision: PolicyDecision;
      readonly execution: ExecutionResult;
      readonly runId: string;
      readonly sessionId: string;
      readonly traceId: string;
      readonly toolName: string;
    }>
  | Readonly<{
      readonly outcome: "CONFIRMATION_REQUIRED";
      readonly policyDecision: PolicyDecision;
      readonly action: PendingAction;
      readonly safeResult: SafeConfirmationRequiredResult;
      readonly confirmationCredential: string;
      readonly runId: string;
      readonly sessionId: string;
      readonly traceId: string;
      readonly toolName: string;
    }>
  | Readonly<{
      readonly outcome: "DENIED" | "REPLAN_REQUIRED";
      readonly policyDecision: PolicyDecision;
      readonly runId: string;
      readonly sessionId: string;
      readonly traceId: string;
      readonly toolName: string;
    }>;

export interface UrgentActionDispatcherOptions {
  readonly contextLoader: ContextLoader;
  readonly registry: ToolRegistry;
  readonly policyEngine: PolicyEngine;
  readonly policyProfiles: ToolPolicyProfileRegistry;
  readonly pendingActionRepository: PendingActionRepository;
  readonly reliableExecutor: ReliableToolExecutor;
  readonly sessionRepository: SessionRepository;
  readonly sessionCoordinator: SessionCoordinator;
  readonly executionRecovery: UrgentExecutionRecovery;
  readonly clock: Clock;
  readonly userId: string;
  readonly confirmationSecret: string;
  readonly actionLifecycleEventSink?: ActionLifecycleEventSink;
  readonly observer?: UrgentEventObserver;
}

function stableId(prefix: string, value: string, length = 40): string {
  return `${prefix}:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, length)}`;
}

export class UrgentActionDispatcher {
  readonly #contextLoader: ContextLoader;
  readonly #registry: ToolRegistry;
  readonly #policyEngine: PolicyEngine;
  readonly #policyProfiles: ToolPolicyProfileRegistry;
  readonly #pendingActionRepository: PendingActionRepository;
  readonly #reliableExecutor: ReliableToolExecutor;
  readonly #sessionRepository: SessionRepository;
  readonly #sessionCoordinator: SessionCoordinator;
  readonly #executionRecovery: UrgentExecutionRecovery;
  readonly #clock: Clock;
  readonly #userId: string;
  readonly #confirmationSecret: string;
  readonly #actionLifecycleEventSink: ActionLifecycleEventSink | undefined;
  readonly #observer: UrgentEventObserver;

  constructor(options: UrgentActionDispatcherOptions) {
    if (options.confirmationSecret.length < 32) {
      throw new Error("URGENT_CONFIRMATION_SECRET must contain at least 32 characters");
    }
    this.#contextLoader = options.contextLoader;
    this.#registry = options.registry;
    this.#policyEngine = options.policyEngine;
    this.#policyProfiles = options.policyProfiles;
    this.#pendingActionRepository = options.pendingActionRepository;
    this.#reliableExecutor = options.reliableExecutor;
    this.#sessionRepository = options.sessionRepository;
    this.#sessionCoordinator = options.sessionCoordinator;
    this.#executionRecovery = options.executionRecovery;
    this.#clock = options.clock;
    this.#userId = options.userId;
    this.#confirmationSecret = options.confirmationSecret;
    this.#actionLifecycleEventSink = options.actionLifecycleEventSink;
    this.#observer = options.observer ?? NOOP_URGENT_EVENT_OBSERVER;
  }

  async dispatch(input: {
    readonly event: UrgentEvent;
    readonly severity: UrgentEventSeverity;
    readonly planningContext: ContextSnapshot;
    readonly candidate: UrgentActionCandidate;
  }): Promise<UrgentActionDispatchResult> {
    const identity = this.#identity(input.event);
    const definition = this.#registry.get(input.candidate.toolName);
    if (definition === undefined) {
      throw new UrgentEventPermanentError("Urgent candidate is not a registered formal Tool");
    }
    const profile = this.#policyProfiles.get(definition.name);
    if (profile === undefined) {
      throw new UrgentEventPermanentError("Urgent candidate has no Policy profile");
    }
    const args = structuredClone(input.candidate.arguments);
    if (!Schema.Compile(definition.inputSchema).Check(args)) {
      throw new UrgentEventPermanentError("Urgent candidate arguments failed Tool validation");
    }

    await this.#sessionRepository.bindIdentity({
      sessionId: identity.sessionId,
      userId: this.#userId,
      vehicleId: input.event.vehicleId,
      updatedAt: toUtcTimestamp(this.#clock.nowMs()),
    });

    const executionId = stableId("urgent-execution", input.event.eventId);
    const recovered = await this.#executionRecovery.get(executionId);
    if (recovered !== undefined) {
      if (recovered.result === null) {
        throw new UrgentEventTransientError("Existing urgent execution is not terminal");
      }
      if (
        recovered.request.toolName !== definition.name ||
        recovered.request.sessionId !== identity.sessionId ||
        recovered.request.vehicleId !== input.event.vehicleId
      ) {
        throw new UrgentEventPermanentError("Existing urgent execution binding conflicts");
      }
      if (recovered.result.status !== "SUCCEEDED") {
        throw new UrgentEventTransientError("Existing urgent execution did not succeed");
      }
      return Object.freeze({
        outcome: "EXECUTED",
        policyDecision: recovered.request.policyDecision,
        execution: recovered.result,
        ...identity,
        toolName: definition.name,
      });
    }

    this.#observe("urgent.context.load.started", input, identity, "PROCESSING", {
      toolName: definition.name,
    });
    let current;
    try {
      current = await this.#contextLoader.load();
    } catch (error) {
      throw new UrgentEventTransientError("Current Context could not be refreshed", {
        cause: error,
      });
    }
    this.#observe("urgent.context.load.completed", input, identity, "PROCESSING", {
      toolName: definition.name,
    });
    if (current.snapshot.vehicle.vehicleId !== input.event.vehicleId) {
      throw new UrgentEventPermanentError("Urgent event vehicle does not match current Context");
    }

    const conflict = definition.sideEffect
      ? new ContextConflictDetector().detect(
          input.planningContext,
          current.snapshot,
          profile.relevantContextPaths,
        )
      : undefined;
    const latestVersion = profile.freshnessRequirement.requiresLatest
      ? current.freshness.context.latestVersion
      : undefined;
    const freshnessEvaluator = new ContextFreshnessEvaluator(this.#clock);
    const freshness = selectEffectiveFreshness([
      freshnessEvaluator.evaluate(current.snapshot, profile.freshnessRequirement, latestVersion),
      freshnessEvaluator.evaluate(
        { ...current.snapshot, capturedAt: current.snapshot.vehicle.timestamp },
        profile.freshnessRequirement,
        latestVersion,
      ),
      freshnessEvaluator.evaluate(
        { ...current.snapshot, capturedAt: current.snapshot.trip.timestamp },
        profile.freshnessRequirement,
        latestVersion,
      ),
    ]);
    const actionFingerprint = createActionFingerprint({
      toolName: definition.name,
      validatedArguments: args,
      sessionId: identity.sessionId,
      userId: this.#userId,
      vehicleId: input.event.vehicleId,
      contextSnapshotId: current.snapshot.snapshotId,
      contextVersion: current.snapshot.contextVersion,
    });
    const policyInput: PolicyEvaluationInput = {
      toolDefinition: definition,
      validatedArguments: args,
      trustedDefinition: this.#registry.get(definition.name) === definition,
      contextSnapshot: current.snapshot,
      freshness,
      availability: {
        capabilities: current.snapshot.capabilities,
        services: current.services,
      },
      executionBinding: {
        runId: identity.runId,
        sessionId: identity.sessionId,
        traceId: identity.traceId,
        actionFingerprint,
      },
      ...(conflict === undefined ? {} : { conflict }),
    };
    this.#observe("urgent.policy.evaluate.started", input, identity, "PROCESSING", {
      toolName: definition.name,
    });
    const policyDecision = this.#policyEngine.evaluate(
      policyInput,
      toUtcTimestamp(this.#clock.nowMs()),
    );
    this.#observe("urgent.policy.evaluate.completed", input, identity, "PROCESSING", {
      toolName: definition.name,
      policyDecision: policyDecision.decision,
    });

    if (policyDecision.decision === "DENY" || policyDecision.decision === "REPLAN") {
      return Object.freeze({
        outcome: policyDecision.decision === "DENY" ? "DENIED" : "REPLAN_REQUIRED",
        policyDecision,
        ...identity,
        toolName: definition.name,
      });
    }
    if (policyDecision.decision === "REQUIRE_CONFIRMATION") {
      const confirmation = await this.#createOrRecoverConfirmation({
        event: input.event,
        definition,
        args,
        policyDecision,
        context: current.snapshot,
        identity,
      });
      this.#observe("urgent.confirmation.required", input, identity, "HANDLED", {
        toolName: definition.name,
        actionId: confirmation.action.actionId,
        policyDecision: policyDecision.decision,
      });
      return Object.freeze({
        outcome: "CONFIRMATION_REQUIRED",
        policyDecision,
        ...confirmation,
        ...identity,
        toolName: definition.name,
      });
    }

    const coordinated = await this.#sessionCoordinator.acquire(identity.sessionId, identity.runId);
    if (!coordinated) throw new UrgentEventTransientError("Urgent event session is busy");
    try {
      this.#observe("urgent.executor.started", input, identity, "PROCESSING", {
        toolName: definition.name,
        executionId,
        policyDecision: policyDecision.decision,
      });
      const execution = await this.#reliableExecutor.execute({
        executionId,
        toolName: definition.name,
        validatedArguments: args,
        actionFingerprint,
        runId: identity.runId,
        sessionId: identity.sessionId,
        userId: this.#userId,
        vehicleId: input.event.vehicleId,
        traceId: identity.traceId,
        riskLevel: definition.riskLevel,
        policyDecision,
        contextSnapshotId: current.snapshot.snapshotId,
        contextVersion: current.snapshot.contextVersion,
        idempotencyKey: stableId("urgent-idempotency", input.event.eventId),
        createdAt: toUtcTimestamp(this.#clock.nowMs()),
      });
      this.#observe("urgent.executor.completed", input, identity, "PROCESSING", {
        toolName: definition.name,
        executionId,
        policyDecision: policyDecision.decision,
        ...(execution.status === "SUCCEEDED" || execution.error?.code === undefined
          ? {}
          : { errorCode: execution.error.code }),
      });
      if (execution.status !== "SUCCEEDED") {
        throw new UrgentEventTransientError("Reliable Executor did not complete successfully");
      }
      return Object.freeze({
        outcome: "EXECUTED",
        policyDecision,
        execution,
        ...identity,
        toolName: definition.name,
      });
    } finally {
      await this.#sessionCoordinator.release(identity.sessionId, identity.runId);
    }
  }

  async #createOrRecoverConfirmation(input: {
    readonly event: UrgentEvent;
    readonly definition: NonNullable<ReturnType<ToolRegistry["get"]>>;
    readonly args: unknown;
    readonly policyDecision: PolicyDecision;
    readonly context: ContextSnapshot;
    readonly identity: UrgentDispatchIdentity;
  }): Promise<
    Readonly<{
      readonly action: PendingAction;
      readonly safeResult: SafeConfirmationRequiredResult;
      readonly confirmationCredential: string;
    }>
  > {
    const actionId = stableId("urgent-action", input.event.eventId);
    const confirmationCredential = createHmac("sha256", this.#confirmationSecret)
      .update(actionId, "utf8")
      .digest("base64url");
    let eventSequence = 0;
    const service = new ConfirmationService({
      clock: this.#clock,
      repository: this.#pendingActionRepository,
      ...(this.#actionLifecycleEventSink === undefined
        ? {}
        : { eventSink: this.#actionLifecycleEventSink }),
      isTrustedDefinition: (definition) => this.#registry.get(definition.name) === definition,
      actionIdFactory: () => actionId,
      confirmationIdFactory: () => stableId("urgent-confirmation", input.event.eventId),
      authorizationIdFactory: () => stableId("urgent-authorization", input.event.eventId),
      eventIdFactory: () =>
        `${stableId("urgent-action-event", input.event.eventId, 32)}:${eventSequence++}`,
      tokenGenerator: () => confirmationCredential,
      revalidator: new ContextRevalidator({
        freshnessEvaluator: new ContextFreshnessEvaluator(this.#clock),
        profiles: this.#policyProfiles,
        definitionProvider: (toolName) => this.#registry.get(toolName),
        currentContextProvider: async () => {
          const current = await this.#contextLoader.load();
          return {
            snapshot: current.snapshot,
            latestContextVersion: current.freshness.context.latestVersion,
            availability: {
              capabilities: current.snapshot.capabilities,
              services: current.services,
            },
          };
        },
      }),
    });
    const existing = await service.get(actionId);
    if (existing !== undefined) {
      this.#validateRecoveredAction(existing, input);
      return Object.freeze({
        action: existing,
        safeResult: Object.freeze({
          actionId,
          toolName: existing.toolName,
          riskLevel: existing.riskLevel,
          expiresAt: existing.expiresAt,
          summary: existing.confirmationSummary,
        }),
        confirmationCredential,
      });
    }
    try {
      const created = await service.create({
        definition: input.definition,
        validatedArguments: input.args,
        runId: input.identity.runId,
        sessionId: input.identity.sessionId,
        traceId: input.identity.traceId,
        userId: this.#userId,
        vehicleId: input.event.vehicleId,
        policyDecision: input.policyDecision,
        contextSnapshot: input.context,
      });
      return Object.freeze({
        action: created.action,
        safeResult: created.safeResult,
        confirmationCredential,
      });
    } catch (error) {
      const recovered = await service.get(actionId);
      if (recovered === undefined) throw error;
      this.#validateRecoveredAction(recovered, input);
      return Object.freeze({
        action: recovered,
        safeResult: Object.freeze({
          actionId,
          toolName: recovered.toolName,
          riskLevel: recovered.riskLevel,
          expiresAt: recovered.expiresAt,
          summary: recovered.confirmationSummary,
        }),
        confirmationCredential,
      });
    }
  }

  #validateRecoveredAction(
    action: PendingAction,
    input: {
      readonly event: UrgentEvent;
      readonly definition: NonNullable<ReturnType<ToolRegistry["get"]>>;
      readonly identity: UrgentDispatchIdentity;
    },
  ): void {
    if (
      action.state !== "AWAITING_CONFIRMATION" ||
      action.toolName !== input.definition.name ||
      action.sessionId !== input.identity.sessionId ||
      action.userId !== this.#userId ||
      action.vehicleId !== input.event.vehicleId
    ) {
      throw new UrgentEventPermanentError("Recovered urgent action binding conflicts");
    }
  }

  #identity(event: UrgentEvent): Readonly<UrgentDispatchIdentity> {
    return Object.freeze({
      runId: stableId("urgent-run", event.eventId),
      sessionId: stableId("urgent-session", event.eventId),
      traceId: createHash("sha256").update(event.correlationId, "utf8").digest("hex").slice(0, 32),
    });
  }

  #observe(
    observationType: UrgentObservationType,
    input: { readonly event: UrgentEvent; readonly severity: UrgentEventSeverity },
    identity: { readonly runId: string; readonly traceId: string },
    status: "PROCESSING" | "HANDLED",
    details: Readonly<{
      toolName?: string;
      actionId?: string;
      executionId?: string;
      policyDecision?: PolicyDecision["decision"];
      errorCode?: string;
    }> = {},
  ): void {
    this.#observer.observe({
      observationType,
      eventId: input.event.eventId,
      eventType: input.event.eventType,
      severity: input.severity,
      status,
      runId: identity.runId,
      traceId: identity.traceId,
      timestamp: toUtcTimestamp(this.#clock.nowMs()),
      ...details,
    });
  }
}
