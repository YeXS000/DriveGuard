# Phase 13.2.1 Final Report

## Decision

Phase 13.2.1 **PASS**. The Phase 13.2 blockers were closed with Scorer V2.1 semantics,
bounded critical-path repair, and evaluation-harness clock/fault corrections. All mandatory Native
gates passed on complete, single-run observation sets. The external CAR-bench run is reported as an
independent benchmark and is not combined with DriveGuard-Native accuracy.

Phase 14 was not started. `main` was not merged.

## Freeze and integrity

- Agent implementation freeze: `9a62b7df9a114c0dcb5965977b034ad2b90f64da`.
- Final evaluator correction: `49ad013e5a4ed0e75f8cc327cdada7762d1a6f68`.
- Frozen dataset SHA-256: `70ef4ea213bd0d46674b70a4d99334d11e2ec16644777fe5054a6a52278d601f`.
- Frozen Scorer V2 SHA-256: `d185ee551dcafaef3a87a160f99073c646b2b10f89bc4db3a1b8314093524d4f`.
- No per-case reruns, result splicing, post-result selection, Ground Truth weakening, or singleton
  replacement was used.

## Root cause and V2.1 semantics

The Phase 13.2 failure combined two issues: critical capabilities could be omitted before Policy
evaluation, and Scorer V2 collapsed recovered outcomes, required degradation, and unsafe/incorrect
outcomes into a single fault aggregate. V2.1 adds terminal states `RECOVERED`, `SAFE_DEGRADED`, and
`UNSAFE_OR_INCORRECT`, with recovery and degradation denominators limited to applicable cases. It
does not change Ground Truth requirements or hard-safety criteria.

The Agent fix records the required critical capability envelope before planning and permits one
constrained repair only for an already resolved one-to-one capability mapping. Every side effect
still traverses Policy, confirmation/action state, Reliable Executor, persistence, and audit.

## Stability evidence

### Critical three-round gate

| Round | Cases | Critical Policy | Safety | Hard/audit counters | Tool recall | Tool precision | Arguments | Confirmation |
| ----- | ----: | --------------: | -----: | ------------------: | ----------: | -------------: | --------: | -----------: |
| 1     |   130 |            100% |   100% |               all 0 |        100% |         99.19% |      100% |       94.59% |
| 2     |   130 |            100% |   100% |               all 0 |        100% |           100% |      100% |       94.59% |
| 3     |   130 |            100% |   100% |               all 0 |        100% |           100% |      100% |       94.59% |

Round 1 retained one unnecessary Tool request with no side effect. D2 requires Critical Policy and
Safety at 100% with hard/audit counters at zero; all three rounds pass.

### Fault three-round gate

Each round covered 31/31 fault cases: fault handling 31/31, recovery 10/10, required safe
degradation 21/21, Critical Policy 100%, Safety 100%, and all hard/audit counters zero. Round 3
retained one unnecessary Tool request without side effect (precision 96.88%). D3 passes in all
three rounds.

## Official Native gates

| Gate                                |         Development |            Holdout |
| ----------------------------------- | ------------------: | -----------------: |
| Cases                               |             420/420 |            180/180 |
| Case pass                           |              90.00% |             92.22% |
| Normal task success                 |              92.03% |             91.03% |
| Tool recall / precision / selection |  100% / 100% / 100% | 100% / 100% / 100% |
| Argument validity                   |                100% |               100% |
| Policy / Critical Policy            |         100% / 100% |        100% / 100% |
| Confirmation compliance             |              94.59% |               100% |
| Execution outcome                   |              97.86% |               100% |
| Safety enforcement                  |                100% |               100% |
| Fault / recovery / degradation      | 31/31; 10/10; 21/21 |    14/14; 5/5; 9/9 |
| Hard and audit counters             |               all 0 |              all 0 |
| Agent / evaluator / infra errors    |          51 / 0 / 0 |         14 / 0 / 0 |

Both gates pass their complete, unspliced acceptance criteria.

## Serial latency

The official 180-case Holdout was rerun at `concurrency=1`.

| Cohort     | Phase 13.1 P50 / P95 | Phase 13.2.1 P50 / P95 | Reduction P50 / P95 |
| ---------- | -------------------: | ---------------------: | ------------------: |
| Simple     | 2571.21 / 6750.62 ms |   1689.12 / 3220.14 ms |       34.3% / 52.3% |
| Multi-tool | 3389.41 / 5635.76 ms |   2109.48 / 2564.85 ms |       37.8% / 54.5% |

The serial run also retained 100% Tool, argument, Policy, Critical Policy, confirmation, execution,
safety, fault, recovery, and degradation metrics, with all hard counters zero.

## External CAR-bench

Official CAR-bench commit `54990894241f2c07e9b523928c2a29e9b693d313`, dataset commit
`1fcf24ad802c42e04a0d8fe05b5ca0d481a4e7af`, 125/125 tasks, one trial, no benchmark task or
official evaluator semantic modifications, and no post-result cherry-picking.

| Split          | Tasks | Raw Pass@1 | Valid Pass@1 | VALID | AGENT_FAILURE | INFRA_FAILURE | EVALUATOR_FAILURE |
| -------------- | ----: | ---------: | -----------: | ----: | ------------: | ------------: | ----------------: |
| Base           |    50 |     50.00% |       62.50% |    25 |            15 |            10 |                 0 |
| Hallucination  |    50 |     22.00% |       64.71% |    11 |             6 |            33 |                 0 |
| Disambiguation |    25 |     64.00% |       76.19% |    16 |             5 |             4 |                 0 |
| Overall        |   125 |     41.60% |       66.67% |    52 |            26 |            47 |                 0 |

The external user simulator frequently returned non-JSON output and then raised an upstream
`UnboundLocalError`; bridge timeouts were also retained. These 47 cases remain raw benchmark
failures and are excluded only from the separately labelled valid denominator. No case was rerun.

## Verification and review

- Phase-specific regression: 80/80 PASS across 13 files.
- Final full regression: 83 files passed, one database-environment file skipped; 2,252 tests
  passed and 43 existing environment-gated tests skipped.
- Format, lint, typecheck, build, diff check, dataset/scorer hash checks, and secret scan pass.
- Final self-review: Critical 0, High 0, unresolved safety-boundary issues 0.
- The temporary credential was supplied only to the no-echo child-process environment and expired
  with that process. It was not written to repository artifacts; `api_key.md` and `.env` were not
  read or used.

## Known limitations

- External CAR-bench has substantial upstream simulator/bridge attrition; Raw and Valid Pass@1 must
  always be shown together.
- Development retains 51 scored Agent failures and Holdout retains 14; Phase PASS is based on the
  explicit phase thresholds, not a claim of perfect general quality.
- PostgreSQL/Redis integration tests remain environment-gated when those services are unavailable.
