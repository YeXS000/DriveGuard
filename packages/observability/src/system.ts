import { randomBytes } from "node:crypto";

import type { ActionLifecycleEventSink } from "@driveguard/action-lifecycle";
import type { RuntimeEvent, RuntimeEventSink } from "@driveguard/agent-runtime";
import type { ExecutionEvent, ExecutionEventSink } from "@driveguard/executor";
import type { UrgentEventObservation, UrgentEventObserver } from "@driveguard/urgent-events";
import type { DestinationStream } from "pino";

import { DriveGuardLogger } from "./logger.js";
import {
  DriveGuardMetrics,
  type AdmissionMetricObservation,
  type InfrastructureMetricObservation,
  type ModelUsageObservation,
} from "./metrics.js";
import type { ExecutionConcurrencySnapshot } from "@driveguard/executor";
import { DriveGuardTracing } from "./tracing.js";

export interface HttpRequestObservation {
  readonly traceId: string;
  end(input: {
    readonly statusCode: number;
    readonly method: string;
    readonly route: string;
    readonly errorCode?: string;
  }): void;
}

export interface DriveGuardObservabilityOptions {
  readonly service: string;
  readonly logLevel?: string;
  readonly logDestination?: DestinationStream;
  readonly sensitiveValues?: readonly string[];
  readonly otlpEndpoint?: string;
  readonly collectProcessMetrics?: boolean;
  readonly captureInMemoryTracing?: boolean;
  readonly registerGlobalTracing?: boolean;
}

function runtimeLevel(event: RuntimeEvent): "info" | "warn" | "error" {
  if (event.eventType === "agent.run.failed") return "error";
  if (event.eventType === "policy.execution.blocked") return "warn";
  return "info";
}

function executionLevel(event: ExecutionEvent): "info" | "warn" | "error" {
  if (
    event.eventType === "execution.failed" ||
    event.eventType === "execution.outcome_unknown" ||
    event.eventType === "circuit.opened"
  ) {
    return "error";
  }
  if (
    event.eventType === "execution.attempt.failed" ||
    event.eventType === "execution.retry.scheduled"
  ) {
    return "warn";
  }
  return "info";
}

function urgentLevel(event: UrgentEventObservation): "info" | "warn" | "error" {
  if (event.observationType === "urgent.event.failed") return "error";
  if (
    event.observationType === "urgent.event.rejected" ||
    event.observationType === "urgent.event.duplicate"
  ) {
    return "warn";
  }
  return "info";
}

export class DriveGuardObservability {
  readonly logger: DriveGuardLogger;
  readonly metrics: DriveGuardMetrics;
  readonly tracing: DriveGuardTracing;
  readonly runtimeEventSink: RuntimeEventSink;
  readonly actionLifecycleEventSink: ActionLifecycleEventSink;
  readonly executionEventSink: ExecutionEventSink;
  readonly urgentEventObserver: UrgentEventObserver;

