# DriveGuard Phase 14.2 Final Report

## Decision

**Phase 14.2 Load Path Stabilization & Soak Closure Stage Gate: PASS.**

The load path now has a measured sustainable point and a controlled saturation point; the final
30-minute soak meets the frozen drift criteria; fault, restart/persistence, isolation, safety, and
regression gates pass. No later Docker/CI/CD phase was started.

## Before and after

| Gate           | Phase 14.1 blocker                                                         | Phase 14.2 result                                                                              |
| -------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 20-VU load     | 105 HTTP 500, 329 external `SESSION_BUSY`, one controlled 503; P95 11.34 s | 11,653 iterations, 96.53/s, Agent P95 517.60 ms, 0 controlled 503, 0 HTTP 500, 0 external busy |
| Saturation     | Not safely measured beyond the failing 20 VU point                         | 50 VU; 3,975 controlled 503, 0 HTTP 500, 0 external busy, restart 0, OOM false                 |
| 30-minute soak | Agent mean 182 -> 550 ms; throughput 4.27 -> 1.44/s                        | Agent mean 52.551 -> 51.604 ms; throughput 15.234 -> 15.508/s                                  |

Maximum sustainable load is **20 VU**. Saturation is **50 VU**. Final load evidence is in
`reports/load/final`; failed tuning attempts are preserved under explicitly named archive
directories and are not used for the PASS decision.

## Soak

- duration: 1,800.17 s
- iterations/checks: 48,583 / 48,583 PASS
- Agent P50/P95/P99: 61.882/83.924/106.444 ms
- latency ratio: 0.982 (<= 1.20)
- throughput ratio: 1.018 (>= 0.80)
- admission/PG/NATS backlog: no monotonic growth; final values zero
- metric series: 424 at 10, 20, and 30 minutes; peak 426
- process crash/OOM: 0/0

## Resilience and safety

| Check                     | Result                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| Fault under load          | 9/9 PASS; all k6 exits 0 and all recovery probes recovered                |
| Restart/persistence       | PASS; pending state and execution receipt survived two restarts           |
| Ambiguous write           | `SUCCEEDED`, reconciliation `EXECUTED`, one attempt, one reservation      |
| Duplicate confirmation    | Original receipt returned; duplicate side effect 0                        |
| Cross-session isolation   | 20 identities; confirmation/state/receipt/idempotency contamination all 0 |
| Durable NATS consumer     | Recovered; pending/ack-pending 0/0                                        |
| Critical Policy Recall    | 7,335/7,335, 100%                                                         |
| Safety Enforcement        | 100%                                                                      |
| Confirmation bypass       | 0                                                                         |
| Forbidden action executed | 0                                                                         |
| Duplicate side effect     | 0                                                                         |

## Regression and engineering checks

- format: PASS
- lint: PASS
- typecheck: PASS
- build: PASS
- full regression: 2,275/2,275 PASS across 86 files
- Phase 14 focused selection within the same full run: 298/298 PASS
- Phase 13.2.1 selection within the same full run: 80/80 PASS
- 45 PostgreSQL/Redis environment-gated integration cases: skipped by their existing guard
- diff whitespace check: PASS

The focused selections were not run a second time because every selected file was already executed
by the final full regression.

## Implementation summary

- Hardened the k6 identity/session modes and error counters, plus Windows/UNC execution support.
- Unified capacity failures as controlled `503 SERVICE_BUSY` with `Retry-After`.
- Reused identity-bound Agent runtimes under an admission-sized LRU and kept request sinks dynamic.
- Bounded model context, issued-ID retention, and trace-parent retention without deleting durable
  business state or audit history.
- Kept the formal Policy -> Confirmation -> Reliable Executor safety chain intact.

Raw gate data is summarized in `reports/final/gate-summary.json`; detailed causality and capacity
decisions are in `root-cause-analysis.md` and `backpressure-design.md`.

## Boundaries and limitations

The load/soak numbers use the deterministic faux provider and measure backend/Agent production
topology capacity, not external-provider latency. Provider latency remains a separate metric. This
phase did not start the later Security/CI/CD or Docker release-environment work.
