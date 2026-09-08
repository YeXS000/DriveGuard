# Fault model

## Injection topology

`compose.toxiproxy.yml` places Toxiproxy between the API and PostgreSQL, Redis, NATS, and the
Simulator. `toxiproxy.json` defines fixed proxy names and ports. `toxiproxy-fault.mjs` supports
latency, connection reset, dependency down/up, and toxic clearing without accepting arbitrary
targets.

Application/simulator fixtures cover deterministic HTTP 503, timeout, connection abort,
dependency unavailable, definite write failure, ambiguous write, reconciliation, and duplicate
requests. Fault-under-load tests use the real Reliable Executor and shared concurrency controller.

## Expected outcomes

| Fault                                  | Required terminal behavior                                |
| -------------------------------------- | --------------------------------------------------------- |
| Retry-safe read 503/timeout            | bounded retry, recovered or explicit failure              |
| Definite write failure                 | explicit failure; retry only when policy declares it safe |
| Ambiguous write                        | `OUTCOME_UNKNOWN` and reconciliation; no blind retry      |
| Redis unavailable                      | explicit degradation/failure; never bypass Confirmation   |
| PostgreSQL unavailable/pool exhaustion | explicit failure; no uncommitted success                  |
| NATS redelivery/backlog                | at-least-once receipt plus application idempotency        |
| Simulator unavailable/reset/latency    | recovered or safe-degraded; never false success           |

For every fault the hard assertions are: process crash 0, false success 0, blind ambiguous retry 0,
duplicate side effect 0, forbidden action 0, confirmation bypass 0, state corruption 0, and
cross-session contamination 0.

## Non-destructive operation

The proxy layer changes connections only. It does not truncate databases, delete volumes, mutate
Ground Truth, or modify scorer semantics. The Docker runtime blocker and consequently unexecuted
proxy scenarios are recorded in the final report rather than inferred as passing.
