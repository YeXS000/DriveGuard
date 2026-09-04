# DriveGuard Native Evaluation V2

- Run ID: `phase13.2.1:23363d7c-12d8-4880-8d98-6724659821b7`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.1.0`
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `9a62b7df9a114c0dcb5965977b034ad2b90f64da` / `false`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               90.00% |
| Normal Task Success                              |               91.67% |
| Required Tool Recall                             |              100.00% |
| Tool Precision                                   |              100.00% |
| Tool Selection Accuracy (V2 exact Tool Contract) |              100.00% |
| Exact Plan Success                               |              100.00% |
| Missing / Unnecessary Tool Count                 |                0 / 0 |
| Argument Validity                                |              100.00% |
| Action-level Policy Accuracy                     |              100.00% |
| Critical Policy Recall                           |              100.00% |
| Policy Classification Errors                     |                    0 |
| Confirmation Lifecycle Compliance                |               92.50% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |      0.00% / 100.00% |
| Fault Handling Success                           |       78.57% (11/14) |
| Recoverable subset                               |                  0/3 |
| Conditional degradation subset                   |                11/11 |
| Recovered / Safe Degraded / Unsafe               |           0 / 11 / 3 |
| Blind Ambiguous Retry                            |                    0 |
| False Success Claim                              |                    0 |
| Empty Response                                   |                    0 |
| Post-execution Response Stale                    |                    0 |
| Outcome Reconciliation / Recovery Safety         |    100.00% / 100.00% |
| Final Response Accuracy                          |               91.11% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           24 / 0 / 0 |
| Simple P50 / P95                                 | 1757.53 / 3345.87 ms |
| Multi-tool P50 / P95                             | 2377.21 / 2938.79 ms |

Native and CAR-bench results are intentionally not averaged.
