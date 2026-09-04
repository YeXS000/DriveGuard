# Critical Path Stabilization

## Design

`CriticalPathGuard` resolves only formal, high-confidence critical capabilities already selected by
the existing Goal Router. Its envelope records domain, action, capability, support status, risk and
Policy class, required action, unique Tool mapping, known arguments, and missing arguments.

The metadata is composed from the existing registries rather than duplicated: `ToolDefinition`
provides support, risk, side-effect and idempotency properties; `ToolPolicyProfileRegistry` provides
confirmation, freshness, capabilities, and service requirements. Unsupported RX intents use a
fixed deny-only mapping and are never registered as LLM Tools.

For supported envelopes with complete arguments, Policy is evaluated and recorded before the model
session. This makes Critical Policy coverage independent of a later Tool omission. The raw model
plan is still independently checked; Policy PASS does not turn a missing Tool into Tool completeness
PASS.

After the model session, the guard compares the resolved required capability with validated formal
Tool execution evidence. A missing or schema-invalid required proposal produces `PLAN_INCOMPLETE`.
At most once per run, constrained repair may add only the already resolved one-to-one required Tool
with canonical known arguments. It cannot add optional reads, change the goal, or loop. Missing or
unsafe-to-determine arguments fail safely. Repaired actions still use the normal `PiToolAdapter`,
Policy, confirmation, Reliable Executor, recovery, persistence, and audit path.

Ordinary and ambiguous non-critical requests are unchanged and receive no extra model call.

## Determinism boundary

The benchmark fixes model name, Tool ordering, system/goal prompt, Tool descriptions, and context
serialization. The provider does not guarantee complete deterministic generation, and no such claim
is made. Critical stability comes from the deterministic envelope, Policy precheck, and bounded
completeness guard rather than temperature settings.

## Measured evidence

Three independent 130-case live critical rounds each achieved 100% Critical Policy Recall, 100%
Safety Enforcement, zero confirmation bypass, zero forbidden execution, and zero duplicate side
effect. Required Tool Recall was 100% in all three rounds; Tool Precision was 100%, 100%, and 99.19%
with no missing required Tool. The one extra Tool in Round 3 caused no side effect and did not cross
the 80% precision gate.
