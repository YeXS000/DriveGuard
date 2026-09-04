# DriveGuard Native Evaluation V2

- Run ID: `phase13.2.1:3233dfa9-4f03-4036-b4bb-27409d4b2ef8`
- Dataset: `DriveGuard-Eval-v2.0.0`
- Scorer: `DriveGuard-Scorer-v2.1.0`
- Mode/model/provider: `live` / `deepseek-v4-flash` / `deepseek`
- Profile/concurrency: `quality` / `4`
- Comparable to Phase 13 serial latency: `false`
- Benchmark retries: `0`
- Provider retries: `unobserved`
- Git commit / dirty worktree: `eab1e9e8075a9990adc200c2829bb5ca0a79a0e3` / `true`

| Metric                                           |            V2 result |
| ------------------------------------------------ | -------------------: |
| Case Pass Rate                                   |               90.00% |
| Normal Task Success                              |               98.92% |
| Required Tool Recall                             |               99.19% |
| Tool Precision                                   |               98.39% |
| Tool Selection Accuracy (V2 exact Tool Contract) |               97.69% |
| Exact Plan Success                               |               97.69% |
| Missing / Unnecessary Tool Count                 |                1 / 2 |
| Argument Validity                                |               99.23% |
| Action-level Policy Accuracy                     |              100.00% |
| Critical Policy Recall                           |              100.00% |
| Policy Classification Errors                     |                    0 |
| Confirmation Lifecycle Compliance                |               93.69% |
| Safety Enforcement Accuracy                      |              100.00% |
| Recovery Success / Safe Degradation              |    100.00% / 100.00% |
| Fault Handling Success                           |      100.00% (12/12) |
| Recoverable subset                               |                  5/5 |
| Conditional degradation subset                   |                  7/7 |
| Recovered / Safe Degraded / Unsafe               |            5 / 7 / 0 |
| Blind Ambiguous Retry                            |                    0 |
| False Success Claim                              |                    0 |
| Empty Response                                   |                    0 |
| Post-execution Response Stale                    |                    0 |
| Outcome Reconciliation / Recovery Safety         |     91.67% / 100.00% |
| Final Response Accuracy                          |               96.15% |
| Confirmation Bypass                              |                    0 |
| Duplicate Side Effect                            |                    0 |
| Forbidden Action Executed                        |                    0 |
| Agent / Evaluation / Infra errors                |           24 / 0 / 0 |
| Simple P50 / P95                                 | 2029.42 / 3640.08 ms |
| Multi-tool P50 / P95                             |       0.00 / 0.00 ms |

Native and CAR-bench results are intentionally not averaged.
