# Final metrics freeze

The release closure does not recompute or select new benchmark rounds. Values below are copied from
the final accepted evidence for each metric. Phase 20 changed the HMI/API adapter but did not change
the Agent, Policy, confirmation, recovery, scorer, or frozen performance semantics; it added five
tests and reran the repository gates. Failed predecessor rounds remain in the historical-integrity
section of [final acceptance](final-acceptance.md).

## Agent quality and safety

Source: Phase 13.2.1 final report, complete single-run Native Development (420) and Holdout (180)
sets at evaluator correction `49ad013e5a4ed0e75f8cc327cdada7762d1a6f68`.

| Metric                                    |         Development |         Holdout | Final status |
| ----------------------------------------- | ------------------: | --------------: | ------------ |
| Case Pass                                 |              90.00% |          92.22% | PASS         |
| Normal Task Success                       |              92.03% |          91.03% | PASS         |
| Required Tool Recall                      |                100% |            100% | PASS         |
| Tool Precision                            |                100% |            100% | PASS         |
| Tool Selection                            |                100% |            100% | PASS         |
| Argument Validity                         |                100% |            100% | PASS         |
| Policy / Critical Policy Recall           |         100% / 100% |     100% / 100% | PASS         |
| Confirmation Lifecycle                    |              94.59% |            100% | PASS         |
| Execution Outcome                         |              97.86% |            100% | PASS         |
| Safety Enforcement                        |                100% |            100% | PASS         |
| Fault / Recovery / Required Degradation   | 31/31; 10/10; 21/21 | 14/14; 5/5; 9/9 | PASS         |
| Agent / Evaluator / Infrastructure errors |          51 / 0 / 0 |      14 / 0 / 0 | disclosed    |

Hard counters frozen by Phase 18.3 production smoke and the 472-test critical-safety selection:

| Metric                    | Value | Status |
| ------------------------- | ----: | ------ |
| Critical Policy Recall    |  100% | PASS   |
| Safety Enforcement        |  100% | PASS   |
| Authentication Bypass     |     0 | PASS   |
| Confirmation Bypass       |     0 | PASS   |
| Forbidden Action Executed |     0 | PASS   |
| Duplicate Side Effect     |     0 | PASS   |
| False Success             |     0 | PASS   |
| Cross-user execution      |     0 | PASS   |
| Cross-vehicle execution   |     0 | PASS   |

External CAR-bench remains a separate result: 125/125 tasks, raw Pass@1 **41.60%**, valid-only
Pass@1 **66.67%**, VALID 52, AGENT_FAILURE 26, INFRA_FAILURE 47, EVALUATOR_FAILURE 0. The 47
infrastructure failures remain failures in the raw denominator.

## Performance

| Metric                             |                                                           Frozen value | Source and scope                                                       |
| ---------------------------------- | ---------------------------------------------------------------------: | ---------------------------------------------------------------------- |
| Backend P95                        |                                                                3.28 ms | Phase 14.1, five-minute production topology baseline                   |
| NO_TOOL P50/P95/P99                |                                              63.75 / 88.10 / 123.59 ms | Phase 14.1, deterministic provider                                     |
| SIMPLE_TOOL P50/P95/P99            |                                            125.97 / 184.15 / 234.17 ms | Phase 14.1, deterministic provider                                     |
| MULTI_TOOL P50/P95/P99             |                                            215.05 / 299.54 / 382.74 ms | Phase 14.1, deterministic provider                                     |
| Protected lifecycle P50/P95/P99    |                                            223.38 / 264.06 / 277.08 ms | Phase 15.1 valid 30/30 full lifecycle                                  |
| Provider-backed Simple P50/P95     |                                                 1,689.12 / 3,220.14 ms | Phase 13.2.1 serial Holdout                                            |
| Provider-backed Multi-tool P50/P95 |                                                 2,109.48 / 2,564.85 ms | Phase 13.2.1 serial Holdout                                            |
| Qualified sustainable concurrency  |                                                                  20 VU | Phase 14.2 production topology, deterministic provider                 |
| Qualified throughput               |                                                       96.53 requests/s | Phase 14.2 20-VU load window; 11,653 iterations                        |
| Controlled saturation              |                                            50 VU; 3,975 controlled 503 | Phase 14.2; HTTP 500/external busy 0/0                                 |
| 30-minute soak                     |                                     140,297/140,297 accepted; 77.936/s | Phase 15.2, 10 VU; HTTP 500/semantic mismatch/restart/fatal heap all 0 |
| Soak stability                     | latency ratio 0.983; throughput ratio 1.019; heap slope -0.021 MiB/min | Phase 15.2 final formal run                                            |

The sustainable throughput figure is not external-provider throughput and is not a production-user
or public-QPS claim.

## Reliability and production

| Metric                          | Value                                                                                            | Source                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| Fault recovery                  | 9/9 production-topology cases recovered                                                          | Phase 14.2                      |
| Restart/persistence             | pending action and receipt survived two restarts; ambiguous write `EXECUTED`; duplicate effect 0 | Phase 14.2                      |
| Cross-session/vehicle isolation | 20 identities; confirmation/state/receipt/idempotency contamination 0                            | Phase 14.2                      |
| Backup/restore                  | PostgreSQL, Redis, JetStream backup and isolated restore PASS                                    | Phase 17 + 17.1                 |
| Upgrade/rollback                | same-SHA upgrade and known-good rollback PASS with durable-state verification                    | Phase 17                        |
| Alerts                          | 12 rules loaded; API/dependency/backpressure firing and recovery PASS                            | Phase 17 + 17.1                 |
| Production authentication       | JWT/JWKS and cross-user/vehicle/header rejection PASS                                            | Phase 18.3                      |
| Full repository regression      | 2,319/2,319 PASS; 45 environment-gated skips                                                     | Phase 20 release validation     |
| Critical safety regression      | 472/472 PASS                                                                                     | Phase 20 release validation     |
| Hosted CI                       | run 34764056549, source `87dfe346…`, PASS                                                        | exact published `v1.0.0` source |

## Security

Source: Phase 18.3 candidate `e7f8e19616a4c14d1609608f92e4094c4e6d001e`, Gitleaks 8.24.3,
Trivy 0.67.0, and SPDX 2.3 SBOMs. These Trivy/SBOM rows are candidate-scoped, not a claim that the
later `v1.0.0` HMI/API source was rescanned; exact-source CI separately passed committed-source
Gitleaks, npm audit, and three image builds.

| Metric                              |                       Frozen value | Status                                               |
| ----------------------------------- | ---------------------------------: | ---------------------------------------------------- |
| Controlled-source Gitleaks findings |                                  0 | PASS                                                 |
| Reachable-history findings          | 26 raw / 26 triaged / 0 unresolved | PASS; historical report matches retained             |
| Critical CVE                        |                                  0 | PASS                                                 |
| Fixable Critical/High               |                                  0 | PASS                                                 |
| Residual no-fix High                |              43 raw rows per image | classified `NOT_REACHABLE`; not zero vulnerabilities |
| Reachable High                      |                                  0 | PASS                                                 |
| Unclassified High                   |                                  0 | PASS                                                 |
| Image secrets                       |                                  0 | PASS                                                 |
| Critical/High misconfiguration      |                                  0 | PASS                                                 |
| SBOM                                |                       3/3 SPDX 2.3 | PASS                                                 |

Residual rows cover eight CVEs: four util-linux-family CVEs (nine rows each), one ACL row, two
systemd/udev rows, three ncurses rows, and one Perl row. The raw scanner JSON, versions, layers,
classification, mitigation, and review triggers remain authoritative on the Phase 18.3 branch.
