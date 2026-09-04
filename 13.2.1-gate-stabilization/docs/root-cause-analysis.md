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

## Holdout fault-lifetime finding

The first frozen Holdout run exposed a general evaluation-harness coverage defect. Its three
mandatory-recovery failures all had `DUPLICATE_REQUEST`, `IDEMPOTENT_REPLAY`, and
`allowSafeDegradation=false`. The Development split contained no mandatory-recovery case, so the
gap was not observable before Holdout.

The production Recovery Manager already performs a bounded retry for a retry-safe 503 and reuses the
idempotency key. The live harness, however, translated `duplicate_request` to an HTTP 503 configured
with probability 1 and never released it. Every Executor attempt was therefore reinjected with 503,
making recovery impossible by construction. This was not an Agent or model failure.

The generic harness correction releases only `duplicate_request` after the first failed execution
attempt. The next attempt remains an Agent-side Reliable Executor recovery with the same idempotency
key; it is not a benchmark-runner retry. Other injected fault lifetimes are unchanged. A new
Development-side regression asserts the mode-based lifetime without using Holdout case IDs or
prompts. The original failed Holdout report is retained for audit, and all affected stability and
Development gates are rerun before Holdout is reopened.

## Provider-latency freshness drift

During the corrected fault stability sequence, one case had a 6.3-second provider turn. The
critical precheck correctly recorded `REQUIRE_CONFIRMATION`, but the later formal Tool Policy check
evaluated the unchanged static Simulator source timestamps after the five-second freshness window
and safely returned `REPLAN`. This made Policy classification and fault terminal state depend on
provider wall time rather than case data.

The isolated live harness now captures a fixed Policy clock immediately before each measured case
action. If a fixture intentionally establishes a session and then mutates Simulator context, the
clock is recaptured after that mutation; it then remains frozen throughout the measured model turn.
This prevents both provider latency from aging a static fixture and a legitimate fixture mutation
from being misclassified as `INVALID_FUTURE_TIMESTAMP`. End-to-end provider latency remains measured
independently with `performance.now()`. Production runtimes still use `SystemClock`; no freshness
rule, Policy profile, or production safety behavior is changed. The failed 130-case diagnostic that
exposed the future-timestamp issue is retained and is not counted as a stability pass.

The first full Development rerun exposed the complementary boundary: Simulator side effects create
new source timestamps during a Tool execution. Keeping the pre-action time frozen through that
execution made the post-execution refresh look future-dated and removed `STATE_REFRESHED` from many
confirmation lifecycles. The harness now recaptures time on Executor events, before and after the
external call, while remaining frozen during provider-only waiting. A separate Scorer audit false
positive was also fixed: confirmation guidance after an unprotected read is not a stale response;
the zero-tolerance stale counter applies only when the Case contract required a protected
confirmation lifecycle. Both changes are covered by Development-side regression tests, and the
failed complete Development report remains preserved rather than rescored or spliced.
