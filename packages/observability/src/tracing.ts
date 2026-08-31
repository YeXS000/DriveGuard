import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVICE_NAME,
  ATTR_URL_PATH,
} from "@opentelemetry/semantic-conventions";
import type { ActionLifecycleEvent } from "@driveguard/action-lifecycle";
import type { RuntimeEvent } from "@driveguard/agent-runtime";
import type { ExecutionEvent } from "@driveguard/executor";

import type { ModelUsageObservation } from "./metrics.js";

const VALID_TRACE_ID = /^(?!0{32}$)[a-f0-9]{32}$/u;
const MAX_RETAINED_TRACE_PARENTS = 4_096;
const SIMULATOR_TOOLS = new Set([
  "get_vehicle_state",
  "get_trip_state",
  "search_charging_stations",
  "get_charging_status",
  "set_cabin_temperature",
  "set_seat_heating",
  "set_media_volume",
  "set_navigation_destination",
  "reroute_to_charger",
  "reserve_charging_slot",
  "cancel_charging_reservation",
  "request_roadside_assistance",
]);

interface ActiveSpan {
  readonly span: Span;
  readonly context: Context;
}

interface AttemptSpans {
  readonly attempt: ActiveSpan;
  readonly tool: ActiveSpan;
  readonly simulator?: ActiveSpan;
  readonly dependency?: ActiveSpan;
}

export interface HttpTraceObservation {
  readonly traceId: string;
  readonly startedAtMs: number;
  end(statusCode: number, errorCode?: string): void;
}

export interface DriveGuardTracingOptions {
  readonly service: string;
  readonly otlpEndpoint?: string;
  readonly inMemoryExporter?: InMemorySpanExporter;
  readonly captureInMemory?: boolean;
  readonly registerGlobal?: boolean;
}

function correlationAttributes(input: {
  readonly traceId: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly actionId?: string;
  readonly executionId?: string;
  readonly toolName?: string;
}): Attributes {
  return {
    "driveguard.trace_id": input.traceId,
    ...(input.runId === undefined ? {} : { "driveguard.run_id": input.runId }),
    ...(input.sessionId === undefined ? {} : { "driveguard.session_id": input.sessionId }),
    ...(input.actionId === undefined ? {} : { "driveguard.action_id": input.actionId }),
    ...(input.executionId === undefined ? {} : { "driveguard.execution_id": input.executionId }),
    ...(input.toolName === undefined ? {} : { "driveguard.tool_name": input.toolName }),
  };
}

function spanContext(span: Span): Context {
  return trace.setSpan(otelContext.active(), span);
}

function endSpan(active: ActiveSpan | undefined, errorCode?: string, endTime?: number): void {
  if (active === undefined) return;
  if (errorCode !== undefined) {
    active.span.setAttribute("error.type", errorCode);
    active.span.setStatus({ code: SpanStatusCode.ERROR, message: errorCode });
  } else {
    active.span.setStatus({ code: SpanStatusCode.OK });
  }
  active.span.end(endTime);
}

function runtimeKey(event: RuntimeEvent): string {
  return `${event.runId}:${event.metadata?.toolCallId ?? event.metadata?.toolName ?? "tool"}`;
}

function policyKey(event: RuntimeEvent): string {
  return `${event.runId}:${event.metadata?.toolName ?? "tool"}`;
}

function attemptKey(event: ExecutionEvent): string {
  return `${event.executionId}:${event.attempt}`;
}

export class DriveGuardTracing {
  readonly #provider: NodeTracerProvider;
  readonly #tracer: Tracer;
  readonly #inMemoryExporter: InMemorySpanExporter | undefined;
  readonly #http = new Map<string, ActiveSpan>();
  readonly #agents = new Map<string, ActiveSpan>();
  readonly #traceParents = new Map<string, Context>();
  readonly #contextLoads = new Map<string, ActiveSpan>();
  readonly #capabilityResolves = new Map<string, ActiveSpan>();
  readonly #llmRequests = new Map<string, ActiveSpan>();
  readonly #toolRequests = new Map<string, ActiveSpan>();
  readonly #policyEvaluations = new Map<string, ActiveSpan>();
  readonly #confirmationWaits = new Map<string, ActiveSpan>();
  readonly #confirmationRevalidations = new Map<string, ActiveSpan>();
  readonly #executions = new Map<string, ActiveSpan>();
  readonly #attempts = new Map<string, AttemptSpans>();