  constructor(options: DriveGuardObservabilityOptions) {
    this.logger = new DriveGuardLogger({
      service: options.service,
      ...(options.logLevel === undefined ? {} : { level: options.logLevel }),
      ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
      ...(options.sensitiveValues === undefined
        ? {}
        : { sensitiveValues: options.sensitiveValues }),
    });
    this.metrics = new DriveGuardMetrics({
      ...(options.collectProcessMetrics === undefined
        ? {}
        : { collectProcessMetrics: options.collectProcessMetrics }),
    });
    this.tracing = new DriveGuardTracing({
      service: options.service,
      ...(options.otlpEndpoint === undefined ? {} : { otlpEndpoint: options.otlpEndpoint }),
      ...(options.captureInMemoryTracing === undefined
        ? {}
        : { captureInMemory: options.captureInMemoryTracing }),
      ...(options.registerGlobalTracing === undefined
        ? {}
        : { registerGlobal: options.registerGlobalTracing }),
    });
    this.runtimeEventSink = {
      emit: (event) => {
        this.#bestEffort(() => this.metrics.observeRuntime(event));
        this.#bestEffort(() => this.tracing.observeRuntime(event));
        this.#bestEffort(() =>
          this.logger.write(
            runtimeLevel(event),
            event.eventType,
            {
              traceId: event.traceId,
              runId: event.runId,
              sessionId: event.sessionId,
              ...(event.metadata?.toolName === undefined
                ? {}
                : { toolName: event.metadata.toolName }),
            },
            {
              ...(event.metadata?.decision === undefined
                ? {}
                : { policyDecision: event.metadata.decision }),
              ...(event.metadata?.errorCode === undefined &&
              event.metadata?.reasonCode === undefined
                ? {}
                : { errorCode: event.metadata.errorCode ?? event.metadata.reasonCode }),
            },
          ),
        );
      },
    };
    this.actionLifecycleEventSink = {
      emit: (event) => {
        this.#bestEffort(() => this.metrics.observeAction(event));
        this.#bestEffort(() => this.tracing.observeAction(event));
        this.#bestEffort(() =>
          this.logger.write(
            event.eventType === "action.revalidation.failed" ? "warn" : "info",
            event.eventType,
            {
              traceId: event.traceId,
              runId: event.runId,
              sessionId: event.sessionId,
              actionId: event.actionId,
              toolName: event.toolName,
            },
            {
              status: event.state,
              ...(event.reason === undefined ? {} : { errorCode: event.reason }),
            },
          ),
        );
      },
    };
    this.executionEventSink = {
      emit: (event) => {
        this.#bestEffort(() => this.metrics.observeExecution(event));
        this.#bestEffort(() => this.tracing.observeExecution(event));
        this.#bestEffort(() =>
          this.logger.write(
            executionLevel(event),
            event.eventType,
            {
              traceId: event.traceId,
              runId: event.runId,
              sessionId: event.sessionId,
              ...(event.actionId === undefined ? {} : { actionId: event.actionId }),
              executionId: event.executionId,
              toolName: event.toolName,
            },
            {
              attempt: event.attempt,
              ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
            },
          ),
        );
      },
    };
    this.urgentEventObserver = {
      observe: (event) => {
        this.#bestEffort(() => this.metrics.observeUrgent(event));
        this.#bestEffort(() => this.tracing.observeUrgent(event));
        this.#bestEffort(() =>
          this.logger.write(
            urgentLevel(event),
            event.observationType,
            {
              traceId: event.traceId,
              runId: event.runId,
              sessionId: null,
              eventId: event.eventId,
              ...(event.actionId === undefined ? {} : { actionId: event.actionId }),
              ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
              ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
            },
            {
              status: event.status,
              ...(event.policyDecision === undefined
                ? {}
                : { policyDecision: event.policyDecision }),
              ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
            },
          ),
        );
      },
    };
  }

  startHttpRequest(input: {
    readonly method: string;
    readonly route: string;
  }): HttpRequestObservation {
    let traceObservation: ReturnType<DriveGuardTracing["startHttpRequest"]> | undefined;
    this.#bestEffort(() => {
      traceObservation = this.tracing.startHttpRequest(input);
    });
    const traceId = traceObservation?.traceId ?? randomBytes(16).toString("hex");
    const startedAtMs = traceObservation?.startedAtMs ?? Date.now();
    this.#bestEffort(() =>
      this.logger.write(
        "info",
        "http.request.started",
        {
          traceId,
          runId: null,
          sessionId: null,
        },
        input,
      ),
    );
    let ended = false;
    return {
      traceId,
      end: (result) => {
        if (ended) return;
        ended = true;
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        this.#bestEffort(() => traceObservation?.end(result.statusCode, result.errorCode));
        this.#bestEffort(() =>
          this.metrics.observeHttp({
            method: result.method,
            route: result.route,
            statusCode: result.statusCode,
            durationSeconds: durationMs / 1_000,
          }),
        );
        this.#bestEffort(() =>
          this.logger.write(
            result.statusCode >= 500 ? "error" : "info",
            "http.request.completed",
            {
              traceId,
              runId: null,
              sessionId: null,
            },
            {
              method: result.method,
              route: result.route,
              statusCode: result.statusCode,
              durationMs,
              ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
            },
          ),
        );
      },
    };
  }

  observeModelUsage(event: ModelUsageObservation): void {
    this.#bestEffort(() => this.metrics.observeModelUsage(event));
    this.#bestEffort(() => this.tracing.observeModelUsage(event));
    this.#bestEffort(() =>
      this.logger.write(
        event.isError ? "error" : "info",
        "llm.request.completed",
        {
          traceId: event.traceId,
          runId: event.runId,
          sessionId: event.sessionId,
        },
        { status: event.isError ? "failed" : "succeeded" },
      ),
    );
  }

  observeDependencies(
    dependencies: readonly { readonly name: string; readonly status: "up" | "down" }[],
  ): void {
    this.#bestEffort(() => this.metrics.observeDependencies(dependencies));
  }

  observeAdmission(observation: AdmissionMetricObservation): void {
    this.#bestEffort(() => this.metrics.observeAdmission(observation));
  }

  observeExecutionCapacity(observation: ExecutionConcurrencySnapshot): void {
    this.#bestEffort(() => this.metrics.observeExecutionCapacity(observation));
  }

  observeInfrastructure(observation: InfrastructureMetricObservation): void {
    this.#bestEffort(() => this.metrics.observeInfrastructure(observation));
  }

  metricsText(): Promise<string> {
    this.metrics.observeTracing(this.tracing.snapshot());
    return this.metrics.metrics();
  }

  async shutdown(): Promise<void> {
    this.logger.flush();
    await this.tracing.shutdown();
  }

  #bestEffort(operation: () => void): void {
    try {
      operation();
    } catch {
      // Observability is deliberately isolated from all safety and business decisions.
    }
  }
}
