# ADR 0013: Phase 12 urgent-event handling contracts

- Status: Accepted
- Date: 2026-08-31
- Scope: Phase 12 only

## Context

DriveGuard needs a reliable path for a small set of urgent vehicle/service facts without turning
NATS into a general business bus or weakening the accepted Tool, Policy, confirmation, execution,
and persistence boundaries. A source event is evidence that something happened; it is not an
instruction to execute a Tool and it is not authoritative current world state.

## Decision

### Event model and equality binding

`UrgentEvent` is a closed, immutable TypeBox union at `schemaVersion = 1`. The first event types are
`LOW_SOC`, `CHARGING_INTERRUPTED`, `VEHICLE_FAULT`, `ROUTE_BLOCKED`, and `ASSISTANCE_REQUIRED` with
the bounded severity values `INFO`, `WARNING`, `HIGH`, and `CRITICAL`. The source-supplied severity
is accepted only as part of the transport contract; the deterministic classifier recomputes the
trusted severity from the validated event type and payload.

PostgreSQL owns `eventId` deduplication. A canonical, key-order-independent SHA-256 fingerprint of
the entire validated event is stored next to the ID, while the original payload is not stored in the
urgent-event table. Same ID and same fingerprint is a duplicate; same ID and different fingerprint
is a permanent collision rejection and goes to DLQ. This prevents an ID collision from substituting
a different candidate action.

### Deterministic priority classification

The centrally defined LOW_SOC thresholds are: CRITICAL at or below 5%, HIGH at or below 15%,
WARNING at or below 30%, and INFO above 30%. A charging interruption is HIGH; a vehicle fault is
CRITICAL only when its validated `critical` flag is true and otherwise HIGH; a route blockage is
WARNING; requested assistance is CRITICAL only for validated immediate danger and otherwise HIGH.
The LLM does not classify urgency.

The LOW_SOC action threshold is 15%, and refreshed SOC at or above 20% is considered recovered.
These planning thresholds are separate from event classification and are always applied to current
Context rather than the event's reported SOC.

### JetStream transport semantics

The bounded Phase 12 subjects are `driveguard.vehicle.events`, `driveguard.urgent.events`, and
`driveguard.urgent.dlq` in stream `DRIVEGUARD_URGENT_EVENTS`. The business consumer is the durable
pull consumer `driveguard-urgent-v1`, filtered to `driveguard.urgent.events`, with explicit ACK,
`max_deliver = 5`, one in-flight ACK, and a finite ACK wait. Publisher message IDs use `eventId` as a
transport-level optimization; PostgreSQL remains authoritative.

Successful and terminal duplicate processing ACKs. A transient failure NAKs with bounded delivery.
Malformed/permanently rejected messages publish a sanitized DLQ envelope and ACK, preventing an
infinite loop. If a consumer restarts while another PostgreSQL processing lease remains active, the
redelivery is delayed until just after that lease expires rather than being ACKed as a terminal
duplicate. The next delivery can then reacquire durable ownership. This follows the official NATS
recommendation to use pull consumers for new projects and explicit ACK/redelivery for application
controlled processing:
[NATS consumer documentation](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/jetstream/consumers.md).
The implementation was checked against the installed `@nats-io/*` 3.4.0 declarations and the
[official nats.js releases](https://github.com/nats-io/nats.js/releases).

### Durable state and recovery

`urgent_events` persists the ID/fingerprint, bounded type/vehicle/severity/status, receive/process
timestamps, correlation ID, lease owner/expiry, attempt count, and safe result metadata only. Claim
is an atomic INSERT/conditional UPDATE transaction. `RECEIVED` and `FAILED`, plus expired
`PROCESSING`, can be claimed. Terminal rows cannot be reclaimed. A completion must match both the
event ID and current processing owner.

Action, session, execution, authorization, idempotency, and audit durability continue to use the
accepted Phase 7–9 repositories. Deterministic event-derived action/execution/session/run IDs and
Executor idempotency keys allow redelivery recovery. Only recovered `SUCCEEDED` executions are
treated as handled; failed or incomplete recovered executions fail safely and remain bounded by
JetStream delivery/DLQ policy.

### Context and safety boundary

The processor reloads the current Simulator-backed `ContextProvider` before planning. The dispatcher
reloads it again immediately before Policy evaluation, checks vehicle binding, evaluates freshness
and relevant-state conflicts, validates the formal Tool contract, and then invokes the existing
Policy Engine. Event payload never substitutes for VehicleState or TripState.

R0/R1 candidates require Policy `ALLOW` and use the Reliable Executor. R2/R3 candidates require a
durable PendingAction, explicit user confirmation, Context revalidation, one-time execution
authorization, and the Reliable Executor. `CRITICAL` does not bypass confirmation. No RX capability
is registered or mapped, and neither the NATS layer nor API/HMI can mutate the Simulator directly.

### Notification and observability

The existing API/HMI gains a filtered urgent history projection and an additive SSE stream with
`urgent.received`, `urgent.action_required`, `urgent.confirmation_required`, `urgent.resolved`, and
`urgent.failed`. History contains only safe summaries/status/action/execution identifiers; it never
returns the original NATS payload. SSE identity is bound to the configured user and request vehicle.

Phase 11 receives the required urgent logs, bounded Prometheus metrics, and the trace chain
`nats.consume -> urgent.process -> context.load -> policy.evaluate -> executor.execute` or
`confirmation.wait`. Event, vehicle, session, run, and trace identifiers are correlation fields, not
Prometheus labels. Observability remains best effort and cannot change business settlement.

## Consequences and limitations

- The urgent consumer intentionally runs in the API process so the trusted confirmation credential
  can be delivered through the existing in-process SSE boundary without a second credential bus.
- The notification hub itself is process-local and non-replayable. PostgreSQL-backed safe history
  restores event state after reconnect/restart, but a missed confirmation credential is not exposed
  by history; production notification replay/authentication is future work.
- One configured `URGENT_EVENT_USER_ID` is a development identity boundary, consistent with Phase 10;
  production multi-user routing and OAuth remain future work.
- Stream retention is seven days and the transport duplicate window is two minutes. PostgreSQL
  deduplication remains authoritative beyond both intervals.
- Phase 13 benchmark/evaluation work, a global business event-bus refactor, large stress tests, RX
  control, and direct safety-critical actuation are explicitly excluded.
