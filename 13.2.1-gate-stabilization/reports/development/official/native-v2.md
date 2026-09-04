# DriveGuard Native Evaluation V2

- Run ID: `phase13.2.1:b1f15626-6665-4361-9b36-bec5d2b70020`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.1.0` (rescored 2026-09-04T03:50:59.839Z)
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `eab1e9e8075a9990adc200c2829bb5ca0a79a0e3` / `true`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               88.57% |
| Normal Task Success                              |               91.21% |
| Required Tool Recall                             |              100.00% |
| Tool Precision                                   |               99.50% |
| Tool Selection Accuracy (V2 exact Tool Contract) |               99.52% |
| Exact Plan Success                               |               99.52% |
| Missing / Unnecessary Tool Count                 |                0 / 2 |
| Argument Validity                                |              100.00% |
| Action-level Policy Accuracy                     |              100.00% |
| Critical Policy Recall                           |              100.00% |
| Policy Classification Errors                     |                    0 |
| Confirmation Lifecycle Compliance                |               94.59% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |    100.00% / 100.00% |
| Fault Handling Success                           |      100.00% (31/31) |
| Recoverable subset                               |                  6/6 |
| Conditional degradation subset                   |                25/25 |
| Recovered / Safe Degraded / Unsafe               |           6 / 25 / 0 |
| Blind Ambiguous Retry                            |                    0 |
| False Success Claim                              |                    0 |
| Empty Response                                   |                    0 |
| Post-execution Response Stale                    |                    0 |
| Outcome Reconciliation / Recovery Safety         |    100.00% / 100.00% |
| Final Response Accuracy                          |               91.43% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           57 / 0 / 0 |
| Simple P50 / P95                                 | 1834.71 / 3348.47 ms |
| Multi-tool P50 / P95                             | 2366.58 / 3443.93 ms |

Native and CAR-bench results are intentionally not averaged.
