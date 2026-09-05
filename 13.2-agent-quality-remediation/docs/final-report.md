# Phase 13.2 Final Report

Status: **FINAL STAGE GATE FAIL**

No Phase 13.2 PASS is claimed. Three complete 420-case development runs were executed against the
official DeepSeek endpoint. Every observation was valid and none was attributed to evaluation or
infrastructure failure, but the frozen minimum gate was not met. Holdout, serial latency, and
official CAR-bench therefore remained sealed. The credential existed only in transient process
memory and was cleared when evaluation ended.

## Frozen Phase 13.1 baseline

| Metric                  |   Quality baseline | Serial-latency baseline |
| ----------------------- | -----------------: | ----------------------: |
| Case Pass Rate          |             42.00% |                  44.17% |
| Normal Task Success     |             41.73% |                  44.23% |
| Required Tool Recall    |             89.10% |                  90.16% |
| Tool Precision          |             44.43% |                  43.88% |
| Argument Validity       |             84.67% |                  86.50% |
| Critical Policy Recall  |             81.32% |                  84.62% |
| Confirmation Lifecycle  |             13.91% |                  13.91% |
| Recovery Success        |              0.00% |                   0.00% |
| Final Response Accuracy |             77.67% |                  78.17% |
| Simple P50/P95          | 2388.41/6827.16 ms |      2571.21/6750.62 ms |
| Multi-tool P50/P95      | 2768.30/4218.62 ms |      3389.41/5635.76 ms |

All 600 baseline observations were `VALID`; hard counters were Confirmation Bypass 0, Duplicate
Side Effect 0, and Forbidden Action Executed 0. The external CAR-bench baseline remained separate:
VALID 48, AGENT_FAILURE 26, INFRA_FAILURE 51, raw Pass@1 38.40%, valid Pass@1 64.86%.

## Implemented remediation

- deterministic Recovery Manager with bounded read retry, explicit failure taxonomy, recovery
  receipts, write reconciliation, and no blind ambiguous-write retry;
- confirmation completion that resumes the frozen action/fingerprint/idempotency key, refreshes
  authoritative state, and generates the final response from the execution receipt;
- goal-based Tool routing and a trusted per-turn stop contract, with RX Tools still excluded before
  routing;
- explicit-value argument binding before schema/Policy, without inventing absent protected values;
- non-empty safe failure responses and a receipt-to-response consistency guard;
- `DEEPSEEK_BASE_URL` support for HTTPS provider endpoints, retaining
  `DEEPSEEK_API_KEY` as the only credential source and `deepseek-v4-flash` as the verified installed
  text/tool model;
- deterministic 420-case development / 180-case holdout selection and dedicated commands.

## Stage evidence

| Stage                  | Evidence                                                                                                                             | Result                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| A Recovery             | 1,000 generated: 840/840 recovered, 160/160 safely degraded, blind retry 0, duplicate effect 0, empty response 0                     | PASS                       |
| B Confirmation         | 1,000 completions: ordered lifecycle 100%, stale response 0, empty response 0; same-action replay deduplicated                       | PASS                       |
| C Policy               | 10,000 matrix cases / 20,000 evaluations; critical 7,335/7,335; decision/rule/nondeterminism mismatch 0                              | PASS                       |
| D Routing              | 565/565 Agent cases exact candidate set; recall 100%, precision 100%; 35 urgent cases remain separate                                | PASS                       |
| E Arguments            | 548/548 explicit required argument contracts correct                                                                                 | PASS                       |
| F Response             | failed/unknown receipt success claims 0; every completion response non-empty                                                         | PASS                       |
| Local planning latency | 10,000 serial operations; P50 0.0032 ms, P95 0.0059 ms, P99 0.0151 ms                                                                | PASS, not provider latency |
| Local hard safety      | 10,000 Executor adversarial runs; forbidden action, duplicate effect, authorization replay, collision acceptance, unsafe retry all 0 | PASS                       |

The latest focused regression passed 116/116 tests across six files, and format, lint, typecheck,
and build passed before the final official run. The post-run full suite passed 2,220/2,220 executed
tests across 79 files; 43 pre-existing Phase 9 PostgreSQL/Redis cases remained environment-gated
because those services were unavailable.

## Evaluation runs

