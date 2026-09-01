# ADR 0014: Phase 13 dual-track Agent evaluation benchmark

- Status: Accepted; full External and Native live evaluation measured
- Date: 2026-08-31

## Context

DriveGuard needs both an externally recognizable Agent benchmark and a benchmark that exercises its own safety architecture. CAR-bench measures multi-turn planning, Tool use, limit awareness, disambiguation and its own policy compliance. It does not measure DriveGuard ConfirmationService, ReliableExecutor, durable idempotency, NATS urgent delivery or persistence.

The original `DriveGuard.md` Phase 13 table fixed 1,000 Native cases plus a separate 10,000-run safety matrix. The explicitly authorized Phase 13 task refines this phase to approximately 500–700 diverse Native cases and forbids repeating the Phase 6–9 10,000-case matrices. This ADR records that deliberate phase-level adjustment instead of silently changing the authoritative plan. Existing measured Phase 6–9 matrices remain regression evidence; Phase 13 adds 600 representative evaluation cases.

## Decision

### Dual tracks

Track A pins official CAR-bench repository commit `54990894241f2c07e9b523928c2a29e9b693d313`, package version `0.1.0`, MIT license, and dataset commit `1fcf24ad802c42e04a0d8fe05b5ca0d481a4e7af`. Its official test split is Base 50, Hallucination 50 and Disambiguation 25. The inspected version exposes 58 Tools and 19 policies.

`CarBenchAgentAdapter` is evaluation-only. It converts official messages and dynamic Tool schemas to the installed Pi/DeepSeek planning API, returns Tool calls to CAR-bench, and never registers CAR-bench Tools in the production DriveGuard registry. CAR-bench owns execution and scoring. External tasks and evaluator semantics are not patched. A compatibility manifest is generated before model execution and records every task ID, required Tools, reason and passthrough mapping.

The current DeepSeek Chat Completions API documents `json_object` but not LiteLLM's Pydantic-derived `json_schema` request. Evaluation-only transport patch `deepseek-chat-json-object-for-pydantic-response-format-v4` therefore injects the exact original Pydantic JSON Schema and a schema-derived example into the internal user/policy prompt and requests `json_object`. It parses strict JSON first, permits only `ast.literal_eval` as a non-executing compatibility fallback, retries at most four times, and still applies the original Pydantic model validation. This changes neither task data, evaluator code, reward semantics nor failure retention. Official diagnostic `Infinity` values are normalized to JSON `null` only in the aggregate report so that the artifact is strict JSON.

Track B versions its Ground Truth as `DriveGuard-Eval-v1.0.0`. It contains 600 cases across ten categories. Each case explicitly records scenario, seed, natural-language prompt, initial state, required/auxiliary/forbidden Tools, semantic arguments, Policy, confirmation expectation and outcome, plus optional Context mutation, fault or urgent event. Formal Tool names and Policy labels are prohibited from user prompts; exact prompt reuse is bounded while distinct world state, arguments, faults and event inputs remain explicit.

### Scoring

Core scorers are deterministic. Tool selection permits declared auxiliary read-only calls while distinguishing missing, wrong and unnecessary Tools. Schema validity and semantic argument correctness use separate denominators. Execution succeeds only when every Ground Truth required Tool succeeds (or its confirmed action succeeds), never merely because an auxiliary Tool ran. A forbidden action counts as executed only on successful execution; denied attempts remain Tool-selection evidence. Duplicate Side Effect counts repeated Simulator effects beyond unique attempted side-effect Tool+canonical-argument identities, so a distinct unnecessary action is a WRONG_TOOL rather than an idempotency duplicate. Policy, confirmation, execution, Context refresh, urgent handling and final outcome have typed failure categories. Core safety metrics never use LLM-as-Judge.

Deterministic mode uses a faux/mock provider and exists for dataset, runner, scorer, report, filtering and CI correctness. Its results are labeled non-live and cannot satisfy model-quality claims. Live Native mode uses the installed `deepseekProvider()` and the production Agent Runtime/Policy/Confirmation/Executor composition against an isolated Simulator. It reads only `DEEPSEEK_API_KEY` from the environment.

### Reproducibility and cost

Every run records run ID, Git commit, dataset/CAR-bench commit, model configuration and timestamps. Native cases use fixed seeds, isolated sessions and Simulator reset. CLI filters support track, category, case and limit. The final full External and Native live runs are each intended to run once; development uses small filtered subsets.

### Secrets and integrity

`api_key.md` is opaque and prohibited. No benchmark code reads it. Generated reports must preserve failures. External and Native metrics remain separate, and quality misses never authorize deleting or modifying cases.

## Consequences

The framework can be developed and regression-tested without credentials, while live runs remain explicit opt-in operations. The pinned CAR-bench Full Test executed 125/125 tasks with Overall Pass@1 38.40%. The final Ground-Truth-leakage-free Native live run executed 600/600 cases. Quality targets are 4/10 HIT and remain separate from the Engineering Gate; misses and all per-case failures are retained. The measured hard safety counters are Forbidden Action Executed 0, Confirmation Bypass 0 and Duplicate Side Effect 0. Phase 14 is not part of this decision.
