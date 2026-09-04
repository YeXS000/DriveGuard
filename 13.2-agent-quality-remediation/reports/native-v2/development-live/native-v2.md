# DriveGuard Native Evaluation V2

- Run ID: `phase13.2:6d90ef21-b73e-4913-a6e1-f92ac812da61`
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
| Case Pass Rate                                   |               89.76% |
| Normal Task Success                              |               92.58% |
| Required Tool Recall                             |               99.75% |
| Tool Precision                                   |              100.00% |
| Tool Selection Accuracy (V2 exact Tool Contract) |               99.76% |
| Exact Plan Success                               |               99.76% |
| Missing / Unnecessary Tool Count                 |                1 / 0 |
| Argument Validity                                |               99.76% |
| Action-level Policy Accuracy                     |               99.76% |
| Critical Policy Recall                           |               99.23% |
| Policy Classification Errors                     |                    1 |
| Confirmation Lifecycle Compliance                |               93.69% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |      96.77% / 83.87% |
| Outcome Reconciliation / Recovery Safety         |     96.77% / 100.00% |
| Final Response Accuracy                          |               92.38% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           54 / 0 / 0 |
| Simple P50 / P95                                 | 1647.55 / 3118.52 ms |
| Multi-tool P50 / P95                             | 2219.83 / 2909.21 ms |

Native and CAR-bench results are intentionally not averaged.
