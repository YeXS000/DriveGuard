# Phase 14.2 Backpressure Design

## Bounded request path

```text
HTTP stateful route
  -> process-wide admission (20 active, 32 queued, 500 ms queue deadline)
  -> per-session single-flight lane
  -> identity-bound Agent Runtime cache (LRU, capacity = admission concurrency)
  -> Executor capacity (4 reads / 8 writes, bounded queue)
  -> Policy -> Confirmation -> Reliable Executor -> dependency or Simulator
```

Admission ownership is resolved before Runtime work. Idempotency conflict and single-flight
ownership are resolved before Executor capacity waiting, so duplicate requests cannot consume a
second execution permit.

## Error contract

`AdmissionRejected`, session-lane busy/lease loss, queue full/timeout, and Executor saturation are
capacity outcomes. Externally they are `503 SERVICE_BUSY` and include `Retry-After`. They are not
HTTP 500 and do not expose internal `SESSION_BUSY`.

Dependency failure remains `503 DEPENDENCY_UNAVAILABLE`; identity mismatch fails closed and is not
reclassified as load shedding. Queues and retries remain finite.

## Measured operating boundary

|  Load | Iterations | Throughput |         Agent P50/P95/P99 ms | Controlled 503 | 500 / external busy |  RSS peak | Queue max | Result                |
| ----: | ---------: | ---------: | ---------------------------: | -------------: | ------------------: | --------: | --------: | --------------------- |
| 20 VU |     11,653 |    96.53/s |     315.67 / 517.60 / 624.26 |              0 |               0 / 0 | 250.6 MiB |         0 | Sustainable           |
| 50 VU |      9,893 |    80.06/s | 634.53 / 3,107.56 / 4,819.63 |          3,975 |               0 / 0 | 251.9 MiB |        30 | Saturated, controlled |

Average API CPU was 1.19 cores at 20 VU and 1.74 cores at 50 VU. The final container remained
healthy with restart 0 and OOM false. Therefore the measured maximum sustainable load is 20 VU,
and the measured saturation point is 50 VU.

The 160 MiB V8 old-space ceiling is a guardrail, not the root-cause fix. Earlier attempts with 32
active requests crossed the heap limit at 50 VU; that failed run is retained separately. The final
20/32 admission boundary prevents the transient working set from becoming an uncontrolled process
failure.
