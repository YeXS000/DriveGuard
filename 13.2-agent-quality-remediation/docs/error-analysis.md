# Phase 13.2 Error Analysis

## Evidence source

This analysis uses the frozen Phase 13.1 quality run
`phase13.1:21948082-a6db-437f-b30a-f33209fd93f5`. All 600 observations are `VALID`; the report
attributes 869 failure records to Agent behavior and none to evaluation or infrastructure.

The categories below are root-cause labels for remediation. They can overlap because a single
case can contain a planning, lifecycle, and final-response failure.

## Initial root-cause distribution

| Root cause                                      | Cases | Representative cases                                                         | Evidence                                                                                                          |
| ----------------------------------------------- | ----: | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `UNNECESSARY_AUXILIARY_READ`                    |   282 | `NORMAL_NO_TOOL-003`, `NORMAL_NO_TOOL-004`, `VEHICLE_TRIP-001`               | 614 extra R0 reads; no-tool explanations frequently fetched vehicle, trip, charging, and weather state            |
| `OVER_PLANNING_EXTRA_WRITE`                     |    16 | `CHARGING-008`, `CHARGING-012`, `CHARGING-020`                               | 18 side-effect calls were outside the required goal                                                               |
| `MISSING_REQUIRED_ACTION`                       |    62 | `NAVIGATION-014`, `CHARGING-004`, `POLICY_CONFIRMATION-002`                  | Required Tool never appeared; the scorer recorded `MISSING_TOOL`                                                  |
| `UNNECESSARY_CLARIFICATION` / oral confirmation |    23 | `NAVIGATION-014`, `NAVIGATION-024`, `CHARGING-004`                           | User supplied the needed entity, but the model asked another question instead of proposing the action             |
| `CONFIRMATION_NOT_CREATED`                      |    22 | `NAVIGATION-014`, `CHARGING-004`, `CHARGING-014`                             | Confirmation language appeared without a formal pending action                                                    |
| `CONFIRMATION_FINALIZATION_MISSING`             |    61 | `NAVIGATION-002`, `NAVIGATION-004`, `CHARGING-002`                           | The protected action executed, but the lifecycle ended without a post-execution final response                    |
| `CRITICAL_POLICY_EVALUATION_MISSING`            |    47 | `NAVIGATION-014`, `CHARGING-004`, `POLICY_CONFIRMATION-010`                  | The required protected action was never proposed, so deterministic Policy never evaluated it                      |
| `ARGUMENT_EXTRACTION_FAILURE`                   |    27 | `NAVIGATION-044`, `CHARGING-044`, `CABIN_MEDIA-004`                          | Required argument values did not match the typed contract                                                         |
| `SCHEMA_VALIDATION_FAILURE`                     |     3 | `NAVIGATION-046`, `NAVIGATION-050`, `NAVIGATION-060`                         | Seven invalid-schema call records were emitted across three cases                                                 |
| `POST_EXECUTION_RESPONSE_STALE`                 |    16 | `VEHICLE_TRIP-045`, `NAVIGATION-002`, `CHARGING-024`                         | Execution state and assistant response disagreed; the common confirmation response remained stale after success   |
| `EMPTY_FAILURE_RESPONSE`                        |    58 | `EXECUTOR_FAULT_RECOVERY-002`, `EXECUTOR_FAULT_RECOVERY-003`, `CHARGING-044` | Runtime failure handling rolled back the transcript and returned an empty response                                |
| `TRANSIENT_READ_NOT_RECOVERED`                  |    30 | `EXECUTOR_FAULT_RECOVERY-002`, `-003`, `-006`                                | Read timeout/503/connection-abort cases failed before or during Tool execution                                    |
| `AMBIGUOUS_WRITE_NOT_RECONCILED`                |     9 | `EXECUTOR_FAULT_RECOVERY-004`, `-019`, `-034`                                | Executor correctly avoided blind retry but no business-state reconciliation completed                             |
| `DUPLICATE_REQUEST_NOT_RECOVERED`               |     9 | `EXECUTOR_FAULT_RECOVERY-005`, `-010`, `-015`                                | Idempotency prevented duplicate effects, but the result was not recovered into a successful or safe final outcome |

## Root causes in the implementation

1. `AgentSession` exposes every dynamically available Tool for every prompt. It has no intent,
   goal, known-information, shortlist, or stop-condition contract.
2. The system prompt permits broad state reads "when needed" but the runtime cannot validate that
   need. The model therefore treats R0 reads as free context gathering.
3. Tool schema validation and deterministic Policy happen only after model selection. When the
   model omits the required Tool, neither argument validation nor Policy can repair the plan.
4. A formal pending action is created only when the model actually calls an R2 Tool. Natural
   language confirmation does not create a challenge.
5. `confirmAndExecute` correctly resumes the frozen action and idempotency key, but its receipt is
   not fed to a final response generator. The pre-confirmation response is returned unchanged.
6. The runtime catch path returns text only for `POLICY_CONFIRMATION_REQUIRED`; context, Tool, and
   executor failures usually return an empty string.
7. The executor classifies ambiguous side effects conservatively as `OUTCOME_UNKNOWN`, but there is
   no Recovery Manager to reconcile external state before deciding whether a same-key retry is safe.

## Frozen-evaluation boundary

No Scorer V2, Ground Truth V2, task contract, pass condition, or critical safety criterion was
changed during this analysis. Any future evaluation defect is recorded in
`evaluation-change-review.md` before a separate review.
