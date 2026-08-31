# ADR 0012: Phase 11 observability contracts

- Status: Accepted
- Date: 2026-08-31
- Scope: Phase 11 only

## Context

DriveGuard needs correlated logs, metrics, and traces from the HTTP boundary through Agent Runtime,
Policy, Confirmation, Reliable Executor, and formal Tool/dependency calls. Observability must remain a
read-only projection of already accepted business events and must never weaken safety behavior when an
observer or backend fails.

## Decision

### Logging contract and redaction

Production API logs use one Pino-based logger. Every typed business record contains `timestamp`,
`level`, `service`, `event`, `traceId`, `runId`, and `sessionId`; bounded optional fields add action,
execution, Tool, Policy, duration, attempt, status, and safe error-code context. A centralized Pino
redaction list removes authorization/cookie/confirmation/execution credentials, API keys, prompts,
reasoning, and chain-of-thought paths. Runtime composition also redacts the active provider key by
value. Callers do not log raw user input or internal exception messages.

### Trace and span model

OpenTelemetry owns the 32-hex trace ID at the HTTP boundary, and that ID is passed unchanged into the
existing Runtime event model. Event observers build `http.request`, `agent.run`, `context.load`,
`capability.resolve`, `llm.request`, `tool.request`, `policy.evaluate`, `confirmation.wait`,
`confirmation.revalidate`, `executor.execute`, `executor.attempt`, `tool.execute`,
`simulator.request`, `dependency.http`, and post-commit `persistence.write` spans. Business spans carry
the applicable run/session/action/execution/Tool correlation attributes. An OTLP HTTP exporter is
enabled only when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is configured. Tests may opt into an in-memory
exporter; production does not retain an unbounded in-memory span history.
Only active Agent-run parents are retained across asynchronous business events, and that cache is
bounded to 4,096 entries. Completed health and metrics requests are never retained as future parents.

### Metrics and cardinality

Prometheus metrics use the official `@prometheus-io/client` package and the `driveguard_` namespace.
Labels are limited to bounded dimensions such as route template, method, status code, terminal status,
formal Tool name, Policy decision, confirmation event, safe error code, model name, token direction,
dependency, and circuit state. User, session, run, trace, action, execution, prompt, and payload values
are forbidden as metric labels. Histograms measure API, Agent, Tool, Policy, and execution duration;
counters/gauges cover requests, runs, decisions, confirmation, attempts, retries, circuit state, LLM
usage/cost, Context conflicts, and dependency readiness.

The previous `prom-client` package is deprecated in favor of `@prometheus-io/client`; Phase 11 uses
the maintained replacement without changing the public metric names required by `DriveGuard.md`.

### Safety isolation

Observability sinks run only after primary durable audit/event sinks. Each log, metric, and trace
observer is isolated independently and cannot change Policy output, confirmation state, execution
authorization, retry/idempotency/circuit logic, or Tool dispatch. Readiness probes publish dependency
gauges but preserve the existing health result and do not depend on Prometheus, Grafana, or OTLP.

### Deployment and dashboard

The API exposes Prometheus text at `GET /metrics`. Compose adds pinned Prometheus `v3.13.1` and
Grafana `13.2.0` services, a provisioned Prometheus datasource, and one compact dashboard with Agent,
Safety, Reliability, and Infrastructure sections. Dashboard queries use only the bounded metrics
above. Grafana credentials remain environment-provided and are not stored in provisioning files.

## Consequences and limitations

- Event-driven spans represent completed durable writes and formal execution attempts; they do not
  instrument every internal helper or database driver call.
- Without a configured OTLP endpoint, production spans are created and ended but not exported. This
  avoids an implicit in-process trace store; external trace retention is an operator configuration.
- Prometheus process metrics intentionally use a distinct `driveguard_process_` prefix.
- Observability does not participate in business decisions and does not add RX tools.
- Phase 12 urgent-event handling, NATS business publishers/consumers, Phase 13 evaluation, load
  testing, and large safety matrices are explicitly excluded.
