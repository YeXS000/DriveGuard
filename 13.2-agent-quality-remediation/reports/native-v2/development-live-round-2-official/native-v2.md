# DriveGuard Native Evaluation V2

- Run ID: `phase13.2:fb6f9d27-efb8-4253-8b4a-8936fc12f176`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.0.0`
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `166870fb0ffa90a1fedaaa98237dc763955fc16b` / `true`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               87.38% |
| Normal Task Success                              |               93.96% |
| Required Tool Recall                             |              100.00% |
| Tool Precision                                   |              100.00% |
| Tool Selection Accuracy (V2 exact Tool Contract) |              100.00% |
| Exact Plan Success                               |              100.00% |
| Missing / Unnecessary Tool Count                 |                0 / 0 |
| Argument Validity                                |               95.48% |
| Action-level Policy Accuracy                     |              100.00% |
| Critical Policy Recall                           |              100.00% |
| Policy Classification Errors                     |                    0 |
| Confirmation Lifecycle Compliance                |               94.59% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |     100.00% / 80.65% |
| Outcome Reconciliation / Recovery Safety         |    100.00% / 100.00% |
| Final Response Accuracy                          |               93.33% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           66 / 0 / 0 |
| Simple P50 / P95                                 | 1580.52 / 3153.71 ms |
| Multi-tool P50 / P95                             | 2129.93 / 3190.43 ms |

Native and CAR-bench results are intentionally not averaged.
