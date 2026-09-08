# Phase 14 final report

## Gate result: FAIL

The implementation and all executable local safety, capacity, shutdown, isolation, recovery, and
regression checks pass. The complete production-topology load/stress/soak and Toxiproxy dependency
fault matrices could not run because the Docker daemon was unavailable. Therefore sustainable
production throughput, dependency saturation, persisted restart behavior, and leak/backlog gates
remain unverified. They are not inferred from local fixtures.

## Environment

| Component  | Observed or declared value                           | Verification                     |
| ---------- | ---------------------------------------------------- | -------------------------------- |
| CPU        | Intel Core i9-14900HX, 8 logical CPUs visible to WSL | observed                         |
| RAM        | 16,483,852,288 bytes                                 | observed                         |
| OS         | Ubuntu 24.04, WSL2 kernel 6.6.87.1                   | observed                         |
| Node / npm | 22.22.1 / 10.9.4                                     | observed                         |
| k6         | 2.2.0 Linux amd64, release SHA-256 verified          | observed                         |
| Docker     | CLI 28.1.1; daemon unavailable                       | client only                      |
| PostgreSQL | `postgres:17-alpine`, pool max 20                    | Compose declaration, not running |
| Redis      | `redis:8-alpine`, offline queue disabled             | Compose declaration, not running |
| NATS       | `nats:2.11-alpine`, JetStream durable consumer       | Compose declaration, not running |
| Simulator  | existing DriveGuard vehicle-simulator service        | local tests only                 |
| Toxiproxy  | pinned `ghcr.io/shopify/toxiproxy:2.12.0`            | Compose validated, not running   |

The intended topology is Fastify -> bounded admission -> Agent Runtime -> Policy -> Confirmation ->
shared bounded Executor -> dependency/Simulator -> PostgreSQL/audit, with Redis hints and a NATS
JetStream durable consumer.

## Baseline

The 5-minute k6 backend-only baseline used one VU against a local Fastify probe and no LLM or
external dependency. It completed 589,039 requests at 1,963.46 req/s with 100% success, 0 timeout,
and 0 HTTP failure.

| Metric           |      P50 |      P95 |      P99 |      Max |
| ---------------- | -------: | -------: | -------: | -------: |
| Backend overhead | 0.424 ms | 0.530 ms | 0.617 ms | 8.102 ms |

The measured backend-only P95 passes the `<100 ms` target for this bounded local scope. DB, Redis,
NATS, Agent, and external latency baselines are `NOT RUN`, so the production performance gate is
not complete.

## Local load curve and saturation

The warmed fallback curve used 1,000 requests per point, a 2 ms handler, 32 active permits, 64
queued requests, and a 100 ms queue timeout. Full data, including per-level CPU time, is retained in
`reports/baseline/local-capacity.json`.

| Concurrency |   req/s | P50 ms | P95 ms | P99 ms | Success | Controlled 503 | Other error |
| ----------: | ------: | -----: | -----: | -----: | ------: | -------------: | ----------: |
|           1 |  314.15 |   3.09 |   3.49 |   4.28 |    1000 |              0 |           0 |
|           5 | 1365.51 |   3.58 |   4.58 |   5.34 |    1000 |              0 |           0 |
|          10 | 2454.32 |   3.94 |   5.45 |   6.62 |    1000 |              0 |           0 |
|          20 | 4372.03 |   4.39 |   6.76 |   7.92 |    1000 |              0 |           0 |
|          50 | 4907.61 |   7.70 |  30.14 |  43.38 |    1000 |              0 |           0 |
|         100 | 5553.85 |  11.46 |  44.76 | 148.31 |    1000 |              0 |           0 |
|         200 | 4923.98 |  14.93 | 166.86 | 170.85 |     963 |             37 |           0 |

The first observed local bottleneck is bounded API admission at concurrency 200: P95 exceeds 100
ms, throughput falls, and 37 requests receive controlled `503 SERVICE_BUSY`. Event-loop delay was
11.34 ms P95 / 17.12 ms P99. RSS increased 32.80% during the short curve; this is not classified as
a leak because it is not a soak-duration sample.

No production sustainable throughput is claimed. The full 1/5/10/20/50 load and 75/100/150/200
stress matrices are `NOT RUN` against the persistent topology.

## Fault and recovery matrix

| Fault / behavior                             | Actual evidence                                                        | Recovery                  | Safety result                                |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------- | -------------------------------------------- |
| 50 concurrent retry-safe HTTP-503-like reads | first attempt failed; 50/50 succeeded on attempt 2; max active reads 4 | RECOVERED                 | false success 0; duplicate side effect 0     |
| 50 exact duplicate R1 writes                 | effect count 1; deduplicated 49; same-vehicle overlap 0                | RECOVERED                 | duplicate side effect 0                      |
| 1,000 deterministic recovery cases           | 840/840 recovered; 160/160 safe-degraded                               | RECOVERED / SAFE_DEGRADED | blind write retry 0; duplicate side effect 0 |
| Simulator ambiguous applied write            | existing full regression reconciled without blind retry                | RECOVERED                 | duplicate side effect 0                      |
| PostgreSQL down/latency/pool exhaustion      | Toxiproxy topology prepared                                            | NOT RUN                   | NOT VERIFIED                                 |
| Redis down/latency/reset                     | offline queue disabled; topology prepared                              | NOT RUN                   | NOT VERIFIED                                 |
| NATS publish/consumer/backlog/redelivery     | durable semantics retained; topology prepared                          | NOT RUN                   | NOT VERIFIED                                 |
| Simulator down/latency/reset under load      | topology prepared                                                      | NOT RUN                   | NOT VERIFIED                                 |

