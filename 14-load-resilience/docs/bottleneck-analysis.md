# Bottleneck analysis

## Evidence collected

The short local HTTP fallback used a warmed Fastify process, a 2 ms synthetic handler, 32 active
request permits, a 64-entry queue, a 100 ms queue deadline, and 1,000 requests at each concurrency
level. It deliberately excluded PostgreSQL, Redis, NATS, Simulator, and an LLM, so it is capacity
evidence for admission behavior only.

| Concurrency | Throughput req/s | P50 ms | P95 ms | P99 ms | Success | Controlled busy | Other errors |
| ----------: | ---------------: | -----: | -----: | -----: | ------: | --------------: | -----------: |
|           1 |           314.15 |   3.09 |   3.49 |   4.28 |    1000 |               0 |            0 |
|           5 |          1365.51 |   3.58 |   4.58 |   5.34 |    1000 |               0 |            0 |
|          10 |          2454.32 |   3.94 |   5.45 |   6.62 |    1000 |               0 |            0 |
|          20 |          4372.03 |   4.39 |   6.76 |   7.92 |    1000 |               0 |            0 |
|          50 |          4907.61 |   7.70 |  30.14 |  43.38 |    1000 |               0 |            0 |
|         100 |          5553.85 |  11.46 |  44.76 | 148.31 |    1000 |               0 |            0 |
|         200 |          4923.98 |  14.93 | 166.86 | 170.85 |     963 |              37 |            0 |

Event-loop delay was 11.34 ms P95 and 17.12 ms P99. Short-run RSS changed from 123,068,416 to
163,438,592 bytes (+32.80%). This is not a leak determination; the run is too short and includes V8
heap growth after warmup.

## Observed saturation

The first observed local saturation signal is the deliberately bounded API admission limit at
concurrency 200. Queue deadlines produced 37 controlled busy responses, throughput fell from
5,553.85 to 4,923.98 req/s, and P95 rose above the 100 ms backend target. The process did not crash
and returned no uncontrolled errors.

This is not a production saturation point: the complete dependency topology was unavailable. No
claim is made about PostgreSQL pool, Redis, JetStream, Simulator, or Agent sustainable throughput.

## Change comparison

Before Phase 14 there was no process-wide admission boundary, so overload behavior and maximum
in-flight work were not bounded or measurable. After the minimal change, the measured local limit
is 32 active plus 64 queued requests, with excess work failing as controlled `503 SERVICE_BUSY`.
The evidence supports bounded degradation, not an overall production capacity PASS.
