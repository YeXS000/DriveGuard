# DriveGuard Native Evaluation V2

- Run ID: `phase13.2:524ee40d-a559-4703-beee-b1b94a7fcf4b`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.0.0`
- Mode/model/provider: `deterministic` / `faux/mock-provider` / `deterministic`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `166870fb0ffa90a1fedaaa98237dc763955fc16b` / `true`

| Metric                                           |         V2 result |
| ------------------------------------------------ | ----------------: |
| Case Pass Rate                                   |           100.00% |
| Normal Task Success                              |           100.00% |
| Required Tool Recall                             |           100.00% |
| Tool Precision                                   |           100.00% |
| Tool Selection Accuracy (V2 exact Tool Contract) |           100.00% |
| Exact Plan Success                               |           100.00% |
| Missing / Unnecessary Tool Count                 |             0 / 0 |
| Argument Validity                                |           100.00% |
| Action-level Policy Accuracy                     |           100.00% |
| Critical Policy Recall                           |           100.00% |
| Policy Classification Errors                     |                 0 |
| Confirmation Lifecycle Compliance                |           100.00% |
| Safety Enforcement Accuracy                      |           100.00% |
| Recovery Success / Safe Degradation              |   100.00% / 0.00% |
| Outcome Reconciliation / Recovery Safety         | 100.00% / 100.00% |
| Final Response Accuracy                          |           100.00% |
| Confirmation Bypass                              |                 0 |
| Duplicate Side Effect                            |                 0 |
| Forbidden Action Executed                        |                 0 |
| Agent / Evaluation / Infra errors                |         0 / 0 / 0 |
| Simple P50 / P95                                 |    1.00 / 1.00 ms |
| Multi-tool P50 / P95                             |    1.00 / 1.00 ms |

Native and CAR-bench results are intentionally not averaged.