| Track                         | Scope                                                    | Status                                                                                |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Deterministic development     | 420 cases, concurrency 4                                 | 420/420 oracle/scorer-plumbing PASS; not Agent quality evidence                       |
| Deterministic holdout         | 180 cases, concurrency 4                                 | 180/180 oracle/scorer-plumbing PASS; not Agent quality evidence                       |
| Endpoint/authentication smoke | 1 development case, concurrency 1                        | 1/1 VALID before quota exhaustion; not a quality sample                               |
| Live development attempt 1    | 420 cases, custom endpoint, concurrency 4                | **INVALID — provider quota exhausted during the run**                                 |
| Provider-validity regression  | 1 development case after runner correction               | 1/1 `INFRA_FAILURE`; `infraErrorCount=1`; attribution correction verified             |
| Official dev round 1          | 420 cases, official endpoint, concurrency 4              | 420 VALID; case 81.43%; hard counters 0; retained before runner timing fixes          |
| Official dev round 2          | 420 cases, official endpoint, concurrency 4              | 420 VALID; case 87.38%; critical/safety 100%; frozen Safe Degradation 80.65%          |
| Official dev round 3          | 420 cases, official endpoint, concurrency 4              | 420 VALID; case 89.76%; Critical Policy Recall 99.23%; frozen Safe Degradation 83.87% |
| Live holdout                  | 180 cases, official endpoint, concurrency 4              | **NOT RUN — development minimum gate failed**                                         |
| Live serial latency           | 180 holdout cases, concurrency 1                         | **NOT RUN — development minimum gate failed**                                         |
| Official CAR-bench            | pinned commit `54990894241f2c07e9b523928c2a29e9b693d313` | **NOT RUN — development gate not reached; checkout pin verified**                     |

The deterministic reports record a dirty worktree and are retained only to prove the frozen split,
runner, scorer, and report path. They must not be presented as live model acceptance.

The original custom-endpoint artifact remains under `development-live-attempt-1-invalid-quota` for
audit only. Official round 1 is retained under `development-live-round-1-official`, round 2 under
`development-live-round-2-official`, and round 3 at the canonical `development-live` path. No
benchmark retry, case deletion, or cross-run result splicing was used.

### Official development metrics

| Metric                             | Round 2 | Round 3 | Minimum |
| ---------------------------------- | ------: | ------: | ------: |
| Case Pass Rate                     |  87.38% |  89.76% |   >=70% |
| Normal Task Success                |  93.96% |  92.58% |   >=75% |
| Required Tool Recall               | 100.00% |  99.75% |   >=95% |
| Tool Precision                     | 100.00% | 100.00% |   >=80% |
| Argument Validity                  |  95.48% |  99.76% |   >=95% |
| Confirmation Lifecycle             |  94.59% |  93.69% |   >=90% |
| Recovery Success                   | 100.00% |  96.77% |   >=80% |
| Safe Degradation, frozen aggregate |  80.65% |  83.87% |   >=95% |
| Critical Policy Recall             | 100.00% |  99.23% |    100% |
| Safety Enforcement                 | 100.00% | 100.00% |    100% |
| Confirmation Bypass                |       0 |       0 |       0 |
| Forbidden Action Executed          |       0 |       0 |       0 |
| Duplicate Side Effect              |       0 |       0 |       0 |

Round 2 is the strongest safety-classification run; it fails the frozen Safe Degradation minimum.
Round 3 includes corrected schema evidence, but a single stochastic omission in
`EXECUTOR_FAULT_RECOVERY-004` also violates the exact Critical Policy Recall minimum. A targeted
rerun was not substituted for the complete-run result.

## Integrity and review

- V2 dataset SHA-256 remains
  `70ef4ea213bd0d46674b70a4d99334d11e2ec16644777fe5054a6a52278d601f`, byte-identical to
  commit `166870fb0ffa90a1fedaaa98237dc763955fc16b`.
- Scorer V2, Ground Truth V2, scorer regressions, and hard safety criteria have no diff from the
  frozen Phase 13.1 commit.
- Four frozen-evaluation concerns are documented, not changed: reconciled `EXECUTED` versus blanket
  ambiguous-write `UNKNOWN`; a required `EXECUTED` lifecycle in failed/unknown cases; Safe
  Degradation divided by every fault case, including successful recoveries; and lexical
  final-response false positives.
- Final code-diff review found Critical 0 and High 0; no unresolved safety-boundary issue was found.
- `api_key.md` was not read. The supplied temporary credential was injected with terminal echo
  disabled, removed from the WSL shell after each run, and was not written to source, reports, or
  Git.
- Phase 14 was not started. `main` was not merged.

## Final Stage Gate

Result: **FAIL / no commit authorized by the phase workflow**.

The development minimum gate failed, so holdout, serial latency, and CAR-bench were not run. No
Phase 13.2 commit or merge to `main` was made, and Phase 14 was not started. The frozen evaluation
concerns require a separate review; this phase does not change them to manufacture a PASS.
