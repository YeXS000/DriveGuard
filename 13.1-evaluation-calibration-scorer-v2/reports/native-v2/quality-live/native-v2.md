# DriveGuard Native Evaluation V2

- Run ID: `phase13.1:21948082-a6db-437f-b30a-f33209fd93f5`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.0.0` (rescored 2026-09-01T20:16:15.687Z)
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               42.00% |
| Normal Task Success                              |               41.73% |
| Required Tool Recall                             |               89.10% |
| Tool Precision                                   |               44.43% |
| Tool Selection Accuracy (V2 exact Tool Contract) |               47.67% |
| Exact Plan Success                               |               47.67% |
| Missing / Unnecessary Tool Count                 |             62 / 634 |
| Argument Validity                                |               84.67% |
| Action-level Policy Accuracy                     |               89.22% |
| Critical Policy Recall                           |               81.32% |
| Policy Classification Errors                     |                   73 |
| Confirmation Lifecycle Compliance                |               13.91% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |       0.00% / 33.33% |
| Outcome Reconciliation / Recovery Safety         |      80.00% / 80.00% |
| Final Response Accuracy                          |               77.67% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |          869 / 0 / 0 |
| Simple P50 / P95                                 | 2388.41 / 6827.16 ms |
| Multi-tool P50 / P95                             | 2768.30 / 4218.62 ms |

Native and CAR-bench results are intentionally not averaged.
