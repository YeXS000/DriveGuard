# DriveGuard Native Evaluation V2

- Run ID: `phase13.2.1:743d051b-bd64-4db0-932b-b2aba9102f21`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.1.0`
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `f80a7f1730cc058b1a1047bbd459dce28a94e3bf` / `true`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               52.31% |
| Normal Task Success                              |               46.24% |
| Required Tool Recall                             |               90.24% |
| Tool Precision                                   |               98.23% |
| Tool Selection Accuracy (V2 exact Tool Contract) |               89.23% |
| Exact Plan Success                               |               89.23% |
| Missing / Unnecessary Tool Count                 |               12 / 2 |
| Argument Validity                                |               90.77% |
| Action-level Policy Accuracy                     |               90.77% |
| Critical Policy Recall                           |               90.77% |
| Policy Classification Errors                     |                   12 |
| Confirmation Lifecycle Compliance                |               61.26% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |    100.00% / 100.00% |
| Fault Handling Success                           |      100.00% (12/12) |
| Recoverable subset                               |                  6/6 |
| Conditional degradation subset                   |                  6/6 |
| Recovered / Safe Degraded / Unsafe               |            6 / 6 / 0 |
| Blind Ambiguous Retry                            |                    0 |
| False Success Claim                              |                    0 |
| Empty Response                                   |                    0 |
| Post-execution Response Stale                    |                    0 |
| Outcome Reconciliation / Recovery Safety         |    100.00% / 100.00% |
| Final Response Accuracy                          |               95.38% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           96 / 0 / 0 |
| Simple P50 / P95                                 | 1636.83 / 4354.17 ms |
| Multi-tool P50 / P95                             |       0.00 / 0.00 ms |

Native and CAR-bench results are intentionally not averaged.
