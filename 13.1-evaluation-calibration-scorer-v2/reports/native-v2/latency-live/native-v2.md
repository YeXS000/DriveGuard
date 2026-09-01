# DriveGuard Native Evaluation V2

- Run ID: `phase13.1:efe92120-218f-4c28-9b9a-dcaec87384b6`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.0.0` (rescored 2026-09-01T20:59:14.884Z)
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `latency` / `1`
- Comparable to Phase 13 serial latency: `true`
- Benchmark retries: `0`
- Provider retries: `unobserved`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               44.17% |
| Normal Task Success                              |               44.23% |
| Required Tool Recall                             |               90.16% |
| Tool Precision                                   |               43.88% |
| Tool Selection Accuracy (V2 exact Tool Contract) |               50.50% |
| Exact Plan Success                               |               50.50% |
| Missing / Unnecessary Tool Count                 |             56 / 656 |
| Argument Validity                                |               86.50% |
| Action-level Policy Accuracy                     |               90.31% |
| Critical Policy Recall                           |               84.62% |
| Policy Classification Errors                     |                   65 |
| Confirmation Lifecycle Compliance                |               13.91% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |       0.00% / 31.11% |
| Outcome Reconciliation / Recovery Safety         |      80.00% / 80.00% |
| Final Response Accuracy                          |               78.17% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |          831 / 0 / 0 |
| Simple P50 / P95                                 | 2571.21 / 6750.62 ms |
| Multi-tool P50 / P95                             | 3389.41 / 5635.76 ms |

Native and CAR-bench results are intentionally not averaged.
