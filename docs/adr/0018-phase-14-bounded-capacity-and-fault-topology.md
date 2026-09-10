# ADR 0018: Phase 14 bounded capacity and fault topology

- Status: Accepted for Phase 14 implementation
- Date: 2026-09-06

## Context

The production factory previously created Executor capacity and circuit state per Agent runtime.
Concurrent API requests could therefore multiply effective dependency concurrency. The API also
had session-level exclusion but no process-wide bounded admission. Redis could queue commands while
offline, and shutdown had no finite drain deadline. These behaviors prevent a defensible saturation
or fault-under-load gate.

## Decision

Create one process-wide request admission controller, Executor concurrency controller, and circuit
breaker in the API bootstrap and share the latter two with normal and urgent runtimes. Bound all
queues and return controlled `503 SERVICE_BUSY` on admission or Executor capacity rejection.
Serialize side effects per vehicle across runtimes while retaining bounded concurrency across
different vehicles. Disable Redis offline queuing. Make pool, timeout, and shutdown budgets explicit.

Use k6 for request generation and Toxiproxy for non-destructive connection faults. High concurrency
must use the deterministic/faux provider; live provider use stays opt-in and capped. Export provider
stream latency separately from Tool/Executor time.

## Consequences

- Capacity is process-wide, observable, and fails closed.
- Same-vehicle side effects cannot overlap across Agent runtimes.
- Health and metrics remain reachable during stateful-route saturation.
- Queue rejection is an availability tradeoff but prevents uncontrolled memory growth.
- Complete dependency fault and soak evidence still requires a functioning container runtime; an
  unavailable runtime produces `NOT RUN`, never an inferred pass.

This ADR does not alter Policy, Confirmation, Ground Truth, scorer semantics, or the LLM/actuator
safety boundary.
