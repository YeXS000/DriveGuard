import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  prometheusContentType,
  type PrometheusContentType,
} from "@prometheus-io/client";
import type { ActionLifecycleEvent } from "@driveguard/action-lifecycle";
import type { RuntimeEvent } from "@driveguard/agent-runtime";
import type { ExecutionConcurrencySnapshot, ExecutionEvent } from "@driveguard/executor";
import type { UrgentEventObservation } from "@driveguard/urgent-events";

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const TERMINAL_EXECUTION_EVENTS = new Set([
  "execution.succeeded",
  "execution.failed",
  "execution.outcome_unknown",
]);
const CONTEXT_REASON_CODES = new Set([
  "CONTEXT_INVALID",
  "CONTEXT_FUTURE_TIMESTAMP",
  "CONTEXT_STALE",
  "CONTEXT_NOT_LATEST",
  "CONTEXT_RELEVANT_STATE_CHANGED",
  "CONTEXT_PATH_UNKNOWN",
]);

function epochMs(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

function secondsBetween(startMs: number, endMs: number): number {
  return Math.max(0, endMs - startMs) / 1_000;
}

function toolCallKey(event: RuntimeEvent): string {
  return `${event.runId}:${event.metadata?.toolCallId ?? event.metadata?.toolName ?? "tool"}`;
}

export interface HttpMetricObservation {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationSeconds: number;
}

export interface ModelUsageObservation {
  readonly runId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly modelName: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly isError: boolean;
  readonly providerDurationMs?: number;
}

export interface AdmissionMetricObservation {
  readonly accepting: boolean;
  readonly active: number;
  readonly queued: number;
  readonly rejected: number;
}

export interface InfrastructureMetricObservation {
  readonly postgresTotal: number;
  readonly postgresIdle: number;
  readonly postgresWaiting: number;
  readonly redisReady: boolean;
  readonly natsPending: number;
  readonly natsAckPending: number;
}

export class DriveGuardMetrics {
  readonly registry: Registry<PrometheusContentType>;
  readonly #httpRequests: Counter<"method" | "route" | "status_code">;
  readonly #httpDuration: Histogram<"method" | "route" | "status_code">;
  readonly #agentRuns: Counter<"status">;
  readonly #agentDuration: Histogram<"status">;
  readonly #toolCalls: Counter<"tool_name" | "status">;
  readonly #toolDuration: Histogram<"tool_name" | "status">;
  readonly #policyDecisions: Counter<"decision" | "tool_name">;
  readonly #policyDuration: Histogram<"decision">;
  readonly #confirmations: Counter<"event">;
  readonly #confirmationPending: Gauge;
  readonly #executions: Counter<"tool_name" | "status">;
  readonly #executionDuration: Histogram<"tool_name" | "status">;
  readonly #executionAttempts: Counter<"tool_name">;
  readonly #retries: Counter<"tool_name" | "error_code">;
  readonly #circuitState: Gauge<"tool_name">;
  readonly #llmTokens: Counter<"direction" | "model">;
  readonly #llmCost: Counter<"model">;
  readonly #llmDuration: Histogram<"model" | "status">;
  readonly #contextConflicts: Counter<"decision">;
  readonly #dependencyUp: Gauge<"dependency">;
  readonly #urgentEvents: Counter<"event_type" | "severity" | "status">;
  readonly #urgentDuration: Histogram<"event_type" | "severity" | "status">;
  readonly #urgentDuplicates: Counter<"event_type" | "severity">;
  readonly #admissionActive: Gauge;
  readonly #admissionQueued: Gauge;
  readonly #admissionAccepting: Gauge;
  readonly #admissionRejected: Counter;
  readonly #executorActive: Gauge<"kind">;
  readonly #executorQueued: Gauge;
  readonly #executorRejected: Counter;
  readonly #postgresPool: Gauge<"state">;
  readonly #redisReady: Gauge;
  readonly #natsConsumer: Gauge<"state">;
  readonly #agentStarted = new Map<string, number>();
  readonly #toolStarted = new Map<string, number>();
  readonly #policyStarted = new Map<string, number>();
  readonly #executionStarted = new Map<string, number>();
  readonly #pendingActions = new Set<string>();
  readonly #urgentStarted = new Map<string, number>();
  #lastAdmissionRejected = 0;
  #lastExecutorRejected = 0;

  constructor(options: { readonly collectProcessMetrics?: boolean } = {}) {
    this.registry = new Registry(prometheusContentType);
    const registers = [this.registry];
    this.#httpRequests = new Counter({
      name: "driveguard_http_requests_total",
      help: "Total DriveGuard HTTP requests.",
      labelNames: ["method", "route", "status_code"] as const,
      registers,
    });
    this.#httpDuration = new Histogram({
      name: "driveguard_http_request_duration_seconds",
      help: "DriveGuard HTTP request duration in seconds.",
      labelNames: ["method", "route", "status_code"] as const,
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#agentRuns = new Counter({
      name: "driveguard_agent_runs_total",
      help: "Total DriveGuard Agent runs by terminal status.",
      labelNames: ["status"] as const,
      registers,
    });
    this.#agentDuration = new Histogram({
      name: "driveguard_agent_run_duration_seconds",
      help: "DriveGuard Agent run duration in seconds.",
      labelNames: ["status"] as const,
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#toolCalls = new Counter({
      name: "driveguard_tool_calls_total",
      help: "Total formal Tool calls by bounded Tool name and status.",
      labelNames: ["tool_name", "status"] as const,
      registers,
    });
    this.#toolDuration = new Histogram({
      name: "driveguard_tool_duration_seconds",
      help: "Formal Tool duration in seconds.",
      labelNames: ["tool_name", "status"] as const,
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#policyDecisions = new Counter({
      name: "driveguard_policy_decisions_total",
      help: "Total deterministic Policy decisions.",
      labelNames: ["decision", "tool_name"] as const,
      registers,
    });
    this.#policyDuration = new Histogram({
      name: "driveguard_policy_duration_seconds",
      help: "Deterministic Policy evaluation duration in seconds.",
      labelNames: ["decision"] as const,
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#confirmations = new Counter({
      name: "driveguard_confirmations_total",
      help: "Total confirmation lifecycle outcomes.",
      labelNames: ["event"] as const,
      registers,
    });
    this.#confirmationPending = new Gauge({
      name: "driveguard_confirmation_pending",
      help: "Current count of confirmation actions known to this process.",
      registers,
    });
    this.#executions = new Counter({
      name: "driveguard_executions_total",
      help: "Total terminal reliable executions.",
      labelNames: ["tool_name", "status"] as const,
      registers,
    });
    this.#executionDuration = new Histogram({
      name: "driveguard_execution_duration_seconds",
      help: "Reliable execution duration in seconds.",
      labelNames: ["tool_name", "status"] as const,
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#executionAttempts = new Counter({
      name: "driveguard_execution_attempts_total",
      help: "Total reliable execution attempts.",
      labelNames: ["tool_name"] as const,
      registers,
    });
    this.#retries = new Counter({
      name: "driveguard_retries_total",
      help: "Total reliable execution retries.",
      labelNames: ["tool_name", "error_code"] as const,
      registers,
    });
    this.#circuitState = new Gauge({
      name: "driveguard_circuit_state",
      help: "Circuit state: CLOSED=0, HALF_OPEN=0.5, OPEN=1.",
      labelNames: ["tool_name"] as const,
      registers,
    });
    this.#llmTokens = new Counter({
      name: "driveguard_llm_tokens_total",
      help: "LLM tokens reported by the provider.",
      labelNames: ["direction", "model"] as const,
      registers,
    });
    this.#llmCost = new Counter({
      name: "driveguard_llm_cost_total",
      help: "LLM cost in provider-reported currency units.",
      labelNames: ["model"] as const,
      registers,
    });
    this.#llmDuration = new Histogram({
      name: "driveguard_llm_provider_duration_seconds",
      help: "LLM provider stream duration excluding Tool execution.",
      labelNames: ["model", "status"] as const,
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#contextConflicts = new Counter({
      name: "driveguard_context_conflicts_total",
      help: "Context conflict decisions detected by Policy.",
      labelNames: ["decision"] as const,
      registers,
    });
    this.#dependencyUp = new Gauge({
      name: "driveguard_dependency_up",
      help: "Latest non-authoritative readiness observation for a bounded dependency.",
      labelNames: ["dependency"] as const,
      registers,
    });
    this.#urgentEvents = new Counter({
      name: "driveguard_urgent_events_total",
      help: "Total urgent-event lifecycle outcomes by bounded event type, severity, and status.",
      labelNames: ["event_type", "severity", "status"] as const,
      registers,
    });
    this.#urgentDuration = new Histogram({
      name: "driveguard_urgent_event_processing_duration_seconds",
      help: "Urgent-event processing duration in seconds.",
      labelNames: ["event_type", "severity", "status"] as const,
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#urgentDuplicates = new Counter({
      name: "driveguard_urgent_event_duplicates_total",
      help: "Total durable duplicate urgent events.",
      labelNames: ["event_type", "severity"] as const,
      registers,
    });
    this.#admissionActive = new Gauge({
      name: "driveguard_admission_active",
      help: "Current admitted stateful API requests.",
      registers,
    });
    this.#admissionQueued = new Gauge({
      name: "driveguard_admission_queued",
      help: "Current bounded API admission queue depth.",
      registers,
    });
    this.#admissionAccepting = new Gauge({
      name: "driveguard_admission_accepting",
      help: "Whether stateful API admission is accepting new requests.",
      registers,
    });
    this.#admissionRejected = new Counter({
      name: "driveguard_admission_rejected_total",
      help: "Total API requests rejected by bounded admission.",
      registers,
    });
    this.#executorActive = new Gauge({
      name: "driveguard_executor_active",
      help: "Current admitted Executor operations by read or write class.",
      labelNames: ["kind"] as const,
      registers,
    });
    this.#executorQueued = new Gauge({
      name: "driveguard_executor_queued",
      help: "Current bounded Executor queue depth.",
      registers,
    });
    this.#executorRejected = new Counter({
      name: "driveguard_executor_rejected_total",
      help: "Total Executor operations rejected by bounded capacity.",
      registers,
    });
    this.#postgresPool = new Gauge({
      name: "driveguard_postgres_pool_connections",
      help: "PostgreSQL pool connections by bounded state.",
      labelNames: ["state"] as const,
      registers,
    });
    this.#redisReady = new Gauge({
      name: "driveguard_redis_connection_ready",
      help: "Whether the runtime Redis connection is ready.",
      registers,
    });
    this.#natsConsumer = new Gauge({
      name: "driveguard_nats_consumer_messages",
      help: "JetStream durable consumer messages by bounded state.",
      labelNames: ["state"] as const,
      registers,
    });
    for (const status of ["succeeded", "failed", "cancelled"]) {
      this.#agentRuns.labels({ status }).inc(0);
      this.#agentDuration.zero({ status });
    }
    for (const decision of ["ALLOW", "DENY", "REPLAN", "REQUIRE_CONFIRMATION"]) {
      this.#policyDecisions.labels({ decision, tool_name: "none" }).inc(0);
      this.#policyDuration.zero({ decision });
    }
    this.#confirmationPending.set(0);
    this.#admissionActive.set(0);
    this.#admissionQueued.set(0);
    this.#admissionAccepting.set(1);
    this.#admissionRejected.inc(0);
    this.#executorActive.set({ kind: "read" }, 0);
    this.#executorActive.set({ kind: "write" }, 0);
    this.#executorQueued.set(0);
    this.#executorRejected.inc(0);
    for (const state of ["total", "idle", "waiting"]) this.#postgresPool.set({ state }, 0);
    this.#redisReady.set(0);
    this.#natsConsumer.set({ state: "pending" }, 0);
    this.#natsConsumer.set({ state: "ack_pending" }, 0);
    if (options.collectProcessMetrics !== false) {
      collectDefaultMetrics({ register: this.registry, prefix: "driveguard_process_" });
    }
  }

  observeHttp(observation: HttpMetricObservation): void {
    const labels = {
      method: observation.method,
      route: observation.route,
      status_code: String(observation.statusCode),
    };
    this.#httpRequests.inc(labels);
    this.#httpDuration.observe(labels, observation.durationSeconds);
  }

  observeRuntime(event: RuntimeEvent): void {
    const at = epochMs(event.timestamp);
    if (event.eventType === "agent.run.started") this.#agentStarted.set(event.runId, at);
    if (event.eventType === "agent.run.completed" || event.eventType === "agent.run.failed") {
      const status =
        event.eventType === "agent.run.completed"
          ? "succeeded"
          : event.metadata?.errorCode === "RUN_CANCELLED"
            ? "cancelled"
            : "failed";
      this.#agentRuns.inc({ status });
      this.#agentDuration.observe(
        { status },
        secondsBetween(this.#agentStarted.get(event.runId) ?? at, at),
      );
      this.#agentStarted.delete(event.runId);
      for (const key of this.#toolStarted.keys()) {
        if (key.startsWith(`${event.runId}:`)) this.#toolStarted.delete(key);
      }
      for (const key of this.#policyStarted.keys()) {
        if (key.startsWith(`${event.runId}:`)) this.#policyStarted.delete(key);
      }
    }
    if (event.eventType === "tool.requested") this.#toolStarted.set(toolCallKey(event), at);
    if (event.eventType === "tool.completed") {
      const toolName = event.metadata?.toolName ?? "unknown_tool";
      const status = event.metadata?.isError === true ? "failed" : "succeeded";
      this.#toolCalls.inc({ tool_name: toolName, status });
      const key = toolCallKey(event);
      this.#toolDuration.observe(
        { tool_name: toolName, status },
        secondsBetween(this.#toolStarted.get(key) ?? at, at),
      );
      this.#toolStarted.delete(key);
    }
    if (event.eventType === "policy.evaluation.started") {
      this.#policyStarted.set(`${event.runId}:${event.metadata?.toolName ?? "tool"}`, at);
    }
    if (event.eventType === "policy.decision.made") {
      const decision = event.metadata?.decision ?? "DENY";
      const toolName = event.metadata?.toolName ?? "unknown_tool";
      this.#policyDecisions.inc({ decision, tool_name: toolName });
      if (
        event.metadata?.reasonCode !== undefined &&
        CONTEXT_REASON_CODES.has(event.metadata.reasonCode)
      ) {
        this.#contextConflicts.inc({ decision });
      }
      const key = `${event.runId}:${toolName}`;
      this.#policyDuration.observe(
        { decision },
        secondsBetween(this.#policyStarted.get(key) ?? at, at),
      );
      this.#policyStarted.delete(key);
    }
  }

  observeModelUsage(event: ModelUsageObservation): void {
    this.#llmTokens.inc({ direction: "input", model: event.modelName }, event.inputTokens);
    this.#llmTokens.inc({ direction: "output", model: event.modelName }, event.outputTokens);
    this.#llmCost.inc({ model: event.modelName }, event.cost);
    this.#llmDuration.observe(
      { model: event.modelName, status: event.isError ? "error" : "success" },
      (event.providerDurationMs ?? 0) / 1_000,
    );
  }

  observeDependencies(
    dependencies: readonly { readonly name: string; readonly status: "up" | "down" }[],
  ): void {
    for (const dependency of dependencies) {
      this.#dependencyUp.set({ dependency: dependency.name }, dependency.status === "up" ? 1 : 0);
    }
  }

  observeAdmission(observation: AdmissionMetricObservation): void {
    this.#admissionActive.set(observation.active);
    this.#admissionQueued.set(observation.queued);
    this.#admissionAccepting.set(observation.accepting ? 1 : 0);
    const delta = Math.max(0, observation.rejected - this.#lastAdmissionRejected);
    if (delta > 0) this.#admissionRejected.inc(delta);
    this.#lastAdmissionRejected = Math.max(this.#lastAdmissionRejected, observation.rejected);
  }

  observeExecutionCapacity(observation: ExecutionConcurrencySnapshot): void {
    this.#executorActive.set({ kind: "read" }, observation.readActive);
    this.#executorActive.set({ kind: "write" }, observation.writeActive);
    this.#executorQueued.set(observation.queued);
    const delta = Math.max(0, observation.rejected - this.#lastExecutorRejected);
    if (delta > 0) this.#executorRejected.inc(delta);
    this.#lastExecutorRejected = Math.max(this.#lastExecutorRejected, observation.rejected);
  }

  observeInfrastructure(observation: InfrastructureMetricObservation): void {
    this.#postgresPool.set({ state: "total" }, observation.postgresTotal);
    this.#postgresPool.set({ state: "idle" }, observation.postgresIdle);
    this.#postgresPool.set({ state: "waiting" }, observation.postgresWaiting);
    this.#redisReady.set(observation.redisReady ? 1 : 0);
    this.#natsConsumer.set({ state: "pending" }, observation.natsPending);
    this.#natsConsumer.set({ state: "ack_pending" }, observation.natsAckPending);
  }

  observeAction(event: ActionLifecycleEvent): void {
    this.#confirmations.inc({ event: event.eventType });
    if (event.eventType === "action.pending.created") {
      this.#pendingActions.add(event.actionId);
      this.#confirmationPending.set(this.#pendingActions.size);
    }
    if (
      event.eventType === "confirmation.rejected" ||
      event.eventType === "confirmation.expired" ||
      event.eventType === "action.ready_for_execution" ||
      event.eventType === "action.cancelled" ||
      event.eventType === "action.revalidation.failed"
    ) {
      this.#pendingActions.delete(event.actionId);
      this.#confirmationPending.set(this.#pendingActions.size);
    }
  }

  observeExecution(event: ExecutionEvent): void {
    const at = epochMs(event.timestamp);
    if (event.eventType === "execution.started") {
      this.#executionStarted.set(event.executionId, at);
    }
    if (event.eventType === "execution.attempt.started") {
      this.#executionAttempts.inc({ tool_name: event.toolName });
    }
    if (event.eventType === "execution.retry.scheduled") {
      this.#retries.inc({
        tool_name: event.toolName,
        error_code: event.errorCode ?? "UNKNOWN",
      });
    }
    if (event.eventType === "circuit.opened") {
      this.#circuitState.set({ tool_name: event.toolName }, 1);
    } else if (event.eventType === "circuit.half_open") {
      this.#circuitState.set({ tool_name: event.toolName }, 0.5);
    } else if (event.eventType === "circuit.closed") {
      this.#circuitState.set({ tool_name: event.toolName }, 0);
    }
    if (TERMINAL_EXECUTION_EVENTS.has(event.eventType)) {
      const status = event.eventType.replace("execution.", "");
      const labels = { tool_name: event.toolName, status };
      this.#executions.inc(labels);
      this.#executionDuration.observe(
        labels,
        secondsBetween(this.#executionStarted.get(event.executionId) ?? at, at),
      );
      this.#executionStarted.delete(event.executionId);
    }
  }

  observeUrgent(event: UrgentEventObservation): void {
    const at = epochMs(event.timestamp);
    if (event.observationType === "urgent.event.received") {
      this.#urgentStarted.set(event.eventId, at);
      this.#urgentEvents.inc({
        event_type: event.eventType,
        severity: event.severity,
        status: event.status,
      });
      return;
    }
    if (event.observationType === "urgent.event.duplicate") {
      this.#urgentDuplicates.inc({ event_type: event.eventType, severity: event.severity });
      this.#urgentEvents.inc({
        event_type: event.eventType,
        severity: event.severity,
        status: event.status,
      });
      return;
    }
    if (
      event.observationType === "urgent.event.processed" ||
      event.observationType === "urgent.event.rejected" ||
      event.observationType === "urgent.event.failed"
    ) {
      const labels = {
        event_type: event.eventType,
        severity: event.severity,
        status: event.status,
      };
      this.#urgentEvents.inc(labels);
      this.#urgentDuration.observe(
        labels,
        secondsBetween(this.#urgentStarted.get(event.eventId) ?? at, at),
      );
      this.#urgentStarted.delete(event.eventId);
    }
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): PrometheusContentType {
    return prometheusContentType;
  }
}
