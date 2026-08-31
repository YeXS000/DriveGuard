import { createHash, randomUUID } from "node:crypto";

import { ContextLoader } from "@driveguard/agent-runtime";
import { toUtcTimestamp } from "@driveguard/domain";
import type { Clock } from "@driveguard/shared";

import { UrgentEventClassifier } from "./classifier.js";
import type { UrgentActionDispatcher, UrgentActionDispatchResult } from "./dispatcher.js";
import {
  UrgentEventPermanentError,
  UrgentEventTransientError,
  UrgentEventValidationError,
} from "./errors.js";
import {
  parseUrgentEvent,
  readRejectableEventIdentity,
  type UrgentEvent,
  type UrgentEventSeverity,
} from "./model.js";
import type { UrgentEventNotification, UrgentEventNotificationSink } from "./notifications.js";
import {
  NOOP_URGENT_EVENT_OBSERVER,
  type UrgentEventObserver,
  type UrgentObservationType,
} from "./observer.js";
import { UrgentEventPlanner } from "./planner.js";
import type {
  UrgentEventRecord,
  UrgentEventRepository,
  UrgentEventResultMetadata,
  UrgentEventStatus,
} from "./repository.js";

export interface UrgentEventProcessingResult {
  readonly disposition: "HANDLED" | "DUPLICATE" | "REJECTED" | "REPLAN_REQUIRED";
  readonly record?: UrgentEventRecord;
  readonly invalidEventId?: string;
}

export interface UrgentContextLoaderPort {
  load(): ReturnType<ContextLoader["load"]>;
}

export interface UrgentActionDispatchPort {
  dispatch(
    input: Parameters<UrgentActionDispatcher["dispatch"]>[0],
  ): Promise<UrgentActionDispatchResult>;
}

export interface UrgentEventProcessorOptions {
  readonly repository: UrgentEventRepository;
  readonly contextLoader: UrgentContextLoaderPort;
  readonly dispatcher: UrgentActionDispatchPort;
  readonly clock: Clock;
  readonly userId: string;
  readonly notificationSink?: UrgentEventNotificationSink;
  readonly observer?: UrgentEventObserver;
  readonly classifier?: UrgentEventClassifier;
  readonly planner?: UrgentEventPlanner;
  readonly claimLeaseMs?: number;
  readonly ownerIdFactory?: () => string;
}

function stableIdentity(event: UrgentEvent): Readonly<{ runId: string; traceId: string }> {
  return Object.freeze({
    runId: `urgent-run:${createHash("sha256")
      .update(event.eventId, "utf8")
      .digest("hex")
      .slice(0, 40)}`,
    traceId: createHash("sha256").update(event.correlationId, "utf8").digest("hex").slice(0, 32),
  });
}

export class UrgentEventProcessor {
  readonly #repository: UrgentEventRepository;
  readonly #contextLoader: UrgentContextLoaderPort;
  readonly #dispatcher: UrgentActionDispatchPort;
  readonly #clock: Clock;
  readonly #userId: string;
  readonly #notificationSink: UrgentEventNotificationSink | undefined;
  readonly #observer: UrgentEventObserver;
  readonly #classifier: UrgentEventClassifier;
  readonly #planner: UrgentEventPlanner;
  readonly #claimLeaseMs: number;
  readonly #ownerIdFactory: () => string;

  constructor(options: UrgentEventProcessorOptions) {
    this.#repository = options.repository;
    this.#contextLoader = options.contextLoader;
    this.#dispatcher = options.dispatcher;
    this.#clock = options.clock;
    this.#userId = options.userId;
    this.#notificationSink = options.notificationSink;
    this.#observer = options.observer ?? NOOP_URGENT_EVENT_OBSERVER;
    this.#classifier = options.classifier ?? new UrgentEventClassifier();
    this.#planner = options.planner ?? new UrgentEventPlanner();
    this.#claimLeaseMs = options.claimLeaseMs ?? 30_000;
    this.#ownerIdFactory = options.ownerIdFactory ?? (() => `urgent-owner:${randomUUID()}`);
  }

