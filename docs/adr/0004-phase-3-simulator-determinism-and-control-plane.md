# ADR 0004: Phase 3 simulator determinism and control-plane boundaries

- Status: Accepted
- Date: 2026-08-26

## Context

Phase 3 adds a deterministic, stateful, failure-injectable Vehicle Digital Twin without connecting it to the Phase 1 Agent Runtime or implementing Phase 4 Tool Contracts. It must reuse the Phase 2 `VehicleState`, `TripState`, runtime validation, and `Clock`, while keeping simulator-only cabin, charging, assistance, scenario, fault, history, and counter data outside the formal Phase 2 Domain.

The simulator also needs reproducible fault probability, monotonic IDs, atomic mutations, meaningful per-domain versions, bounded stale-state history, and explicit test-only controls.

## Decision

- `SimulatorState` aggregates the validated Phase 2 vehicle and trip states with simulator-specific cabin, charging, assistance, scenario, seed, `simulationVersion`, and `updatedAt` data. Simulator-only data is not added to `@driveguard/domain`.
- Every mutation is serialized within one `VehicleSimulator` instance. The transition layer constructs a complete candidate, validates the relevant Phase 2 state and the complete simulator state, and commits once. A failed transition leaves the current state and deterministic ID counters unchanged.
- `simulationVersion` increments for every successful mutation. `vehicle.version` increments only when formal vehicle state changes, and `trip.version` increments only when formal trip state changes.
- Production uses `SystemClock`; tests and deterministic replay use `FixedClock`. Core state and transition logic do not call `Date.now()` or `Math.random()` directly.
- Deterministic fault decisions use a stable 32-bit seed, explicit target namespace, and per-target monotonic call sequence. Route, reservation, and assistance IDs use seed-qualified per-namespace monotonic counters.
- Reset reloads a validated built-in scenario at version 1 and clears faults, reservations, assistance requests, state history, and all deterministic counters.
- State history retains at most 10 validated snapshots. A stale vehicle or trip read selects the most recent retained state with a lower corresponding domain version; it never mutates current state.
- Fault configuration accepts only enumerated target IDs and modes. `stale_response` is restricted to vehicle/trip reads. `timeout` waits for configured `delayMs` and returns a structured 504 only if the client has not already timed out; `connection_abort` terminates the underlying HTTP response.
- `/simulator/*` is a test/control plane and must not be exposed by a production gateway. Phase 3 has no Agent-to-Simulator production connection.
- Simulator liveness has no dependency checks. Readiness validates registry initialization and current state only; it does not depend on DeepSeek, PostgreSQL, Redis, or NATS.

## Consequences

- Replaying the same scenario, seed, and action/fault-call sequence produces the same state, IDs, and fault decisions when the injected clock is also the same.
- Serialization is process-local and intentionally does not provide a distributed lock.
- History and counters are finite, process-local, and reset on simulator reset or process restart.
- A future production deployment must exclude or separately protect `/simulator/*`; production gateway design belongs to a later authorized phase.
- Phase 1 `PHASE_1_FIXTURE_ONLY` tools remain disconnected and unchanged.
