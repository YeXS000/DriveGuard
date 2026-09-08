# Phase 14.2 Root Cause Analysis

## Scope

This analysis is limited to the two Phase 14.1 gate blockers: uncontrolled load-path failures and
30-minute latency/throughput drift. Policy, Confirmation, Reliable Executor semantics, Ground
Truth, and Scorer behavior were not redesigned.

## 20-VU failure classification

The Phase 14.1 run produced 434 contract violations in 1,987 responses: 105 HTTP 500, 329 external
`SESSION_BUSY`, and one controlled 503. Investigation separated three causes:

1. The original harness could not reliably distinguish fresh-session load from same-session
   contention or classify the response error code. It also allowed identities to collide across
   repeated invocations. The corrected harness assigns a unique run, user, session, and vehicle
   identity to every VU and supports explicit `per_vu` and `per_iteration` modes.
2. Session persistence and lease failures crossed the Runtime/API boundary too generically.
   Capacity-related lease loss appeared as external `SESSION_BUSY`, while other persistence
   failures could become HTTP 500. The Runtime now classifies identity mismatch, lease loss, and
   dependency failure separately; the API maps capacity to `503 SERVICE_BUSY`.
3. Production created a complete Agent Runtime for every message. Under concurrency this caused
   high allocation/GC churn before admission could settle, so increasing capacity alone merely
   shifted the failure to process memory pressure.

The corrected and bounded final matrix proves the classification: 20 and 50 VU both produced zero
unexpected HTTP 500 and zero external `SESSION_BUSY`. At 50 VU, overload was expressed only as
3,975 controlled 503 responses.

## Soak drift isolation

The five-way isolation matrix showed the backend itself was not the bottleneck:

| Path                       | Iterations/s | Agent P95 ms |
| -------------------------- | -----------: | -----------: |
| Backend only               |     1,121.19 |          n/a |
| No Tool, fresh session     |        14.46 |        62.73 |
| No Tool, same session      |        11.49 |       121.49 |
| Simple Tool, fresh session |         4.46 |       304.33 |
| Simple Tool, same session  |         4.56 |       353.60 |

Heap/profile evidence showed a small live heap after full collection but heavy allocation and GC
while rebuilding runtime/model/provider adapters per request. A five-minute same-session probe
before runtime reuse completed 3,159 iterations at 10.52/s with Agent P95 275.29 ms. After reuse it
completed 8,078 at 26.91/s with Agent P95 85.07 ms. Runtime reconstruction was therefore the main
drift cause, not PostgreSQL, NATS, or a growing Executor queue.

Additional unbounded process-local state could amplify long runs: full transcript restoration,
issued run/event ID sets, and retained trace-parent references. Those structures are now bounded;
durable business state and the complete audit transcript remain in persistence.

## Minimal correction

- Reuse one identity-bound Runtime per active session, with LRU capacity tied to API admission.
- Restore only the most recent 40 durable conversation messages into model context and trim on a
  user-turn boundary; do not delete the durable transcript.
- Bound issued run/trace IDs to 4,096 and event IDs to 16,384.
- Retain trace-parent context only while confirmation is pending and expose retained counts as
  bounded metrics.
- Keep admission and Executor queues finite and map capacity failures to `503 SERVICE_BUSY` with
  `Retry-After`.

The Policy -> Confirmation -> Reliable Executor -> Simulator path remains unchanged.

## Evidence integrity

Failed and diagnostic runs remain in separately named directories. They are not combined with the
final result. The final 30-minute soak and final 20/50-VU load matrix are reported independently
with their own image/configuration metadata.
