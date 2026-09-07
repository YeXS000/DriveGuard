# DriveGuard Phase 14.1 final report

## Final decision

**Phase 14.1 Production Topology Validation Stage Gate: FAIL.**

The complete production topology is healthy, the backend-only P95 target passes, fault recovery,
restart/persistence, cross-session isolation, safety, and regression gates pass. The aggregate gate
fails because normal load reaches unexpected failures at 20 VU, overload is not fully converted to
bounded backpressure, and the 30-minute soak shows latency and throughput drift.

## Environment and topology

- Docker Desktop 4.0.0, Docker 28.1.1, Compose 2.35.1
- Node.js 22.22.1, k6 2.2.0, Linux x64, 8 CPUs, 15.35 GiB RAM
- deterministic faux provider; no bulk live-provider requests
- PostgreSQL, Redis, NATS JetStream, Toxiproxy, Simulator, API/Agent Runtime, HMI, Prometheus, and
  Grafana in isolated Compose project `driveguard141`
- final topology smoke 10/10 PASS after restart validation

## Production baseline

| Scenario                      | Requests |  req/s |            Success | P50 ms | P95 ms | P99 ms |
| ----------------------------- | -------: | -----: | -----------------: | -----: | -----: | -----: |
| Backend-only readiness, 5 min |  115,094 | 383.68 |               100% |   2.26 |   3.28 |   7.17 |
| No Tool, 1 min                |      892 |  14.85 |               100% |  63.75 |  88.10 | 123.59 |
| Simple Tool, 1 min            |      449 |   7.48 |               100% | 125.97 | 184.15 | 234.17 |
| Multi Tool, 1 min             |      265 |   4.39 |               100% | 215.05 | 299.54 | 382.74 |
| Protected action, 1 min       |      368 |   6.12 | 100% safe contract | 156.03 | 200.06 | 226.67 |

Backend-only P95 is **3.28 ms**, below the 100 ms target. Provider-only average latency was
5.34/6.19/11.32/15.73 ms for no-tool/simple/multi/protected profiles respectively; those values are
not conflated with Agent E2E latency.

## Load, sustainable throughput, stress, and backpressure

The ascending 1/5/10/20 VU matrix is reported in `bottleneck-analysis.md`. The short-window
maximum passing level is **1 VU at 8.98 req/s**. At 20 VU, 434/1,987 responses violated the
scenario contract: 105 HTTP 500 plus 329 non-contract `SESSION_BUSY`; only one controlled 503 was
observed. P95 was 11.34 seconds and API RSS peaked at 1,241 MiB.

This identified saturation at 20 VU. Higher levels were stopped rather than pushing an already
unsafe failure mode. The process did not crash or OOM, and PG/NATS/Executor queues remained
bounded, but response degradation was not controlled. Load, stress behavior, and backpressure are
therefore **FAIL**.

## Fault-under-load matrix

One final same-run matrix exercised all nine cases with concurrent traffic:

| Case                       | Exit | Recovery                 | Fault P95 ms |
| -------------------------- | ---: | ------------------------ | -----------: |
| PostgreSQL latency         |    0 | RECOVERED                |       479.12 |
| PostgreSQL disconnect      |    0 | RECOVERED                |       123.74 |
| Redis latency              |    0 | RECOVERED                |     2,764.66 |
| Redis disconnect           |    0 | RECOVERED                |       974.07 |
| NATS interruption          |    0 | RECOVERED                |     1,134.33 |
| NATS slow consumer         |    0 | RECOVERED                |     1,234.69 |
| Simulator timeout          |    0 | RECOVERED after 4 probes |     4,168.29 |
| Simulator HTTP 503         |    0 | RECOVERED                |     1,282.11 |
| Simulator connection abort |    0 | RECOVERED after 3 probes |     1,158.42 |

All cases ended recovered or safely degraded, with timeouts 0, false success 0, blind ambiguous
retry 0, duplicate side effect 0, API restart 0, and OOM 0. Fault-under-load is **PASS**.

## Soak

The uninterrupted one-VU run lasted 30 minutes and passed 6,895/6,895 scenario checks with
expected success rate 100% and no timeout. Handles, PG connections, NATS backlog, and internal
queues remained bounded. Nevertheless, Agent mean latency increased from 182 ms in the first ten
minutes to 550 ms in the final ten minutes while message throughput fell from 4.27 to 1.44 req/s.
The run does not prove a memory leak, but it proves latency/throughput drift. Soak is **FAIL**.

## Restart, persistence, and isolation

Two API restarts passed the durable-state checks:

- pending action restored after restart and confirmation remained identity-bound;
- execution receipt survived the second restart;
- ambiguous charging write reconciled as `EXECUTED` with one attempt;
- duplicate confirmation returned the same execution receipt and produced zero extra side effects;
- durable NATS consumer recovered with pending/ack-pending 0/0;
- 20 distinct session/user/vehicle identities produced confirmation leakage 0, state leakage 0,
  receipt mismatch 0, and idempotency collision 0.

Restart/persistence and cross-session isolation are **PASS**.

## Safety and regression

| Check                             | Result                                                         |
| --------------------------------- | -------------------------------------------------------------- |
| Critical Policy Recall            | 7,335/7,335, 100%                                              |
| Safety Enforcement                | 100%                                                           |
| Confirmation bypass               | 0                                                              |
| Forbidden action executed         | 0                                                              |
| Duplicate side effect             | 0                                                              |
| Recovery / safe degradation       | 840/840 and 160/160                                            |
| Phase 14 focused regression       | 297/297 PASS across 9 files                                    |
| Phase 13.2.1 regression           | 80/80 PASS across 13 files                                     |
| Full regression                   | 2,272/2,272 PASS across 86 files; 45 environment-gated skipped |
| Format / lint / typecheck / build | PASS                                                           |

The frozen Phase 13 dataset, Ground Truth, and Scorer were not changed. No safety boundary was
relaxed and no secret was persisted.

## Gate summary

| Gate                              | Result                            |
| --------------------------------- | --------------------------------- |
| Production topology healthy       | PASS                              |
| Production baseline / backend P95 | PASS                              |
| Load / sustainable capacity       | FAIL; short-window limit measured |
| Stress saturation identified      | FAIL at unsafe 20-VU mode         |
| Fault under load                  | PASS                              |
| Backpressure                      | FAIL                              |
| Soak at least 30 minutes          | FAIL due drift                    |
| Restart/persistence               | PASS                              |
| Cross-session contamination       | PASS, all counters 0              |
| Hard safety                       | PASS                              |
| Full regression                   | PASS                              |
| **Final Phase 14.1**              | **FAIL**                          |

Raw and structured evidence is under `reports/`, with the machine-readable decision in
`reports/final/gate-summary.json`. This work stops at Phase 14.1; no later Docker/CI/CD phase was
started, and no commit or merge to `main` was made.
