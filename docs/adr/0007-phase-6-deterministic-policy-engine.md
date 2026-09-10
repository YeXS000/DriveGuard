# ADR 0007: Phase 6 deterministic Policy Engine

- Status: Accepted
- Date: 2026-08-28

## Context

Phase 5 connected the Pi Agent to the accepted Context and formal Tool contracts, but its development side-effect path was explicitly pre-Policy. Phase 6 must place one deterministic, auditable, fail-closed decision point after formal schema validation and before any Tool handler. It must reuse Phase 2 freshness/conflict facts and Phase 4 Tool metadata without allowing the LLM or prompt to make an execution decision.

Confirmation, Pending Action, Action State Machine, Reliable Executor, retry, circuit breaker, production idempotency, persistence, and urgent-event automation remain outside this phase.

## Decision

### Decision and input models

- `PolicyDecision` is immutable and contains `decision`, `ruleId`, `reasonCode`, `toolName`, `riskLevel`, `contextSnapshotId`, `contextVersion`, `evaluatedAt`, and structured `evidence` only.
- The four decisions are `ALLOW`, `DENY`, `REQUIRE_CONFIRMATION`, and `REPLAN`.
- Evidence is restricted to freshness/conflict state and capability/service availability. Tool arguments, authorization, secrets, prompts, model reasoning, and hidden reasoning are excluded.
- Normal input is `PolicyEvaluationInput`: the canonical `ToolDefinition`, schema-validated arguments, `ContextSnapshot`, Phase 2 freshness result, capability/service availability, and an optional Phase 2 conflict result. The public Engine accepts `unknown` only so forged/direct input can fail closed rather than throw.
- `evaluatedAt` is caller-supplied audit metadata. It does not influence rule selection.

### Stable rule precedence

The Registry validates stable IDs and priorities, rejects duplicate IDs, and sorts by numeric priority then rule ID. Evaluation stops at the first terminal rule.

| Priority | Rule ID      | Condition                            | Result                                     |
| -------: | ------------ | ------------------------------------ | ------------------------------------------ |
|       P0 | `DG-POL-001` | Forbidden/RX name                    | `DENY / FORBIDDEN_RX`                      |
|       P1 | `DG-POL-002` | Invalid or malformed Policy input    | `DENY / INVALID_POLICY_INPUT`              |
|       P2 | `DG-POL-003` | Capability or service unavailable    | `DENY`                                     |
|       P3 | `DG-POL-004` | Missing or invalid Context           | `DENY / CONTEXT_INVALID`                   |
|       P4 | `DG-POL-005` | Side-effect Context not fresh/latest | future: `DENY`; stale/not-latest: `REPLAN` |
|       P5 | `DG-POL-006` | Relevant or unknown Context conflict | relevant: `REPLAN`; unknown path: `DENY`   |
|       P6 | `DG-POL-007` | R3                                   | `REQUIRE_CONFIRMATION`                     |
|       P7 | `DG-POL-008` | R2                                   | `REQUIRE_CONFIRMATION`                     |
|       P8 | `DG-POL-009` | R1                                   | `ALLOW`                                    |
|       P9 | `DG-POL-010` | R0                                   | `ALLOW`                                    |
|      P10 | `DG-POL-011` | Terminal fallback                    | `DENY / DEFAULT_DENY`                      |

Unknown, malformed, exceptional, or unmatched state never falls back to `ALLOW`.

### Tool Policy profiles

Every one of the 14 formal Tools has exactly one immutable `ToolPolicyProfile`. Profiles bind the accepted risk, side-effect status, Context requirement, Phase 2 relevant paths, confirmation requirement, capabilities, and services.

| Risk | Tools                                                                                                      | Context requirement | Default decision       |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------- |
| R0   | `get_vehicle_state`, `get_trip_state`, `get_weather`, `search_charging_stations`, `get_charging_status`    | `STATE_REFRESH`     | `ALLOW`                |
| R1   | `set_cabin_temperature`, `set_seat_heating`, `set_media_volume`                                            | `LATEST_REQUIRED`   | `ALLOW`                |
| R2   | `set_navigation_destination`, `reroute_to_charger`, `reserve_charging_slot`, `cancel_charging_reservation` | `LATEST_REQUIRED`   | `REQUIRE_CONFIRMATION` |
| R3   | `request_roadside_assistance`, `request_emergency_support`                                                 | `LATEST_REQUIRED`   | `REQUIRE_CONFIRMATION` |

R0 reads remain available as state-refresh mechanisms even when the prior snapshot is stale or not latest. Side-effect Tools use Phase 2 freshness and conflict outputs: invalid future timestamp denies; stale/not-latest replans; relevant change replans; unknown relevant path denies. An irrelevant version change does not replan.

### Runtime interception and events

- `PolicyGuardedToolHandler` is the single interception layer between `PiToolAdapter` schema validation and the existing formal Tool handler.
- The guard verifies canonical Registry identity, builds fresh Policy facts, evaluates exactly one decision, and invokes the handler only for `ALLOW`.
- `DENY`, `REPLAN`, and `REQUIRE_CONFIRMATION` map to `POLICY_DENIED`, `POLICY_REPLAN_REQUIRED`, and `POLICY_CONFIRMATION_REQUIRED`; all execute the underlying handler zero times.
- Runtime emits `policy.evaluation.started`, exactly one `policy.decision.made`, and, for a blocked execution, `policy.execution.blocked`. Events contain safe identity, Tool, decision, rule, and time metadata only.
- Capability resolution still controls normal Tool exposure. Policy independently denies forged/direct unavailable capability or service requests.
- RX names remain absent from the formal Registry, and the P0 rule additionally denies forged/direct `apply_brake`, `control_steering`, `set_throttle`, `disable_aeb`, and `disable_esc` requests.

### Determinism and I/O boundary

The Engine is synchronous and contains no LLM, prompt decision, network, database, clock, random source, locale-dependent comparison, or unordered async work. Context loading and conflict calculation occur outside the pure Engine. Rule and profile registries are immutable at evaluation time.

## Consequences

- R0/R1 may reach the existing handler only after Policy `ALLOW`.
- R2/R3 are intentionally blocked because Phase 7 confirmation does not exist. Phase 6 creates no Pending Action, confirmation token/API, Action State Machine, persistence, or Reliable Executor.
- A Policy decision is an execution-control result, not an LLM response. The system prompt may describe the boundary but cannot override it.
- Runtime sessions, events, and decisions remain process-local and non-durable.
- The development provider remains non-production infrastructure even though its formal Tool calls are now Policy-guarded.
