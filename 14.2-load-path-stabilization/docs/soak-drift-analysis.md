# Phase 14.2 Soak Drift Analysis

## Frozen acceptance criteria

Frozen before the final run on 2026-09-07. They will not be changed after results are known.

- duration: at least 30 minutes
- last-10-minute Agent mean latency: at most 1.20 times the first-10-minute mean
- last-10-minute throughput: at least 0.80 times the first-10-minute throughput
- no monotonic admission, executor, PostgreSQL-pool, NATS, handle, or active-span growth
- no connection leak, process crash, OOM, uncontrolled `SESSION_BUSY`, or unexpected HTTP 500
- runtime model context: at most 40 recent durable conversation messages; durable transcript remains complete
- Prometheus labels remain bounded and do not include request, trace, session, action, or idempotency IDs

## Final result

**PASS**. The uninterrupted run lasted 1,800.17 seconds and completed 48,583 iterations at
26.99 iterations/s. All 48,583 scenario checks passed. It recorded 3,880 expected safe replans and
zero unexpected HTTP 500, external `SESSION_BUSY`, controlled 503, timeout, crash, or OOM.

| Window           | Successful Agent runs | Expected safe replans | Mean Agent latency | Successful throughput |
| ---------------- | --------------------: | --------------------: | -----------------: | --------------------: |
| First 10 minutes |                 9,144 |                 1,280 |          52.551 ms |              15.234/s |
| Last 10 minutes  |                 9,313 |                 1,304 |          51.604 ms |              15.508/s |

- latency ratio: 0.982, requirement <= 1.20, PASS
- throughput ratio: 1.018, requirement >= 0.80, PASS
- whole-run Agent P50/P95/P99: 61.882/83.924/106.444 ms

## Resource evidence

| Minute | RSS MiB | Heap used MiB | Active handles | Active resources | Admission queue | Metric series |
| -----: | ------: | ------------: | -------------: | ---------------: | --------------: | ------------: |
|      0 |   101.2 |          36.2 |             10 |               15 |               0 |           266 |
|     10 |   196.9 |          71.2 |             13 |               21 |               0 |           424 |
|     20 |   220.2 |         101.1 |             13 |               21 |               0 |           424 |
|     30 |   234.0 |         114.7 |             13 |               20 |               0 |           424 |

Observed peaks were RSS 235.2 MiB, heap used 129.0 MiB, 14 handles, 26 active resources, and 426
metric series. PostgreSQL waiting, NATS pending, and admission backlog stayed zero. Observability
retained-state gauges were transient (maximum five across all samples) and returned to zero at the
end. RSS warmed up but its slope decayed; operational state, queues, handles, and metric cardinality
did not grow monotonically. The configured 160 MiB old-space ceiling bounds the V8 heap.

Earlier 128, 192, and 256 MiB experiments are retained as diagnostic or failed evidence and are not
substituted into this result. The final load image later changed the admission/cache ceiling from 16
to 20; at one VU the effective cache occupancy and admission path remain one, so the frozen soak
workload and executed code path are unchanged.
