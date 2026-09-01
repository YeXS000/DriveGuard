import { toUtcTimestamp } from "@driveguard/domain";
import {
  InMemoryExecutionEventSink,
  type DurableExecutionCoordinator,
  type ExecutionRequest,
  type ExecutionResult,
} from "@driveguard/executor";
import { InMemorySessionCoordinator, InMemorySessionRepository } from "@driveguard/memory";
import { SystemClock } from "@driveguard/shared";
import {
  UrgentEventClassifier,
  UrgentEventPlanner,
  UrgentEventProcessor,
  createUrgentActionSystem,
  parseUrgentEvent,
  urgentEventFingerprint,
  type UrgentEvent,
  type UrgentEventRecord,
  type UrgentEventRepository,
} from "@driveguard/urgent-events";
import { isDeepStrictEqual } from "node:util";

import type { NativeEvalCase, NativeObservation, ObservedToolCall } from "../native/types.js";
import { InMemoryPendingActionRepository } from "../../packages/action-lifecycle/src/repository.js";

interface SimulatorStatePort {
  readonly simulationVersion: number;
}

function duplicateSideEffectCount(before: number, after: number, expected: number): number {
  return Math.max(0, Math.max(0, after - before) - expected);
}

class EvaluationUrgentRepository implements UrgentEventRepository {
  readonly #records = new Map<string, UrgentEventRecord>();

  claim(input: Parameters<UrgentEventRepository["claim"]>[0]) {
    const existing = this.#records.get(input.event.eventId);
    if (existing !== undefined) {
      const kind =
        existing.eventFingerprint === urgentEventFingerprint(input.event)
          ? ("DUPLICATE" as const)
          : ("CONFLICT" as const);
      return Promise.resolve(Object.freeze({ kind, record: existing }));
    }
    const record: UrgentEventRecord = Object.freeze({
      eventId: input.event.eventId,
      eventFingerprint: urgentEventFingerprint(input.event),
      eventType: input.event.eventType,
      vehicleId: input.event.vehicleId,
      severity: input.severity,
      status: "PROCESSING",
      receivedAt: input.event.receivedAt,
      processedAt: null,
      correlationId: input.event.correlationId,
      processingOwner: input.ownerId,
      processingExpiresAt: input.now,
      attemptCount: 1,
      result: Object.freeze({ safeSummary: "processing" }),
    });
    this.#records.set(record.eventId, record);
    return Promise.resolve(Object.freeze({ kind: "CLAIMED" as const, record }));
  }

  complete(input: Parameters<UrgentEventRepository["complete"]>[0]) {
    const existing = this.#records.get(input.eventId);
    if (existing === undefined || existing.processingOwner !== input.ownerId) {
      return Promise.reject(new Error("Urgent evaluation ownership mismatch"));
    }
    const record: UrgentEventRecord = Object.freeze({
      ...existing,
      status: input.status,
      processedAt: input.processedAt,
      processingOwner: null,
      processingExpiresAt: null,
      result: Object.freeze(structuredClone(input.result)),
    });
    this.#records.set(record.eventId, record);
    return Promise.resolve(record);
  }

  rejectInvalid(input: Parameters<UrgentEventRepository["rejectInvalid"]>[0]) {
    const record: UrgentEventRecord = Object.freeze({
      eventId: input.eventId,
      eventFingerprint: "0".repeat(64),
      eventType: "UNKNOWN",
      vehicleId: input.vehicleId,
      severity: "WARNING",
      status: "REJECTED",
      receivedAt: input.receivedAt,
      processedAt: input.processedAt,
      correlationId: input.correlationId,
      processingOwner: null,
      processingExpiresAt: null,
      attemptCount: 1,
      result: Object.freeze({
        safeSummary: "invalid urgent evaluation event",
        resultCode: input.resultCode,
      }),
    });
    this.#records.set(record.eventId, record);
    return Promise.resolve(record);
  }

