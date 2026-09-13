# Final acceptance matrix

## Evidence convention

Evidence paths use `branch:path` because stage-only evidence is intentionally excluded from
`main`. `P18.3` means branch `codex/18.3-least-privilege-storage-release-closure`; `P17.2` means
`codex/17.2-security-remediation-release-gate-closure`; other source phases follow the same naming.
Production images remain bound to `e7f8e19616a4c14d1609608f92e4094c4e6d001e`; the source-only
Phase 18 merge baseline is `d4ea9ca130e20bd486475df199b9acccdd56c821`.

## Matrix

| Area                | Result | Source phase     | Evidence path                                                                                                                                                           | Metric / identity                                                                        |
| ------------------- | ------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Agent Quality       | PASS   | 13.2.1           | `phase/13.2.1-gate-stabilization:13.2.1-gate-stabilization/docs/final-report.md`                                                                                        | Native Development 90.00%, Holdout 92.22%; SHA `82db945…`                                |
| Tool Routing        | PASS   | 13.2.1           | same report                                                                                                                                                             | recall/precision/selection 100% on Development and Holdout                               |
| Arguments           | PASS   | 13.2.1           | same report                                                                                                                                                             | argument validity 100% / 100%                                                            |
| Policy              | PASS   | 13.2.1           | same report                                                                                                                                                             | Policy and Critical Policy Recall 100% / 100%                                            |
| Confirmation        | PASS   | 13.2.1, 18.3     | P13.2.1 final report; `P18.3:artifacts/18.3-least-privilege-storage-release-closure/reports/final/production-smoke.json`                                                | lifecycle 94.59% / 100%; production bypass 0                                             |
| Recovery            | PASS   | 13.2.1           | P13.2.1 final report                                                                                                                                                    | Development recovery 10/10, Holdout 5/5; required degradation 21/21 and 9/9              |
| Fault Handling      | PASS   | 14.2             | `phase/14.2-load-path-stabilization:14.2-load-path-stabilization/docs/final-report.md`                                                                                  | 9/9 production-topology fault cases recovered                                            |
| Safety              | PASS   | 18.3             | `P18.3:artifacts/18.3-least-privilege-storage-release-closure/reports/final/gate-summary.json`                                                                          | critical safety 472/472; hard counters 0                                                 |
| Load / Backpressure | PASS   | 14.2             | P14.2 final report                                                                                                                                                      | 20 VU sustainable; 50 VU produced 3,975 controlled 503, HTTP 500 0                       |
| Performance         | PASS   | 14.1, 14.2, 15.1 | final reports for those phases                                                                                                                                          | backend P95 3.28 ms; 20 VU 96.53/s; protected lifecycle P95 264.06 ms                    |
| Soak Stability      | PASS   | 15.2, 15.3       | `codex/15.2-context-consistency-semantic-stability-closure:artifacts/15.2-context-consistency-semantic-stability-closure/docs/final-report.md`; Phase 15.3 final report | 30 min, 140,297/140,297, ratios 0.983/1.019, zero 500/mismatch                           |
| Context Consistency | PASS   | 15.3             | `codex/15.3-context-race-evidence-closure:artifacts/15.3-context-race-evidence-closure/docs/final-report.md`                                                            | A–E PASS; 30/30 prospective observations; escaped `CONTEXT_INVALID` 0                    |
| Containerization    | PASS   | 16, 18.3         | P16 final report; P18.3 candidate                                                                                                                                       | 3 non-root SHA-bound images; hardened production overlay                                 |
| CI/CD               | PASS   | 16, 19           | `codex/16-containerization-ci-cd-reproducible-release:artifacts/16-containerization-ci-cd-reproducible-release/docs/final-report.md`; `.github/workflows/ci.yml`        | hosted run 34470398420 green at `3c6526f…`; Phase 19 local CI-equivalent validation PASS |
| Deployment          | PASS   | 17, 18.3         | P17 final report; P18.3 production smoke                                                                                                                                | clean staging and authenticated production smoke PASS                                    |
| Upgrade             | PASS   | 17               | `codex/17-staging-release-operational-readiness:artifacts/17-staging-release-operational-readiness/docs/final-report.md`                                                | same-SHA recreate preserved pending confirmation and receipt                             |
| Rollback            | PASS   | 17               | same report                                                                                                                                                             | missing-image failure then known-good recovery; durable state preserved                  |
| Backup / Restore    | PASS   | 17, 17.1         | P17 final report; `codex/17.1-operational-evidence-security-closure:artifacts/17.1-operational-evidence-security-closure/reports/final-report.md`                       | PostgreSQL/Redis/JetStream backup and isolated restore PASS                              |
| Observability       | PASS   | 11, 17           | `docs/implementation-status.md`; P17 final report                                                                                                                       | metrics, tracing, logs, dashboards; 12 alert rules loaded                                |
| Alerts              | PASS   | 17.1             | P17.1 final report                                                                                                                                                      | API, dependency, and backpressure alerts fired and recovered                             |
| Security            | PASS   | 18.3             | P18.3 gate summary                                                                                                                                                      | combined Phase 18 gate PASS                                                              |
| Authentication      | PASS   | 18.1, 18.3       | P18.1 final report; P18.3 production smoke                                                                                                                              | JWT/JWKS contract 13/13; authentication bypass 0                                         |
| Authorization       | PASS   | 18.3             | P18.3 production smoke                                                                                                                                                  | cross-user/vehicle/header rejection PASS; cross-user/vehicle execution 0                 |
| Secrets             | PASS   | 17.2, 18.3       | P17.2 report; P18.3 Gitleaks evidence                                                                                                                                   | controlled source 0; history 26 triaged, unresolved 0                                    |
| Image Security      | PASS   | 18.3             | `P18.3:artifacts/18.3-least-privilege-storage-release-closure/reports/trivy/high-classification.md`                                                                     | Critical 0; fixable/reachable/unclassified High 0; raw no-fix High 43/image              |
| Network Hardening   | PASS   | 18, 18.3         | `docker-compose.production.yml`; ADR 0023/0025                                                                                                                          | only HMI published; application/data networks internal                                   |
| Audit               | PASS   | 18.3             | P18.3 production smoke                                                                                                                                                  | authenticated lifecycle reconstruction PASS; credential leakage 0                        |
| Idempotency         | PASS   | 14.2, 18.3       | P14.2 report; P18.3 smoke                                                                                                                                               | duplicate side effect 0; durable receipt replay PASS                                     |
| Release Identity    | PASS   | 18.3, 19         | P18.3 candidate; `driveguard-final-manifest.json`                                                                                                                       | three local image digests and SBOMs bound to `e7f8e196…`                                 |

