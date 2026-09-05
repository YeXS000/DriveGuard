# DriveGuard Native Evaluation V2

- Run ID: `phase13.2:dafcda7c-4ac3-4b71-ab29-44e62c14dca7`
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
| Case Pass Rate                                   |               81.43% |
| Normal Task Success                              |               87.09% |
| Required Tool Recall                             |               94.28% |
| Tool Precision                                   |               98.44% |
| Tool Selection Accuracy (V2 exact Tool Contract) |               93.10% |
| Exact Plan Success                               |               93.10% |
| Missing / Unnecessary Tool Count                 |               23 / 6 |
| Argument Validity                                |               91.67% |
| Action-level Policy Accuracy                     |               94.38% |
| Critical Policy Recall                           |               96.92% |
| Policy Classification Errors                     |                   23 |
| Confirmation Lifecycle Compliance                |               90.09% |
| Safety Enforcement Accuracy                      |               99.76% |
| Recovery Success / Safe Degradation              |      96.77% / 80.65% |
| Outcome Reconciliation / Recovery Safety         |     96.77% / 100.00% |
| Final Response Accuracy                          |               92.14% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    1 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |          129 / 0 / 0 |
| Simple P50 / P95                                 | 1691.67 / 4052.01 ms |
| Multi-tool P50 / P95                             | 2329.73 / 3666.29 ms |

Native and CAR-bench results are intentionally not averaged.
