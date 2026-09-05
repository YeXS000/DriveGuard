# Evaluation Change Review

## Status

Scorer V2, Ground Truth V2, case pass conditions, and critical safety standards remain frozen.
Narrow runner-only corrections were approved after independent tests proved provider validity,
fault timing, and validated-argument evidence were being represented incorrectly.

The following remain frozen at Phase 13.1 commit
`166870fb0ffa90a1fedaaa98237dc763955fc16b`:

- Scorer V2 core definitions
- Ground Truth V2
- V2 case pass conditions
- critical safety standards

Potential scorer defects, if discovered, must be listed here with affected case IDs, independent
reproduction, and before/after reports. Recording an issue does not authorize a scorer change.

## Approved runner correction: provider availability validity

The first Phase 13.2 development run reached the supplied endpoint successfully, then the provider
reported `insufficient_user_quota` with balance zero and subsequently HTTP 429. The original live
adapter converted these `MODEL_ERROR` results into `validity: VALID`, causing missing Tool calls and
downstream score failures to be attributed to the Agent.

The live adapter now classifies narrowly matched provider quota, rate-limit, 5xx, network, socket,
and connection failures as `INFRA_FAILURE`. Other model request/transport contract failures are
`EVALUATOR_FAILURE`; Tool and Policy failures remain `VALID` Agent observations. The safe provider
message is retained as evidence, while Scorer V2 and every case contract remain byte-for-byte
unchanged. Direct unit regressions cover quota, 429, 503, network, evaluator-contract, and Tool
failure cases.

## Approved runner corrections: fault timing and validated argument evidence

The official-endpoint development run initially configured persistent Simulator faults before the
Runtime's mandatory Context load. For the 19 read-fault cases targeting `vehicle.get_state`, the
fault was therefore consumed by Context loading before the required Agent Tool could run. The
frozen contracts require the Agent Tool and its Policy evaluation to be observed. The runner now
arms the declared fault on the evaluated run's `context.loaded` event, after initial Context is
available and before Tool dispatch. An integration test proves that `prepareNativeCase` leaves the
dependency healthy and that explicit post-Context arming activates the declared fault.

The same run reconstructed failed Tool arguments from successful result payloads. A downstream
dependency failure therefore turned schema-valid `{}` read arguments and bound navigation
arguments into apparent schema or semantic failures. Formal Tool evidence now carries the
already-validated, cloned arguments from the schema boundary. The runner consumes that evidence
without changing argument matchers or case contracts. Contract tests prove that failed dependency
executions retain validated input evidence, while executions that never crossed schema validation
do not claim it.

## Recorded review item: ambiguous-write recovered outcome

The frozen V2 Ground Truth assigns `FAILED` plus final business outcome `UNKNOWN` to every
`AMBIGUOUS_SIDE_EFFECT` case. A production-safe reconciler can instead prove that the write was
`EXECUTED` and return a successful receipt without replaying the write. The frozen expectation can
therefore penalize a more informative, externally verified outcome.

No scorer, dataset, or case contract is changed in Phase 13.2. Final reports will show the frozen
score and this architecture-level observation separately.

## Recorded review item: confirmation lifecycle versus fault outcome

Protected Agent fault cases inherit the full successful lifecycle ending in `EXECUTED` and
`STATE_REFRESHED`, even when their frozen execution contract requires `FAILED` plus `UNKNOWN` or
`SAFE_DEGRADATION`. A truthful production lifecycle omits `EXECUTED` when the receipt is failed or
unknown. The frozen scorer can therefore report both a correct failure outcome and a confirmation
lifecycle failure for the same observation.

Again, this is documentation only. Scorer V2 and Ground Truth V2 remain unchanged.

## Recorded review item: Safe Degradation aggregate denominator

Official development round 2 contains 31 recovery cases. Twenty-five terminate with an explicit,
non-empty safe-degradation response and zero duplicate effects. The other six are not degraded:
they are applied write timeouts that the Recovery Manager reconciles to `SUCCEEDED` with exactly
one Simulator side effect. Scorer V2 nevertheless computes `Safe Degradation` over all 31 recovery
cases, so the reported value is `25 / 31 = 80.65%`. Among cases that actually require degradation,
the observed rate is `25 / 25 = 100%`.

The Phase 13.2 minimum gate asks for `Safe Degradation >= 95%`. With the frozen aggregate, a
truthful successful reconciliation lowers this metric; reaching 95% would require falsely marking
successful executions as degraded or deliberately turning successful reconciliation into failure.
Neither action is acceptable. No scorer or observation semantics are changed. The frozen metric
and the applicable-case diagnostic remain separately reported.

## Recorded review item: lexical final-response false positives

Scorer V2 treats any occurrence of broad phrases such as Chinese `未执行`, `需要确认`, or `完成` as
an execution-state claim without considering negation scope or explanatory context. This marks
truthful responses such as “未执行任何额外动作” after a successful read as a contradiction and
marks an explanation of why an operation may require confirmation as a pending confirmation.
Representative round-2 cases are `VEHICLE_TRIP-065`, `MULTI_TURN_CONTEXT_REFRESH-005`,
`NAVIGATION-065`, `NORMAL_NO_TOOL-011`, and `NORMAL_NO_TOOL-023`.

This is recorded rather than worked around with benchmark-specific wording. The receipt-backed
confirmed-action response generator remains authoritative for actual post-execution state.
