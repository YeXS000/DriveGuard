# DriveGuard Native Evaluation V2

- Run ID: `phase13.2.1:eac93961-43a5-4060-af3f-ff26b43bf64e`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.1.0`
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `1a5167fdc0ebaf0cc07491c22005a5989afbc1fe` / `false`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               92.22% |
| Normal Task Success                              |               91.03% |
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
| Final Response Accuracy                          |               92.22% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           14 / 0 / 0 |
| Simple P50 / P95                                 | 1591.24 / 4323.53 ms |
| Multi-tool P50 / P95                             | 1991.52 / 2789.24 ms |

Native and CAR-bench results are intentionally not averaged.
