import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Phase 11 architecture and configuration contracts", () => {
  it("does not declare any forbidden high-cardinality metric label", () => {
    const metrics = source("packages/observability/src/metrics.ts");
    for (const label of ["userId", "sessionId", "runId", "traceId", "actionId", "prompt"]) {
      expect(metrics).not.toMatch(new RegExp(`labelNames:[^\\n]*["']${label}["']`, "u"));
    }
  });

  it("keeps the observability package independent of Policy and safety implementations", () => {
    const packageJson = JSON.parse(source("packages/observability/package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies).not.toHaveProperty("@driveguard/policy");
    expect(source("packages/observability/src/system.ts")).not.toMatch(
      /PolicyEngine|ConfirmationService|ReliableToolExecutor/u,
    );
  });

  it("makes observability delivery explicitly best effort after durable audit", () => {
    const production = source("apps/api/src/production.ts");
    expect(production.indexOf("await durable.emit(event)")).toBeLessThan(
      production.indexOf("await observer?.emit(event)"),
    );
    expect(production).toContain("Observability must not change Runtime settlement");
    expect(production).toContain("Observability must not change confirmation state transitions");
  });

  it("exposes only Prometheus text from the metrics endpoint", () => {
    const app = source("apps/api/src/app.ts");
    expect(app).toContain('app.get("/metrics"');
    expect(app).toContain("metricsText()");
    expect(app).not.toMatch(/metrics.*prompt|metrics.*confirmationCredential/iu);
  });

  it("does not add observability backends to readiness semantics", () => {
    const app = source("apps/api/src/app.ts");
    const readyHandler = app.slice(
      app.indexOf('"/health/ready"'),
      app.indexOf('app.addHook("onClose"'),
    );
    expect(readyHandler).not.toMatch(/prometheus|grafana|otel|opentelemetry/iu);
  });

  it("does not retain health-request parents and bounds cross-request Agent correlation", () => {
    const tracing = source("packages/observability/src/tracing.ts");
    expect(tracing).toContain("MAX_RETAINED_TRACE_PARENTS = 4_096");
    expect(tracing).not.toContain("this.#traceParents.set(traceId, active.context)");
    expect(tracing).toContain("this.#traceParents.size <= MAX_RETAINED_TRACE_PARENTS");
  });

  it("closes HTTP observations when a client aborts the request", () => {
    const app = source("apps/api/src/app.ts");
    expect(app).toContain('app.addHook("onRequestAbort"');
    expect(app).toContain('setRequestErrorCode(request, "REQUEST_ABORTED")');
    expect(app).toContain("finishRequestObservation(request, 499)");
    expect(app).toContain('reply.raw.once("close"');
    expect(app).toContain("if (reply.raw.writableEnded) return");
  });

  it("keeps every required Compose service", () => {
    for (const service of [
      "postgres",
      "redis",
      "nats",
      "api",
      "vehicle-simulator",
      "hmi",
      "prometheus",
      "grafana",
    ]) {
      expect(source("docker-compose.yml")).toMatch(new RegExp(`^  ${service}:`, "mu"));
    }
  });

  it("configures Prometheus to scrape the API metrics endpoint", () => {
    const prometheus = source("infra/observability/prometheus.yml");
    expect(prometheus).toContain("metrics_path: /metrics");
    expect(prometheus).toContain('targets: ["api:3000"]');
  });

  it("provisions the Prometheus Grafana datasource without a credential", () => {
    const datasource = source(
      "infra/observability/grafana/provisioning/datasources/prometheus.yml",
    );
    expect(datasource).toContain("uid: driveguard-prometheus");
    expect(datasource).toContain("url: http://prometheus:9090");
    expect(datasource).not.toMatch(/password|token|secret/iu);
  });

  it("uses every required real metric in the provisioned dashboard", () => {
    const dashboard = source(
      "infra/observability/grafana/dashboards/driveguard-observability.json",
    );
    for (const metric of [
      "driveguard_http_requests_total",
      "driveguard_http_request_duration_seconds_bucket",
      "driveguard_agent_runs_total",
      "driveguard_agent_run_duration_seconds_bucket",
      "driveguard_tool_calls_total",
      "driveguard_policy_decisions_total",
      "driveguard_confirmations_total",
      "driveguard_executions_total",
      "driveguard_retries_total",
      "driveguard_circuit_state",
    ]) {
      expect(dashboard).toContain(metric);
    }
  });

  it("contains no Phase 12 urgent event or NATS business orchestration implementation", () => {
    const changedImplementation = [
      source("packages/observability/src/system.ts"),
      source("apps/api/src/production.ts"),
      source("apps/api/src/app.ts"),
    ].join("\n");
    expect(changedImplementation).not.toMatch(
      /VehicleEventBus|vehicle\.low_soc|JetStream|publish\(/u,
    );
  });
});