The Compose merge passed static validation. No container or toxic was executed, so external fault
rows remain `NOT RUN`.

## Backpressure, isolation, shutdown, and restart

- API admission is bounded at 32 active + 64 queued by default and returns controlled 503 on full,
  timeout, or shutdown.
- Executor reads are bounded at 4, writes at 8, the queue at 256, and same-vehicle side effects are
  serialized across production runtimes. Duplicate/conflict detection happens before capacity
  waiting so an idempotency conflict fails immediately without blocking its legitimate owner.
- Redis offline command queuing is disabled. PostgreSQL pool max/connect/idle budgets are explicit.
- 100 concurrent session identity bindings had zero wrong-identity access. Existing full contract
  tests cover message, confirmation, action, trace, and execution binding boundaries.
- Graceful shutdown stopped admission and drained an accepted request; a finite deadline breach was
  detected automatically. The server then cancels unsettled Agent runs and closes connections.
- Persisted PostgreSQL process-restart recovery is `NOT RUN` because the dependency topology was
  unavailable. Restart safety is therefore not promoted from in-memory tests.

## Soak

The planned 20-VU, 30-minute mixed-workload soak was `NOT RUN`. Memory leak, connection/handle
leak, Redis key accumulation, DB connection accumulation, NATS backlog, and start/middle/end
latency drift are `NOT VERIFIED`. The short local RSS observation is insufficient for this gate.

## Safety and quality regression

| Check                                                    |    Measured result |
| -------------------------------------------------------- | -----------------: |
| Critical Policy Recall, deterministic 10,000-case matrix | 100% (7,335/7,335) |
| Policy decision/rule mismatch                            |              0 / 0 |
| Confirmation bypass                                      |                  0 |
| Forbidden action executed                                |                  0 |
| Duplicate side effect                                    |                  0 |
| Authorization replay success                             |                  0 |
| Unsafe retry / blind ambiguous retry                     |              0 / 0 |
| Cross-session identity contamination                     |            0 / 100 |
| Phase 13.2.1 focused regression                          |         80/80 PASS |
| Phase 14 focused gate                                    |       292/292 PASS |

The frozen dataset and Scorer V2 hashes remain
`70ef4ea213bd0d46674b70a4d99334d11e2ec16644777fe5054a6a52278d601f` and
`d185ee551dcafaef3a87a160f99073c646b2b10f89bc4db3a1b8314093524d4f`. No Ground
Truth, scorer, Policy threshold, Confirmation rule, or Agent quality standard was modified. The
official frozen live Simple/Multi P95 values remain 3220.14/2564.85 ms; current live Agent latency
was not rerun and is not claimed as a current pass.

## Test matrix status

| Matrix           | Environment / configuration                               | Duration / count    | Result             | Failure / conclusion                                  |
| ---------------- | --------------------------------------------------------- | ------------------- | ------------------ | ----------------------------------------------------- |
| Baseline         | local Fastify, faux/no LLM, 1 VU                          | 5 min / 589,039     | PARTIAL PASS       | backend P95 0.530 ms; external layers absent          |
| Load             | local fallback 1/5/10/20/50; production plan prepared     | 1,000/point         | PARTIAL            | local curve passes; production topology NOT RUN       |
| Stress           | local fallback 100/200; production 75/100/150/200 planned | 1,000/point         | PARTIAL            | bounded saturation observed; production point unknown |
| Soak             | production mixed 20 VU planned                            | 30 min / 0          | NOT RUN            | Docker daemon unavailable                             |
| Fault            | deterministic fixtures + Toxiproxy plan                   | 1,000 deterministic | PARTIAL            | deterministic pass; external proxies NOT RUN          |
| Fault-under-load | Executor 50 reads + 50 duplicate writes                   | 100 requests        | PASS               | 50 recovered; one write effect; hard counters 0       |
| Backpressure     | local Fastify, concurrency 200                            | 1,000               | PASS (local scope) | 37 controlled 503; 0 crash/other error                |
| Shutdown         | in-process Fastify                                        | 1 accepted request  | PASS               | drained and deadline tested                           |
| Restart          | PostgreSQL durable topology                               | 0                   | NOT RUN            | Docker daemon unavailable                             |
| Isolation        | in-memory repositories, 100 identities                    | 100                 | PASS               | contamination 0                                       |

## Engineering verification and review

- `npm ci`: PASS; audit vulnerabilities 0.
- format, lint, typecheck, build, `git diff --check`: PASS.
- Phase 14 gate: 292/292 PASS after fixing one review-discovered ordering defect where capacity
  admission delayed an idempotency conflict. The final ordering performs conflict/single-flight
  ownership before queuing and retains the permit around execution.
- Phase 13.2.1 core regression: 80/80 PASS.
- Full regression: 2,266/2,266 PASS across 86 files; 43 environment-gated tests skipped.
- Docker Compose plus Toxiproxy config: static validation PASS; runtime NOT VERIFIED.
- Critical/High review findings: 0 unresolved.

## Final conclusion

Phase 14 implementation is present and locally verified, but the Stage Gate is **FAIL** because the
required production-topology load, stress, soak, dependency-fault, and persisted restart evidence is
missing. No later Docker/CI/CD phase was started, no commit was created for a failing gate, and
`main` was not merged.