  constructor(options: DriveGuardTracingOptions) {
    const inMemoryExporter =
      options.inMemoryExporter ??
      (options.captureInMemory === true ? new InMemorySpanExporter() : undefined);
    const processors = [
      ...(options.otlpEndpoint === undefined
        ? []
        : [new BatchSpanProcessor(new OTLPTraceExporter({ url: options.otlpEndpoint }))]),
      ...(inMemoryExporter === undefined ? [] : [new SimpleSpanProcessor(inMemoryExporter)]),
    ];
    this.#provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.service }),
      spanProcessors: processors,
    });
    if (options.registerGlobal === true) this.#provider.register();
    this.#tracer = this.#provider.getTracer("@driveguard/observability", "0.0.0");
    this.#inMemoryExporter = inMemoryExporter;
  }

  startHttpRequest(input: {
    readonly method: string;
    readonly route: string;
  }): HttpTraceObservation {
    const startedAtMs = Date.now();
    const span = this.#tracer.startSpan("http.request", {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: input.method,
        [ATTR_URL_PATH]: input.route,
      },
      startTime: startedAtMs,
    });
    const active = { span, context: spanContext(span) };
    const traceId = span.spanContext().traceId;
    this.#http.set(traceId, active);
    let ended = false;
    return {
      traceId,
      startedAtMs,
      end: (statusCode, errorCode) => {
        if (ended) return;
        ended = true;
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
        endSpan(active, errorCode ?? (statusCode >= 500 ? `HTTP_${statusCode}` : undefined));
        this.#http.delete(traceId);
      },
    };
  }

  observeRuntime(event: RuntimeEvent): void {
    const attributes = correlationAttributes(event);
    const at = Date.parse(event.timestamp);
    if (event.eventType === "agent.run.started") {
      const parent = this.#http.get(event.traceId)?.context ?? this.#parentFor(event.traceId);
      const agent = this.#start("agent.run", attributes, parent, at);
      this.#agents.set(event.runId, agent);
      this.#rememberTraceParent(event.traceId, agent.context);
      this.#contextLoads.set(
        event.runId,
        this.#start("context.load", attributes, agent.context, at),
      );
      return;
    }
    const agent = this.#agents.get(event.runId);
    const parent =
      agent?.context ?? this.#traceParents.get(event.traceId) ?? this.#parentFor(event.traceId);
    if (event.eventType === "context.loaded") {
      endSpan(this.#contextLoads.get(event.runId), undefined, at);
      this.#contextLoads.delete(event.runId);
      this.#capabilityResolves.set(
        event.runId,
        this.#start("capability.resolve", attributes, parent, at),
      );
    } else if (event.eventType === "capabilities.resolved") {
      endSpan(this.#capabilityResolves.get(event.runId), undefined, at);
      this.#capabilityResolves.delete(event.runId);
    } else if (event.eventType === "model.started") {
      endSpan(this.#llmRequests.get(event.runId), "MODEL_RESTARTED", at);
      this.#llmRequests.set(event.runId, this.#start("llm.request", attributes, parent, at));
    } else if (event.eventType === "tool.requested") {
      endSpan(this.#llmRequests.get(event.runId), undefined, at);
      this.#llmRequests.delete(event.runId);
      this.#toolRequests.set(
        runtimeKey(event),
        this.#start("tool.request", attributes, parent, at),
      );
    } else if (event.eventType === "policy.evaluation.started") {
      const toolParent = this.#latestToolParent(event.runId) ?? parent;
      this.#policyEvaluations.set(
        policyKey(event),
        this.#start("policy.evaluate", attributes, toolParent, at),
      );
    } else if (event.eventType === "policy.decision.made") {
      const policy = this.#policyEvaluations.get(policyKey(event));
      policy?.span.setAttributes({
        "driveguard.policy.decision": event.metadata?.decision ?? "UNKNOWN",
        "driveguard.policy.rule_id": event.metadata?.ruleId ?? "unknown",
        "driveguard.policy.reason_code": event.metadata?.reasonCode ?? "unknown",
      });
      endSpan(policy, undefined, at);
      this.#policyEvaluations.delete(policyKey(event));
    } else if (event.eventType === "tool.completed") {
      const tool = this.#toolRequests.get(runtimeKey(event));
      endSpan(
        tool,
        event.metadata?.isError === true ? (event.metadata.errorCode ?? "TOOL_ERROR") : undefined,
        at,
      );
      this.#toolRequests.delete(runtimeKey(event));
    } else if (
      event.eventType === "agent.run.completed" ||
      event.eventType === "agent.run.failed"
    ) {
      endSpan(this.#contextLoads.get(event.runId), event.metadata?.errorCode, at);
      endSpan(this.#capabilityResolves.get(event.runId), event.metadata?.errorCode, at);
      endSpan(this.#llmRequests.get(event.runId), event.metadata?.errorCode, at);
      for (const [key, tool] of this.#toolRequests) {
        if (key.startsWith(`${event.runId}:`)) {
          endSpan(tool, event.metadata?.errorCode, at);
          this.#toolRequests.delete(key);
        }
      }
      endSpan(
        agent,
        event.eventType === "agent.run.failed" ? event.metadata?.errorCode : undefined,
        at,
      );
      this.#contextLoads.delete(event.runId);
      this.#capabilityResolves.delete(event.runId);
      this.#llmRequests.delete(event.runId);
      this.#agents.delete(event.runId);
    }
  }

  observeModelUsage(event: ModelUsageObservation): void {
    const llm = this.#llmRequests.get(event.runId);
    llm?.span.setAttributes({
      "gen_ai.request.model": event.modelName,
      "gen_ai.usage.input_tokens": event.inputTokens,
      "gen_ai.usage.output_tokens": event.outputTokens,
      "driveguard.llm.cost": event.cost,
    });
    endSpan(llm, event.isError ? "MODEL_ERROR" : undefined);
    this.#llmRequests.delete(event.runId);
  }

  observeAction(event: ActionLifecycleEvent): void {
    const attributes = correlationAttributes(event);
    const parent = this.#traceParents.get(event.traceId) ?? this.#parentFor(event.traceId);
    const at = Date.parse(event.timestamp);
    this.#instant("persistence.write", attributes, parent, at, {
      "driveguard.persistence.record": "action_lifecycle_event",
    });
    if (event.eventType === "action.pending.created") {
      this.#confirmationWaits.set(
        event.actionId,
        this.#start("confirmation.wait", attributes, parent, at),
      );
    } else if (
      event.eventType === "confirmation.accepted" ||
      event.eventType === "confirmation.rejected" ||
      event.eventType === "confirmation.expired" ||
      event.eventType === "action.cancelled"
    ) {
      endSpan(
        this.#confirmationWaits.get(event.actionId),
        event.eventType === "confirmation.accepted" ? undefined : event.eventType,
        at,
      );
      this.#confirmationWaits.delete(event.actionId);
    }
    if (event.eventType === "action.revalidation.started") {
      this.#confirmationRevalidations.set(
        event.actionId,
        this.#start("confirmation.revalidate", attributes, parent, at),
      );
    } else if (
      event.eventType === "action.ready_for_execution" ||
      event.eventType === "action.revalidation.failed"
    ) {
      endSpan(
        this.#confirmationRevalidations.get(event.actionId),
        event.eventType === "action.revalidation.failed"
          ? (event.reason ?? event.eventType)
          : undefined,
        at,
      );
      this.#confirmationRevalidations.delete(event.actionId);
    }
  }

  observeExecution(event: ExecutionEvent): void {
    const attributes = correlationAttributes(event);
    const parent =
      this.#latestToolParent(event.runId) ??
      this.#traceParents.get(event.traceId) ??
      this.#parentFor(event.traceId);
    const at = Date.parse(event.timestamp);
    this.#instant("persistence.write", attributes, parent, at, {
      "driveguard.persistence.record": "execution_event",
    });
    if (event.eventType === "execution.started") {
      this.#executions.set(
        event.executionId,
        this.#start("executor.execute", attributes, parent, at),
      );
    } else if (event.eventType === "execution.attempt.started") {
      const executionParent = this.#executions.get(event.executionId)?.context ?? parent;
      const attempt = this.#start("executor.attempt", attributes, executionParent, at, {
        "driveguard.execution.attempt": event.attempt,
      });
      const tool = this.#start("tool.execute", attributes, attempt.context, at);
      const simulator = SIMULATOR_TOOLS.has(event.toolName)
        ? this.#start("simulator.request", attributes, tool.context, at)
        : undefined;
      const dependency =
        simulator === undefined
          ? undefined
          : this.#start("dependency.http", attributes, simulator.context, at, {
              "server.address": "vehicle-simulator",
            });
      this.#attempts.set(attemptKey(event), {
        attempt,
        tool,
        ...(simulator === undefined ? {} : { simulator }),
        ...(dependency === undefined ? {} : { dependency }),
      });
    } else if (event.eventType === "execution.attempt.failed") {
      this.#endAttempt(event, event.errorCode ?? "TOOL_EXECUTION_FAILED", at);
    } else if (
      event.eventType === "execution.succeeded" ||
      event.eventType === "execution.failed" ||
      event.eventType === "execution.outcome_unknown"
    ) {
      this.#endAttempt(
        event,
        event.eventType === "execution.succeeded"
          ? undefined
          : (event.errorCode ?? event.eventType),
        at,
      );
      endSpan(
        this.#executions.get(event.executionId),
        event.eventType === "execution.succeeded"
          ? undefined
          : (event.errorCode ?? event.eventType),
        at,
      );
      this.#executions.delete(event.executionId);
    } else if (event.eventType.startsWith("circuit.")) {
      this.#executions
        .get(event.executionId)
        ?.span.addEvent(event.eventType, { "driveguard.execution.attempt": event.attempt }, at);
    }
  }

  finishedSpans(): readonly ReadableSpan[] {
    return Object.freeze([...(this.#inMemoryExporter?.getFinishedSpans() ?? [])]);
  }

  async forceFlush(): Promise<void> {
    await this.#provider.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.#provider.shutdown();
  }

  #start(
    name: string,
    attributes: Attributes,
    parent: Context,
    startTime: number,
    additionalAttributes: Attributes = {},
  ): ActiveSpan {
    const span = this.#tracer.startSpan(
      name,
      { attributes: { ...attributes, ...additionalAttributes }, startTime },
      parent,
    );
    return { span, context: trace.setSpan(parent, span) };
  }

  #parentFor(traceId: string): Context {
    if (!VALID_TRACE_ID.test(traceId)) return ROOT_CONTEXT;
    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: "0000000000000001",
      traceFlags: 1,
      isRemote: true,
    });
  }

  #rememberTraceParent(traceId: string, parent: Context): void {
    this.#traceParents.delete(traceId);
    this.#traceParents.set(traceId, parent);
    if (this.#traceParents.size <= MAX_RETAINED_TRACE_PARENTS) return;
    const oldestTraceId = this.#traceParents.keys().next().value;
    if (oldestTraceId !== undefined) this.#traceParents.delete(oldestTraceId);
  }

  #instant(
    name: string,
    attributes: Attributes,
    parent: Context,
    at: number,
    additionalAttributes: Attributes,
  ): void {
    endSpan(this.#start(name, attributes, parent, at, additionalAttributes), undefined, at);
  }

  #latestToolParent(runId: string): Context | undefined {
    for (const [key, active] of [...this.#toolRequests].reverse()) {
      if (key.startsWith(`${runId}:`)) return active.context;
    }
    return undefined;
  }

  #endAttempt(event: ExecutionEvent, errorCode: string | undefined, at: number): void {
    const key = attemptKey(event);
    const spans = this.#attempts.get(key);
    endSpan(spans?.dependency, errorCode, at);
    endSpan(spans?.simulator, errorCode, at);
    endSpan(spans?.tool, errorCode, at);
    endSpan(spans?.attempt, errorCode, at);
    this.#attempts.delete(key);
  }
}
