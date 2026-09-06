# Load-test design

## Latency layers

| Layer                 | Measurement                                                         | Included                                                     |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Backend overhead      | k6 `backend_overhead_ms` and HTTP histogram                         | routing, serialization, application bookkeeping; no real LLM |
| Agent end-to-end      | k6 `agent_end_to_end_ms` and Agent run histogram                    | LLM, Tool, Policy, Executor, response                        |
| External dependencies | provider-only histogram, Tool/Executor histograms, dependency spans | LLM stream, Simulator/tool backend, external service         |

The provider histogram ends on the assistant `message_end` event, before Tool execution. Tool and
Executor durations remain separate, so their time is not folded into provider P95.

## Scenarios

`k6-load.js` implements `READ_ONLY`, `NO_TOOL`, `SIMPLE_TOOL`, `MULTI_TOOL`,
`PROTECTED_ACTION`, `FAULT_RECOVERY`, and `MIXED_WORKLOAD`. The mixed distribution is 35% read,
20% no-tool, 25% simple-tool, 10% multi-tool, 8% protected action, and 2% fault-recovery.

`run-k6-matrix.mjs` defines:

| Profile      | Concurrency       | Duration per point                    |
| ------------ | ----------------- | ------------------------------------- |
| baseline     | 1                 | backend 5 min; Agent paths 1 min each |
| load         | 1, 5, 10, 20, 50  | 5 min                                 |
| stress       | 75, 100, 150, 200 | 2 min                                 |
| backpressure | 200               | 2 min                                 |
| soak         | 20                | 30 min                                |

Every run writes raw k6 summary JSON. The matrix runner samples `/metrics` at start, every 30 s,
and end. Reports therefore retain request count, throughput, P50/P95/P99, HTTP status, timeout,
CPU/process metrics, queue depth, PostgreSQL pool use, Redis readiness, and NATS backlog when the
production topology is available.

## Provider modes

- `faux`: deterministic local provider for all capacity, load, stress, backpressure, and soak work.
- live: small E2E verification only. The matrix runner rejects a live-provider profile above 5 VUs.

## Gate interpretation

Backend overhead requires P95 below 100 ms. Agent Simple/Multi P95 is compared with the frozen
3220.14/2564.85 ms baseline and must not regress by more than 20% without a documented cause.
Controlled 429/503 responses identify bounded saturation; they are not counted as successful work.
No sustainable load is claimed unless the complete production dependency topology is measured for
the requested duration.
