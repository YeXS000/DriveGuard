# Phase 13.1 Baseline V2 Report

Date: 2026-09-02 (Asia/Shanghai)

## Outcome

The trusted Evaluation V2 baseline is established and frozen. Both required credential-backed
Native runs completed against `deepseek-v4-flash`: quality at case concurrency 4 and latency at
concurrency 1. The scorer regression, schema, trace, isolation, audit, hard-safety, and engineering
gates pass. Phase 13.1 is **PASS**. This result identifies Agent optimization work but does not start
Phase 13.2.

## Measured evidence

| Check                           | Result                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| V1 dataset preservation         | 600 cases; SHA-256 `3429011c3ed86889812ffcdd66d1c1cc3d1b26bf4bc2eb615381524adcae51a8`           |
| V2 schema validation            | 600/600 PASS                                                                                    |
| Required scorer regression      | 15/15 PASS                                                                                      |
| Phase 13.1 focused suite        | 33/33 PASS across 5 files                                                                       |
| Full local regression           | 2,183 PASS across 71 files; 43 existing Phase 9 DB tests environment-gated                      |
| Engineering checks              | format, lint, typecheck, build, diff check PASS; npm audit 0 vulnerabilities                    |
| Deterministic V2 runner         | 600/600 PASS at concurrency 4; plumbing-only, not model quality                                 |
| Quality live run                | `phase13.1:21948082-a6db-437f-b30a-f33209fd93f5`; 600 VALID; concurrency 4; benchmark retries 0 |
| Serial latency run              | `phase13.1:efe92120-218f-4c28-9b9a-dcaec87384b6`; 600 VALID; concurrency 1; benchmark retries 0 |
| Identity isolation              | 600 unique run, case, trial, trace, and idempotency identifiers in each live run                |
| Hard safety counters            | Confirmation Bypass 0; Duplicate Side Effect 0; Forbidden Action Executed 0                     |
| Error attribution               | Quality: Agent 869; Evaluation 0; Infrastructure 0                                              |
| Trace and transition audit      | Critical 199/199; Confirmation 151/151; Fault 45/45; Urgent 35/35; changed transitions 116/116  |
| CAR-bench frozen classification | VALID 48; AGENT_FAILURE 26; INFRA_FAILURE 51; EVALUATOR_FAILURE 0                               |

Provider-internal retry count is not exposed by the provider adapter and remains `unobserved`; it is
not guessed as zero. The benchmark-layer retry count is measured as zero for both live runs.

## Native quality baseline

| Metric                                       |      Quality V2 |
| -------------------------------------------- | --------------: |
| Case Pass Rate                               |          42.00% |
| Normal Task Success                          |          41.73% |
| Required Tool Recall                         |          89.10% |
| Tool Precision                               |          44.43% |
| Tool Selection Accuracy / Exact Plan Success | 47.67% / 47.67% |
| Missing / Unnecessary Tool Count             |        62 / 634 |
| Argument Validity                            |          84.67% |
| Action-level Policy Accuracy                 |          89.22% |
| Critical Policy Recall                       |          81.32% |
| Policy Classification Errors                 |              73 |
| Confirmation Lifecycle Compliance            |          13.91% |
| Execution Outcome Accuracy                   |          81.50% |
| Safety Enforcement Accuracy                  |         100.00% |
| Recovery Success / Safe Degradation          |  0.00% / 33.33% |
| Outcome Reconciliation / Recovery Safety     | 80.00% / 80.00% |
| Final Response Accuracy                      |          77.67% |

The primary remaining Agent failures are unnecessary Tool use (282 case failures / 634 calls),
confirmation lifecycle errors (131), final-response errors (118), execution-outcome errors (111),
Policy errors (73), missing Tools (62), recovery errors (42), wrong arguments (27), stale
post-execution responses (16), and invalid schemas (7). Category pass counts are: no-tool 9/50,
vehicle/trip 41/70, navigation 24/70, charging 13/90, cabin/media 47/60, multi-tool 25/50,
context-refresh 48/60, policy/confirmation 10/70, fault recovery 0/45, and urgent event 35/35.

## Serial latency baseline

The latency run is directly comparable to the Phase 13 serial condition because its recorded
profile is `latency`, concurrency is exactly 1, and `latencyComparableToPhase13Serial=true`.

| Task class |        P50 |        P95 |
| ---------- | ---------: | ---------: |
| Simple     | 2571.21 ms | 6750.62 ms |
| Multi-tool | 3389.41 ms | 5635.76 ms |

## Offline rescore and audit

The saved quality trace supplies every V2 dimension, so all 600 Phase 13 cases are scorable and no
case requires rerun:

- OLD PASS -> NEW PASS: 220
- OLD PASS -> NEW FAIL: 84
- OLD FAIL -> NEW PASS: 32
- OLD FAIL -> NEW FAIL: 264

All 84 newly failing cases and all 32 scorer-bug FAIL-to-PASS cases are retained in the live delta
report with case IDs, V1/V2 reasons, and category. The most frequent corrected V1 reasons in the 32
FAIL-to-PASS cases are `WRONG_TOOL` (24 occurrences), `EXECUTION_ERROR` (9), `WRONG_FINAL_RESPONSE`
(5), `WRONG_POLICY` (5), and `WRONG_ARGUMENT` (2). Counts can overlap because one case may have
several V1 failures.

During calibration, two evaluation-derived false positives were found and fixed without changing
the Agent: no-tool/safety-refusal execution-channel attribution, and ambiguous-side-effect business
outcome normalization before offline rescoring. The final reports record
`DriveGuard-Scorer-v2.0.0` plus a rescore timestamp.

## CAR-bench

The frozen official result remains raw Pass@1 38.40%. Reclassification identifies 51 infrastructure
failures, leaving valid-trial Pass@1 64.86%. Official rewards were not changed, failed trials were
not retried or promoted, and Base/Hallucination/Disambiguation remain separately reported. Native
and CAR-bench results are not averaged.

## Gate disposition

Phase 13.1 Stage Gate: **PASS**. The temporary credential was accepted only through a no-echo stdin
read into the live child-process environment. It was not written to the repository, command line,
shell history, reports, or logs; the live process exited and the variable is absent from the caller
environment. `api_key.md` was not read or used. `main` remains unchanged and Phase 13.2 was not
started.
