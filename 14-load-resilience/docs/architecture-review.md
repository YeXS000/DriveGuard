# Architecture review

## Request and side-effect path

The inspected runtime preserves the required path:

```text
Fastify API
  -> bounded request admission
  -> per-session Agent Runtime
  -> Tool Contract
  -> deterministic Policy
  -> Confirmation / Action State Machine
  -> shared bounded Reliable Executor
  -> Simulator / external service
  -> PostgreSQL persistence and audit
```

Redis is a non-authoritative session/cache hint and must not cause a safety fail-open. NATS
JetStream uses a durable consumer and application-level idempotency. The LLM cannot call RX or
vehicle-actuator capabilities.

## Existing mechanisms found before changes

- Fastify API with session-level active-request exclusion.
- PostgreSQL durable session leases, action records, execution records, audit, and idempotency.
- Redis cache/hints with PostgreSQL as authority.
- JetStream durable consumer with `max_ack_pending=1`.
- Executor timeouts, retry classification, reconciliation, idempotency, and
  `CLOSED -> OPEN -> HALF_OPEN` circuit breaking.
- Simulator control-plane fault modes.
- Prometheus metrics and OpenTelemetry traces.

## Gaps found

- No process-wide bounded API/Agent admission queue.
- Executor concurrency and circuit state were constructed per request rather than shared by the
  production service.
- No process-level Executor queue limit or same-vehicle serialization across runtimes.
- PostgreSQL pool and request/shutdown budgets were not explicit runtime configuration.
- Pool pressure, queue depth, and LLM-provider-only latency were not separately exported.
- Shutdown did not have a finite drain deadline.
- No repeatable k6 or dependency-proxy fault matrix.

## Minimal Phase 14 changes

- A bounded FIFO request admission controller protects all `/v1/` stateful routes. Health and
  metrics bypass it so operators can diagnose saturation.
- One production-wide Executor concurrency controller limits reads to 4, writes to 8, serializes
  side effects for the same vehicle, and defaults to a 256-entry queue with a 5 s wait budget.
- One production-wide circuit breaker is shared by normal and urgent runtimes.
- PostgreSQL pool size and connection/idle timeouts, Agent timeout, admission limits, Executor
  limits, and shutdown deadline are explicit validated environment settings.
- Redis offline queuing is disabled; outage returns an explicit dependency failure instead of an
  unbounded client backlog.
- Graceful shutdown stops admission first, drains within a deadline, then cancels unsettled Agent
  runs and closes Fastify connections.
- Metrics expose admission, Executor, PostgreSQL pool, Redis readiness, NATS pending/ack-pending,
  and LLM-provider-only duration.

## Timeout budget

```text
HTTP connection / graceful drain: 30 s default
Agent run:                         15 s default
Executor queue wait:               5 s default
Tool attempt:                     Tool contract timeoutHintMs
PostgreSQL connect:                1.5 s default
Recovery:                         Executor retry/reconciliation policy, never blind ambiguous retry
```

Agent timeout calls `cancel()` and still awaits run settlement. It does not detach a protected
write after the HTTP response has completed.
