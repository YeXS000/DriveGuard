# DriveGuard Native Evaluation V2

- Run ID: `phase13.2.1:41321754-c0f4-41ec-9f8d-5c679a6a6312`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.1.0`
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `73f2e4647635e899c66ea637a6c04f9e293166b7` / `false`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               82.14% |
| Normal Task Success                              |               83.24% |
| Required Tool Recall                             |              100.00% |
| Tool Precision                                   |              100.00% |
| Tool Selection Accuracy (V2 exact Tool Contract) |              100.00% |
| Exact Plan Success                               |              100.00% |
| Missing / Unnecessary Tool Count                 |                0 / 0 |
| Argument Validity                                |              100.00% |
| Action-level Policy Accuracy                     |              100.00% |
| Critical Policy Recall                           |              100.00% |
| Policy Classification Errors                     |                    0 |
| Confirmation Lifecycle Compliance                |               61.26% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |    100.00% / 100.00% |
| Fault Handling Success                           |      100.00% (31/31) |
| Recoverable subset                               |                10/10 |
| Conditional degradation subset                   |                21/21 |
| Recovered / Safe Degraded / Unsafe               |          10 / 21 / 0 |
| Blind Ambiguous Retry                            |                    0 |
| False Success Claim                              |                    0 |
| Empty Response                                   |                    0 |
| Post-execution Response Stale                    |                    1 |
| Outcome Reconciliation / Recovery Safety         |    100.00% / 100.00% |
| Final Response Accuracy                          |               92.38% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           84 / 0 / 0 |
| Simple P50 / P95                                 | 1517.00 / 3428.35 ms |
| Multi-tool P50 / P95                             | 2083.11 / 3171.69 ms |

Native and CAR-bench results are intentionally not averaged.