## Historical integrity

Final PASS means the blocker was closed in a later, explicitly authorized phase. It does not
rewrite predecessor evidence:

| Checkpoint        | Historical result                                                                          | Final resolution                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Phase 13 baseline | Engineering PASS; quality targets 4/10 HIT                                                 | Phase 13.2.1 complete Native gates PASS                                                    |
| Phase 13.2        | FAIL: development minimum missed; Holdout/latency/CAR not run                              | Phase 13.2.1 Scorer V2.1 + bounded critical-path repair PASS                               |
| Phase 14          | FAIL: production topology/load/soak/restart evidence missing                               | Phase 14.1 executed topology; Phase 14.2 closed backpressure/soak                          |
| Phase 14.1        | FAIL: unsafe 20-VU response mode and soak drift                                            | Phase 14.2 controlled saturation and stable soak PASS                                      |
| Phase 15          | FAIL: heap crashes, uncontrolled load, vehicle routing                                     | Phase 15.1 fixed heap/routing, but remained FAIL                                           |
| Phase 15.1        | FAIL: two HTTP 500, three semantic errors, throughput ratio 0.848; full regression NOT RUN | Phase 15.2 runtime soak passed; Phase 15.3 closed missing race/mismatch evidence           |
| Phase 15.2        | FAIL: A–E matrix and historic mismatch payloads missing                                    | Phase 15.3 A–E and prospective evidence PASS; three historic payloads remain irrecoverable |
| Phase 17          | FAIL: restore/alerts/drills/security NOT RUN                                               | Phase 17.1 closed operations; security still FAIL                                          |
| Phase 17.1        | FAIL: 9 history findings and 9 Critical/92 High per image untriaged                        | Phase 17.2 remediated base and classified exceptions; overall Phase 17 PASS                |
| Phase 18          | FAIL: production authentication absent and smoke/audit NOT RUN                             | Phase 18.1 added JWT; later evidence still incomplete                                      |
| Phase 18.1        | FAIL: history findings, smoke, scans, full regression incomplete                           | Phase 18.2 triaged history but storage boot failed                                         |
| Phase 18.2        | FAIL: hardened PostgreSQL/Redis volumes could not initialize                               | Phase 18.3 added least-privilege initializers and completed all release evidence           |
| Phase 18.3        | PASS                                                                                       | combined Phase 18 production release gate PASS                                             |

## Final production checklist

| Item                                 | Result | Evidence                                                                                        |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| Source frozen                        | PASS   | main baseline `d4ea9ca…`; production candidate `e7f8e196…`                                      |
| CI green                             | PASS   | hosted run 34470398420 plus final local CI-equivalent validation (Phase 19 result to be sealed) |
| Full regression green                | PASS   | Phase 19: 2,314/2,314; 45 environment-gated skips                                               |
| Critical safety green                | PASS   | Phase 19: 472/472                                                                               |
| Docker images identified             | PASS   | P18.3 candidate, 3 local digests                                                                |
| SBOM complete                        | PASS   | 3/3 SPDX 2.3                                                                                    |
| Gitleaks complete                    | PASS   | 0 controlled-source; 26/26 history triaged; 0 unresolved                                        |
| Trivy complete                       | PASS   | final P18.3 scans                                                                               |
| CVE exceptions reviewed              | PASS   | 43 raw no-fix High rows/image; 8 CVEs classified `NOT_REACHABLE`                                |
| Authentication / authorization       | PASS   | P18.3 production smoke                                                                          |
| Production smoke                     | PASS   | P18.3 fresh/existing-volume/restart/audit smoke                                                 |
| Backup / restore                     | PASS   | P17/P17.1                                                                                       |
| Upgrade / rollback                   | PASS   | P17                                                                                             |
| Alerts                               | PASS   | P17.1 firing/recovery                                                                           |
| Runbook                              | PASS   | `docs/operations.md`                                                                            |
| README / limitations / release notes | PASS   | Phase 19 documents                                                                              |

Final production checklist: **READY** under the DriveGuard project release gate. A green hosted CI
run is still required for the eventual authorized pushed/tagged SHA before publication; no push or
publication is part of Phase 19.