  async process(input: unknown): Promise<UrgentEventProcessingResult> {
    let event: UrgentEvent;
    try {
      event = parseUrgentEvent(input);
    } catch (error) {
      if (!(error instanceof UrgentEventValidationError)) throw error;
      return this.#rejectInvalid(input);
    }
    const severity = this.#classifier.classify(event);
    const identity = stableIdentity(event);
    const ownerId = this.#ownerIdFactory();
    let claim;
    try {
      claim = await this.#repository.claim({
        event,
        severity,
        ownerId,
        now: toUtcTimestamp(this.#clock.nowMs()),
        leaseMs: this.#claimLeaseMs,
      });
    } catch (error) {
      throw new UrgentEventTransientError("Durable urgent-event ownership is unavailable", {
        cause: error,
      });
    }
    if (claim.kind === "CONFLICT") {
      this.#observe("urgent.event.rejected", event, severity, claim.record.status, identity, {
        errorCode: "URGENT_EVENT_ID_CONFLICT",
      });
      return Object.freeze({ disposition: "REJECTED", invalidEventId: event.eventId });
    }
    if (claim.kind === "DUPLICATE") {
      this.#observe("urgent.event.duplicate", event, severity, claim.record.status, identity);
      if (claim.record.status === "PROCESSING") {
        const expiresAt = claim.record.processingExpiresAt;
        const retryDelayMs =
          expiresAt === null
            ? this.#claimLeaseMs
            : Math.max(100, Date.parse(expiresAt) - this.#clock.nowMs() + 100);
        throw new UrgentEventTransientError(
          "Urgent event is owned by an active or recoverable processor",
          { retryDelayMs },
        );
      }
      return Object.freeze({ disposition: "DUPLICATE", record: claim.record });
    }

    this.#observe("urgent.event.received", event, severity, "PROCESSING", identity);
    await this.#notify(event, severity, identity, {
      notificationType: "urgent.received",
      status: "PROCESSING",
      safeSummary: "Urgent vehicle event received and accepted for safe processing.",
    });

    try {
      let loaded;
      try {
        loaded = await this.#contextLoader.load();
      } catch {
        const record = await this.#complete(event, ownerId, "REPLAN_REQUIRED", {
          safeSummary: "Current Context is unavailable; no Tool was executed.",
          resultCode: "CONTEXT_UNAVAILABLE",
        });
        this.#observe("urgent.event.failed", event, severity, record.status, identity, {
          errorCode: "CONTEXT_UNAVAILABLE",
        });
        await this.#notify(event, severity, identity, {
          notificationType: "urgent.failed",
          status: record.status,
          safeSummary: record.result.safeSummary,
        });
        return Object.freeze({ disposition: "REPLAN_REQUIRED", record });
      }
      if (loaded.snapshot.vehicle.vehicleId !== event.vehicleId) {
        throw new UrgentEventPermanentError("Event vehicle does not match refreshed Context");
      }
      const plan = this.#planner.plan(event, severity, loaded.snapshot);
      if (plan.disposition === "RESOLVED") {
        const record = await this.#complete(event, ownerId, "HANDLED", {
          safeSummary: plan.safeSummary,
          requiresConfirmation: false,
          resultCode: "NO_ACTION_REQUIRED",
        });
        this.#observe("urgent.event.processed", event, severity, record.status, identity);
        await this.#notify(event, severity, identity, {
          notificationType: "urgent.resolved",
          status: record.status,
          safeSummary: plan.safeSummary,
        });
        return Object.freeze({ disposition: "HANDLED", record });
      }
      if (plan.disposition === "REPLAN_REQUIRED" || plan.candidate === undefined) {
        const record = await this.#complete(event, ownerId, "REPLAN_REQUIRED", {
          safeSummary: plan.safeSummary,
          resultCode: "REPLAN_REQUIRED",
        });
        this.#observe("urgent.event.processed", event, severity, record.status, identity);
        await this.#notify(event, severity, identity, {
          notificationType: "urgent.action_required",
          status: record.status,
          safeSummary: plan.safeSummary,
        });
        return Object.freeze({ disposition: "REPLAN_REQUIRED", record });
      }

      const dispatched = await this.#dispatcher.dispatch({
        event,
        severity,
        planningContext: loaded.snapshot,
        candidate: plan.candidate,
      });
      if (dispatched.outcome === "DENIED" || dispatched.outcome === "REPLAN_REQUIRED") {
        const status = dispatched.outcome === "DENIED" ? "REJECTED" : "REPLAN_REQUIRED";
        const record = await this.#complete(event, ownerId, status, {
          safeSummary:
            dispatched.outcome === "DENIED"
              ? "Policy denied the candidate action; no Tool was executed."
              : "Policy requires replanning against refreshed Context; no Tool was executed.",
          toolName: dispatched.toolName,
          policyDecision: dispatched.policyDecision.decision,
          resultCode: dispatched.policyDecision.reasonCode,
        });
        this.#observe("urgent.event.processed", event, severity, record.status, identity, {
          toolName: dispatched.toolName,
          policyDecision: dispatched.policyDecision.decision,
        });
        await this.#notify(event, severity, identity, {
          notificationType:
            dispatched.outcome === "DENIED" ? "urgent.failed" : "urgent.action_required",
          status: record.status,
          safeSummary: record.result.safeSummary,
          toolName: dispatched.toolName,
        });
        return Object.freeze({
          disposition: dispatched.outcome === "DENIED" ? "REJECTED" : "REPLAN_REQUIRED",
          record,
        });
      }
      if (dispatched.outcome === "CONFIRMATION_REQUIRED") {
        const record = await this.#complete(event, ownerId, "HANDLED", {
          safeSummary: plan.safeSummary,
          toolName: dispatched.toolName,
          policyDecision: dispatched.policyDecision.decision,
          actionId: dispatched.action.actionId,
          requiresConfirmation: true,
          resultCode: dispatched.policyDecision.reasonCode,
        });
        this.#observe("urgent.event.processed", event, severity, record.status, identity, {
          toolName: dispatched.toolName,
          actionId: dispatched.action.actionId,
          policyDecision: dispatched.policyDecision.decision,
        });
        await this.#notify(event, severity, identity, {
          notificationType: "urgent.confirmation_required",
          status: record.status,
          safeSummary: plan.safeSummary,
          actionId: dispatched.action.actionId,
          sessionId: dispatched.action.sessionId,
          toolName: dispatched.toolName,
          riskLevel: dispatched.action.riskLevel,
          expiresAt: dispatched.action.expiresAt,
          confirmationCredential: dispatched.confirmationCredential,
        });
        return Object.freeze({ disposition: "HANDLED", record });
      }

      if (dispatched.outcome !== "EXECUTED") {
        throw new UrgentEventPermanentError("Urgent dispatch returned an invalid outcome");
      }

      const record = await this.#complete(event, ownerId, "HANDLED", {
        safeSummary: plan.safeSummary,
        toolName: dispatched.toolName,
        policyDecision: dispatched.policyDecision.decision,
        executionId: dispatched.execution.executionId,
        requiresConfirmation: false,
        resultCode: dispatched.execution.status,
      });
      this.#observe("urgent.event.processed", event, severity, record.status, identity, {
        toolName: dispatched.toolName,
        executionId: dispatched.execution.executionId,
        policyDecision: dispatched.policyDecision.decision,
      });
      await this.#notify(event, severity, identity, {
        notificationType: "urgent.resolved",
        status: record.status,
        safeSummary: plan.safeSummary,
        toolName: dispatched.toolName,
      });
      return Object.freeze({ disposition: "HANDLED", record });
    } catch (error) {
      if (error instanceof UrgentEventPermanentError) {
        const record = await this.#complete(event, ownerId, "REJECTED", {
          safeSummary: "Urgent event was blocked permanently before Tool execution.",
          resultCode: error.code,
        });
        this.#observe("urgent.event.rejected", event, severity, record.status, identity, {
          errorCode: error.code,
        });
        await this.#notify(event, severity, identity, {
          notificationType: "urgent.failed",
          status: record.status,
          safeSummary: record.result.safeSummary,
        });
        return Object.freeze({ disposition: "REJECTED", record });
      }
      try {
        await this.#complete(event, ownerId, "FAILED", {
          safeSummary: "Urgent event processing failed safely; no blind execution was permitted.",
          resultCode:
            error instanceof UrgentEventTransientError
              ? error.code
              : "URGENT_EVENT_INTERNAL_FAILURE",
        });
      } catch {
        // The original transient failure remains authoritative and will be redelivered.
      }
      this.#observe("urgent.event.failed", event, severity, "FAILED", identity, {
        errorCode:
          error instanceof UrgentEventTransientError ? error.code : "URGENT_EVENT_INTERNAL_FAILURE",
      });
      if (error instanceof UrgentEventTransientError) throw error;
      throw new UrgentEventTransientError("Urgent event processing failed safely", {
        cause: error,
      });
    }
  }

  async #rejectInvalid(input: unknown): Promise<UrgentEventProcessingResult> {
    const identity = readRejectableEventIdentity(input);
    if (identity === undefined) {
      return Object.freeze({ disposition: "REJECTED" });
    }
    let record: UrgentEventRecord | undefined;
    try {
      record = await this.#repository.rejectInvalid({
        ...identity,
        receivedAt: toUtcTimestamp(Date.parse(identity.receivedAt)),
        processedAt: toUtcTimestamp(this.#clock.nowMs()),
        resultCode: "URGENT_EVENT_INVALID",
      });
    } catch {
      // A DLQ record remains possible even if PostgreSQL is unavailable for invalid input.
    }
    const traceId = createHash("sha256")
      .update(identity.correlationId, "utf8")
      .digest("hex")
      .slice(0, 32);
    this.#observer.observe({
      observationType: "urgent.event.rejected",
      eventId: identity.eventId,
      eventType: "UNKNOWN",
      severity: "WARNING",
      status: "REJECTED",
      runId: `urgent-invalid:${identity.eventId}`,
      traceId,
      timestamp: toUtcTimestamp(this.#clock.nowMs()),
      errorCode: "URGENT_EVENT_INVALID",
    });
    return Object.freeze({
      disposition: "REJECTED",
      ...(record === undefined ? {} : { record }),
      invalidEventId: identity.eventId,
    });
  }

  #complete(
    event: UrgentEvent,
    ownerId: string,
    status: Exclude<UrgentEventStatus, "RECEIVED" | "PROCESSING">,
    result: UrgentEventResultMetadata,
  ): Promise<UrgentEventRecord> {
    return this.#repository.complete({
      eventId: event.eventId,
      ownerId,
      status,
      processedAt: toUtcTimestamp(this.#clock.nowMs()),
      result,
    });
  }

  #observe(
    observationType: UrgentObservationType,
    event: UrgentEvent,
    severity: UrgentEventSeverity,
    status: UrgentEventStatus,
    identity: { readonly runId: string; readonly traceId: string },
    details: Readonly<{
      toolName?: string;
      actionId?: string;
      executionId?: string;
      policyDecision?: "ALLOW" | "DENY" | "REQUIRE_CONFIRMATION" | "REPLAN";
      errorCode?: string;
    }> = {},
  ): void {
    this.#observer.observe({
      observationType,
      eventId: event.eventId,
      eventType: event.eventType,
      severity,
      status,
      runId: identity.runId,
      traceId: identity.traceId,
      timestamp: toUtcTimestamp(this.#clock.nowMs()),
      ...details,
    });
  }

  async #notify(
    event: UrgentEvent,
    severity: UrgentEventSeverity,
    identity: { readonly runId: string; readonly traceId: string },
    details: Omit<
      UrgentEventNotification,
      | "notificationId"
      | "eventId"
      | "eventType"
      | "vehicleId"
      | "userId"
      | "severity"
      | "runId"
      | "traceId"
      | "timestamp"
    >,
  ): Promise<void> {
    await this.#notificationSink?.emit(
      Object.freeze({
        notificationId: `urgent-notification:${randomUUID()}`,
        eventId: event.eventId,
        eventType: event.eventType,
        vehicleId: event.vehicleId,
        userId: this.#userId,
        severity,
        runId: identity.runId,
        traceId: identity.traceId,
        timestamp: toUtcTimestamp(this.#clock.nowMs()),
        ...details,
      }),
    );
  }
}
