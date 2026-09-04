# Root Cause Analysis

## Fault denominator

Scorer V2 computes both `recoverySuccess` and `safeDegradation` over every valid case whose
`recovery.kind !== "NONE"`. The old degradation formula was:

```text
count(recovery.safeDegradation === true) / count(all valid fault cases)
```

The denominator is constructed by the `recovery` selection in `evals/scorers/v2.ts` and then reused
for both aggregates. In Phase 13.2 Round 2, six ambiguous writes were reconciled to successful
business completion. They were valid fault cases, so they remained in the shared 31-case
denominator even though their terminal state was recovery rather than degradation. The frozen V2
result was therefore 25/31 (80.65%) instead of the conditional 25/25.

## Critical planning miss

Phase 13.2 Round 3 `EXECUTOR_FAULT_RECOVERY-004` contained no formal Tool execution and no model-
initiated Policy path. The model returned a final response asking for a station identifier even
though `station-pudong-001` was present in the request. Round 2 had proposed
`reserve_charging_slot({stationId: "station-pudong-001"})`, received `REQUIRE_CONFIRMATION`, and
completed the expected bounded reconciliation path.

The existing flow triggered Policy only inside `PiToolAdapter -> PolicyGuardedToolHandler`. The Goal
Router shortlisted the right capability and the Argument Binder could canonicalize the station ID,
but Policy coverage still depended on the stochastic model producing a schema-valid Tool proposal.
No independent completeness validator existed. Existing `ToolRegistry`, `ToolPolicyProfileRegistry`,
`GoalToolRouter`, `ToolArgumentBinder`, and `PolicyEngine` were reusable, so no router or policy
rewrite was required.

## Diagnostic stability finding

The first diagnostic critical run reached 100% Critical Policy Recall but exposed a second edge:
`EXECUTOR_FAULT_RECOVERY-034` emitted a model Tool request with invalid arguments. The initial guard
mistook the request event for a complete plan even though no validated formal Tool evidence existed.
Completeness now uses validated formal execution evidence, so a malformed proposal triggers the same
single constrained repair as a fully omitted proposal. The diagnostic run is retained separately and
is not one of the three accepted stability rounds.
