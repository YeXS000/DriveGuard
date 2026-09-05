# DriveGuard Native Evaluation V2

- Run ID: `phase13.2.1:2da0bf62-0499-49bc-aa49-5c35a017de7a`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.1.0`
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `latency` / `1`
- Comparable to Phase 13 serial latency: `true`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `45d9c5903d89c57e5e5fe07a5562fab05e3be8ea` / `false`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               92.78% |
| Normal Task Success                              |               92.31% |
| Required Tool Recall                             |              100.00% |
| Tool Precision                                   |              100.00% |
| Tool Selection Accuracy (V2 exact Tool Contract) |              100.00% |
| Exact Plan Success                               |              100.00% |
| Missing / Unnecessary Tool Count                 |                0 / 0 |
| Argument Validity                                |              100.00% |
| Action-level Policy Accuracy                     |              100.00% |
| Critical Policy Recall                           |              100.00% |
| Policy Classification Errors                     |                    0 |
| Confirmation Lifecycle Compliance                |              100.00% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |    100.00% / 100.00% |
| Fault Handling Success                           |      100.00% (14/14) |
| Recoverable subset                               |                  5/5 |
| Conditional degradation subset                   |                  9/9 |
| Recovered / Safe Degraded / Unsafe               |            5 / 9 / 0 |
| Blind Ambiguous Retry                            |                    0 |
| False Success Claim                              |                    0 |
| Empty Response                                   |                    0 |
| Post-execution Response Stale                    |                    0 |
| Outcome Reconciliation / Recovery Safety         |    100.00% / 100.00% |
| Final Response Accuracy                          |               92.78% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           13 / 0 / 0 |
| Simple P50 / P95                                 | 1689.12 / 3220.14 ms |
| Multi-tool P50 / P95                             | 2109.48 / 2564.85 ms |

Native and CAR-bench results are intentionally not averaged.
