# DriveGuard Final Metrics Sheet

## Evidence policy

本表只采用每个类别最终获准的完整资格化结果，不从多次历史 run 中挑选最佳值，也不把 skipped、基础设施失败或不适用样本改记为 PASS。性能数据来自 deterministic provider 的测试单机拓扑，不代表公网或真实生产 QPS；Trivy/SBOM 数据严格绑定其 candidate source。

## Agent Quality

| Metric                              |                                                           Value | Source / evidence                                                                                              |
| ----------------------------------- | --------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------- |
| Native Development                  |                             420/420 evaluated; Case Pass 90.00% | `phase/13.2.1-gate-stabilization:13.2.1-gate-stabilization/reports/development/official/native-v2.json`        |
| Native Holdout                      |                             180/180 evaluated; Case Pass 92.22% | `phase/13.2.1-gate-stabilization:13.2.1-gate-stabilization/reports/holdout/official/native-v2.json`            |
| Tool recall / precision / selection |                                 100% / 100% / 100% on both sets | Same official Development and Holdout reports                                                                  |
| Argument validity                   |                                               100% on both sets | Same official Development and Holdout reports                                                                  |
| Normal task success                 |                              Development 92.03%; Holdout 91.03% | P13.2.1 final report                                                                                           |
| External CAR-bench                  | 125/125; raw Pass@1 41.60%; valid-only 66.67%; INFRA_FAILURE 47 | `phase/13.2.1-gate-stabilization:13.2.1-gate-stabilization/reports/car-bench/official/external-car-bench.json` |

## Safety

| Metric                                                   |                                  Value | Source / evidence                   |
| -------------------------------------------------------- | -------------------------------------: | ----------------------------------- |
| Policy / Critical Policy Recall                          | 100% / 100% on Development and Holdout | P13.2.1 official reports            |
| Safety Enforcement                                       |        100% on Development and Holdout | P13.2.1 official reports            |
| Critical safety regression                               |                           472/472 PASS | Phase 20 validation; final manifest |
| Authentication / confirmation bypass                     |                                  0 / 0 | `driveguard-final-manifest.json`    |
| Forbidden action / duplicate side effect / false success |                              0 / 0 / 0 | `driveguard-final-manifest.json`    |
| Cross-user / cross-vehicle execution                     |                                  0 / 0 | `driveguard-final-manifest.json`    |

## Reliability

| Metric                             |                                                                                            Value | Source / evidence                  |
| ---------------------------------- | -----------------------------------------------------------------------------------------------: | ---------------------------------- |
| Production-topology fault recovery |                                                                                              9/9 | P14.2 final report; final manifest |
| Restart/persistence                | Pending action and receipt survived two restarts; ambiguous write `EXECUTED`; duplicate effect 0 | P14.2 final report                 |
| Context race                       |            A–E PASS; escaped `CONTEXT_INVALID` 0; prospective semantic run 30/30 with mismatch 0 | P15.3 final report                 |
| Cross-session/vehicle isolation    |                            20 identities; confirmation/state/receipt/idempotency contamination 0 | P14.2 final report                 |
| Backup/restore                     |                                                             PostgreSQL, Redis and JetStream PASS | P17/P17.1 retained reports         |
| Upgrade/rollback                   |                    Same-SHA upgrade and known-good rollback PASS with durable-state verification | P17 retained report                |

## Performance

| Metric                           |                                                                          Value | Source / evidence                              |
| -------------------------------- | -----------------------------------------------------------------------------: | ---------------------------------------------- |
| Backend P95                      |                                                                        3.28 ms | P14.1 five-minute production-topology baseline |
| Qualified sustainable point      |                                          20 VU; 11,653 iterations; 96.53 req/s | P14.2 final report; `docs/final-metrics.md`    |
| Agent latency at qualified point |                                            P50/P95/P99 315.67/517.60/624.26 ms | P14.2 final report                             |
| Controlled saturation            |                        50 VU; 3,975 controlled 503; HTTP 500/external busy 0/0 | P14.2 final report                             |
| Protected lifecycle P95          |                                                         264.06 ms; 30/30 valid | P15.1 accepted lifecycle measurement           |
| 30-minute soak                   | 140,297/140,297 accepted; 77.936 req/s; HTTP 500/mismatch/restart/fatal heap 0 | P15.2 final formal run retained by P15.3       |
| Soak stability                   |         Latency ratio 0.983; throughput ratio 1.019; heap slope -0.021 MiB/min | P15.2 final formal run                         |

## CI/CD

| Metric                     |                                                                      Value | Source / evidence                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------: | ----------------------------------------------------------------------------------------------------------------- |
| Full repository regression |                               2,319/2,319 PASS; 45 environment-gated skips | Phase 20 validation; `driveguard-final-manifest.json`                                                             |
| HMI contract               |                                                                   5/5 PASS | `codex/20-final-hmi-upgrade-release-closure:artifacts/20-final-hmi-upgrade-release-closure/phase20-validation.md` |
| Exact-source Hosted CI     |                                 GREEN; run 34764056549; source `87dfe346…` | [GitHub Actions](https://github.com/YeXS000/DriveGuard/actions/runs/34764056549)                                  |
| Build/config gates         | format, lint, typecheck, build, development/production Compose config PASS | Phase 20 validation                                                                                               |

## Security

| Metric                                         |                                                                      Value | Source / evidence                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------: | ---------------------------------------------------------- |
| npm audit                                      |                                                          0 vulnerabilities | Phase 20 validation; exact-source Hosted CI                |
| Controlled-source Gitleaks                     |                                                                 0 findings | P18.3 candidate evidence; exact-source CI source scan PASS |
| Reachable-history Gitleaks                     |                                         26 raw / 26 triaged / 0 unresolved | P18.3 evidence                                             |
| Candidate image findings                       | Critical 0; fixable Critical/High 0; reachable High 0; unclassified High 0 | P18.3 Trivy reports, source `e7f8e196…`                    |
| Candidate residuals                            |        43 raw no-fixed-version High rows/image, classified `NOT_REACHABLE` | P18.3 `reports/trivy/high-classification.md`               |
| Image secrets / Critical-High misconfiguration |                                                                      0 / 0 | P18.3 Trivy reports                                        |
| SBOM                                           |                                                               3/3 SPDX 2.3 | P18.3 SBOM reports                                         |

The image-security and SBOM rows above are not relabelled as scans of `v1.0.0`: the published HMI/API source is later than candidate `e7f8e196…`. Exact-source CI rebuilt three images but did not produce a new Trivy/SBOM set.

## Release

| Metric                  |                                                                          Value | Source / evidence                                                              |
| ----------------------- | -----------------------------------------------------------------------------: | ------------------------------------------------------------------------------ |
| Published source        |                                     `87dfe34645b93c64833604bad4ba29029ee3cf00` | `main`, `origin/main`, final manifest                                          |
| Annotated tag           |                `v1.0.0`; tag object `d7a8a5df7b8918d882b374613e42424e9651ec0e` | local Git object database / remote tag                                         |
| GitHub Release          |                                           Published, non-draft, non-prerelease | [DriveGuard v1.0.0](https://github.com/YeXS000/DriveGuard/releases/tag/v1.0.0) |
| Project decision        | COMPLETE; Production Release Readiness READY under the DriveGuard project gate | `driveguard-final-manifest.json`; `docs/final-acceptance.md`                   |
| Registry / real vehicle |                                                    NOT PERFORMED / NOT CLAIMED | final manifest; known limitations                                              |
