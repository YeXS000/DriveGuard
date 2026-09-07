# Phase 14.1 bottleneck analysis

## Load curve

All rows are five-minute mixed-workload executions against the full production topology.
`Expected success` includes intentional stale-context `409 REPLAN_REQUIRED`; it excludes ordinary
`SESSION_BUSY` and HTTP 500 responses.

|  VU | Requests | req/s | Expected success |   P50 ms |    P95 ms |    P99 ms | Peak RSS MiB | Peak event-loop P99 ms |
| --: | -------: | ----: | ---------------: | -------: | --------: | --------: | -----------: | ---------------------: |
|   1 |    2,695 |  8.98 |          100.00% |   110.48 |    291.78 |    345.97 |       460.25 |                  51.05 |
|   5 |    1,786 |  5.93 |          100.00% |   811.61 |  2,141.55 |  2,758.59 |       734.48 |                 115.28 |
|  10 |    1,420 |  4.70 |          100.00% | 2,365.42 |  6,396.60 |  6,810.70 |       963.86 |                 238.42 |
|  20 |    1,987 |  6.49 |           78.16% | 1,296.11 | 11,336.72 | 11,994.12 |     1,241.42 |                 495.98 |

At 20 VU, application metric deltas recorded 596 HTTP 200, 375 HTTP 409, 105 HTTP 500, and one
controlled HTTP 503 for message routes. Of the 409 responses, 46 were valid stale-context replans;
the remaining 329 were non-contract `SESSION_BUSY`. Thus the k6 gate recorded 434 unexpected
responses: 329 busy plus 105 HTTP 500. There were no request timeouts.

## Maximum sustainable load and saturation

The largest short-window level with both stable throughput and a passing response contract was
**1 VU at 8.98 req/s**. Five and ten VU preserved response classification but reduced throughput
and sharply increased latency, so they are not designated sustainable. A 30-minute stable
throughput was not established.

The first saturation point was **20 VU**. Higher requested levels (50/100/200 load and
250/300/400 dedicated stress) were not executed after this earlier unsafe failure mode. This is an
evidence-based stop, not an inferred high-concurrency result.

## First bottleneck

The first bottleneck is the single-process API/Agent session path:

- API CPU reached a plateau of about 1.13 average cores at 5, 10, and 20 VU on an 8-CPU host.
- Event-loop P99 increased from 51 ms at 1 VU to 496 ms at 20 VU.
- API RSS increased from a 460 MiB peak at 1 VU to 1,241 MiB at 20 VU.
- PostgreSQL waiting, admission queue, Executor queue, and NATS pending all remained 0.
- NATS and database backlog were therefore not the first saturation mechanism.

The long-run component is consistent with unbounded per-session conversation growth. The harness
correctly reuses a session per VU; the runtime restores and retains the full conversation history.
After validation, PostgreSQL contained 10,277 conversation messages and 13,823 audit events. In
the soak, Agent message throughput fell as the same session grew.

## Backpressure decision

Memory and queue depth remained bounded during the 20-VU run; the API did not restart and was not
OOM-killed. However, overload was not consistently converted to controlled `429`/`503` responses:
105 HTTP 500 and 329 non-contract busy responses reached the client. Backpressure is therefore
**FAIL**, even though the process recovered and dependency queues stayed bounded.

## Soak drift

The one-VU soak completed 30 minutes with 6,895/6,895 scenario-contract checks and no timeouts.
It did not demonstrate queue, handle, DB-connection, or NATS accumulation. It did demonstrate
material performance drift:

| Interval  | Agent runs | Message req/s | Mean Agent latency ms | Agent P95 histogram upper bound |
| --------- | ---------: | ------------: | --------------------: | ------------------------------: |
| 0-10 min  |      2,566 |          4.27 |                182.21 |                           0.5 s |
| 10-20 min |      1,047 |          1.74 |                454.26 |                           1.0 s |
| 20-30 min |        867 |          1.44 |                550.17 |                           1.0 s |

RSS was 171 MiB cold, 538 MiB at 10 minutes, 541 MiB at 20 minutes, and 569 MiB at 30 minutes;
heap used was non-monotonic and peaked at 297 MiB. Handles stabilized at 13, PG waiting and NATS
pending stayed 0, and no queue accumulated. The evidence does not prove a memory leak, but the
66% message-throughput decline and threefold mean-latency increase are sufficient to mark the soak
gate **FAIL**.

## Recommended next scope

A separately authorized remediation should bound or summarize per-session conversation context,
profile serialization/prompt construction, and ensure overload maps to controlled admission
responses. This Phase 14.1 task stops at diagnosis and does not begin that refactor or a later
Docker/CI/CD phase.