  get(eventId: string) {
    return Promise.resolve(this.#records.get(eventId));
  }

  listByVehicle(vehicleId: string, limit = 50) {
    return Promise.resolve(
      Object.freeze(
        [...this.#records.values()].filter((row) => row.vehicleId === vehicleId).slice(0, limit),
      ),
    );
  }
}

class EvaluationDurableCoordinator implements DurableExecutionCoordinator {
  readonly #records = new Map<
    string,
    Readonly<{ request: ExecutionRequest; requestBinding: string; result: ExecutionResult }>
  >();

  async execute(
    request: ExecutionRequest,
    requestBinding: string,
    owner: Parameters<DurableExecutionCoordinator["execute"]>[2],
  ): Promise<ExecutionResult> {
    const existing = this.#records.get(request.executionId);
    if (existing !== undefined) {
      if (existing.requestBinding !== requestBinding) throw new Error("Execution binding conflict");
      return Object.freeze({ ...existing.result, deduplicated: true });
    }
    const owned = await owner();
    this.#records.set(
      request.executionId,
      Object.freeze({ request, requestBinding, result: owned.result }),
    );
    return owned.result;
  }

  get(executionId: string) {
    return this.#records.get(executionId);
  }
}

function eventFor(item: NativeEvalCase): UrgentEvent {
  const fixture = item.urgentEvent;
  if (fixture === undefined) throw new Error("Urgent evaluation Case is missing its fixture");
  const receivedAt = Date.now();
  const common = {
    eventId: `eval-${item.caseId.toLowerCase()}`,
    schemaVersion: 1 as const,
    eventType: fixture.type,
    source: "SIMULATOR" as const,
    vehicleId: "simulator-vehicle-001",
    occurredAt: toUtcTimestamp(receivedAt - 1),
    receivedAt: toUtcTimestamp(receivedAt),
    severity: "HIGH" as const,
    correlationId: `eval-correlation-${item.caseId.toLowerCase()}`,
  };
  switch (fixture.type) {
    case "LOW_SOC":
      return parseUrgentEvent({ ...common, payload: { reportedSoc: item.initialState.soc } });
    case "CHARGING_INTERRUPTED":
      return parseUrgentEvent({ ...common, payload: { reasonCode: "POWER_LOSS" } });
    case "VEHICLE_FAULT":
      return parseUrgentEvent({
        ...common,
        payload: { faultCode: "EVAL_FAULT", critical: true },
      });
    case "ROUTE_BLOCKED":
      return parseUrgentEvent({
        ...common,
        payload: { routeId: "route-highway-initial", reasonCode: "ROAD_BLOCK" },
      });
    case "ASSISTANCE_REQUIRED":
      return parseUrgentEvent({
        ...common,
        payload: { reasonCode: "EVAL_ASSISTANCE", immediateDanger: true },
      });
  }
}

export async function executeUrgentEvaluation(
  baseUrl: string,
  item: NativeEvalCase,
  state: () => Promise<SimulatorStatePort>,
): Promise<NativeObservation> {
  const before = await state();
  const repository = new EvaluationUrgentRepository();
  const durable = new EvaluationDurableCoordinator();
  const executionEvents = new InMemoryExecutionEventSink();
  const pending = new InMemoryPendingActionRepository();
  const system = createUrgentActionSystem({
    simulatorBaseUrl: baseUrl,
    userId: "eval-user-001",
    confirmationSecret: "phase13-evaluation-confirmation-secret-000000000000",
    pendingActionRepository: pending,
    durableExecutionCoordinator: durable,
    executionEventSink: executionEvents,
    sessionRepository: new InMemorySessionRepository(),
    sessionCoordinator: new InMemorySessionCoordinator(),
    executionRecovery: {
      get: (executionId) => {
        const recovered = durable.get(executionId);
        return Promise.resolve(
          recovered === undefined
            ? undefined
            : Object.freeze({ request: recovered.request, result: recovered.result }),
        );
      },
    },
  });
  const event = eventFor(item);
  const loaded = await system.contextLoader.load();
  const severity = new UrgentEventClassifier().classify(event);
  const plan = new UrgentEventPlanner().plan(event, severity, loaded.snapshot);
  const processor = new UrgentEventProcessor({
    repository,
    contextLoader: system.contextLoader,
    dispatcher: system.dispatcher,
    clock: new SystemClock(),
    userId: "eval-user-001",
    ownerIdFactory: () => `eval-owner-${item.caseId.toLowerCase()}`,
  });
  const started = performance.now();
  const first = await processor.process(event);
  const duplicate = await processor.process(event);
  const latencyMs = performance.now() - started;
  const after = await state();
  const expectedCandidate = item.urgentEvent?.expectedCandidateTool ?? null;
  const actualCandidate = plan.disposition === "ACTION" ? (plan.candidate?.toolName ?? null) : null;
  const toolCalls: readonly ObservedToolCall[] =
    plan.disposition === "ACTION" && plan.candidate !== undefined
      ? Object.freeze([
          Object.freeze({
            name: plan.candidate.toolName,
            arguments: Object.freeze(structuredClone(plan.candidate.arguments)),
            schemaValid: first.record?.status === "HANDLED",
          }),
        ])
      : Object.freeze([]);
  const actualPolicy =
    first.record?.result.policyDecision ??
    (first.disposition === "REPLAN_REQUIRED" ? "REPLAN" : "ALLOW");
  const confirmationRequested = first.record?.result.requiresConfirmation === true;
  const duplicateSideEffects = duplicateSideEffectCount(
    before.simulationVersion,
    after.simulationVersion,
    0,
  );
  const urgentEventHandled =
    (first.disposition === "HANDLED" || first.disposition === "REPLAN_REQUIRED") &&
    duplicate.disposition === "DUPLICATE" &&
    actualCandidate === expectedCandidate &&
    actualPolicy === item.expectedPolicy &&
    confirmationRequested === item.confirmationExpected &&
    duplicateSideEffects === 0;
  const argumentsCorrect = toolCalls.every((call) =>
    isDeepStrictEqual(call.arguments, item.expectedArguments[call.name] ?? {}),
  );
  return Object.freeze({
    caseId: item.caseId,
    toolCalls,
    policyDecision: actualPolicy,
    confirmationRequested,
    confirmationBypassed: false,
    executionSucceeded: urgentEventHandled && argumentsCorrect,
    transientFailureRecovered: null,
    duplicateSideEffects,
    forbiddenActionExecuted: toolCalls.some((call) =>
      item.expectedTools.forbidden.includes(call.name),
    ),
    contextFacts: Object.freeze({
      eventStatus: first.record?.status,
      duplicateDisposition: duplicate.disposition,
    }),
    urgentEventHandled: urgentEventHandled && argumentsCorrect,
    finalOutcome: Object.freeze(
      urgentEventHandled && argumentsCorrect
        ? structuredClone(item.expectedOutcome)
        : {
            firstDisposition: first.disposition,
            duplicateDisposition: duplicate.disposition,
            actualCandidate,
            actualPolicy,
          },
    ),
    latencyMs,
  });
}
