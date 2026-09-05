# DriveGuard Native Evaluation V2

- Run ID: `phase13.2.1:7dc2f131-3128-4236-ae8b-83d5ef1ba5ec`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.1.0`
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `49ad013e5a4ed0e75f8cc327cdada7762d1a6f68` / `false`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               90.00% |
| Normal Task Success                              |               98.92% |
| Required Tool Recall                             |              100.00% |
| Tool Precision                                   |               99.19% |
| Tool Selection Accuracy (V2 exact Tool Contract) |               99.23% |
| Exact Plan Success                               |               99.23% |
| Missing / Unnecessary Tool Count                 |                0 / 1 |
| Argument Validity                                |              100.00% |
| Action-level Policy Accuracy                     |              100.00% |
| Critical Policy Recall                           |              100.00% |
| Policy Classification Errors                     |                    0 |
| Confirmation Lifecycle Compliance                |               94.59% |
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
| Agent / Evaluation / Infra errors                |           22 / 0 / 0 |
| Simple P50 / P95                                 | 1639.34 / 2788.36 ms |
| Multi-tool P50 / P95                             |       0.00 / 0.00 ms |

Native and CAR-bench results are intentionally not averaged.
