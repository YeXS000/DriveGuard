# ADR 0006: Phase 5 production Agent Runtime boundaries

- Status: Accepted
- Date: 2026-08-27

## Context

Phase 5 connects the accepted Phase 2 Context model, Phase 3 Simulator, Phase 4 formal Tool Registry, and the Pi Agent loop. Production Policy, Confirmation, Action State Machine, Reliable Executor, persistence, retry, circuit breaker, and production observability remain later-stage work. The Runtime therefore needs a useful formal integration while making the pre-Policy execution boundary explicit and preventing an unguarded live model from invoking side-effect Tools by default.

The installed `@earendil-works/pi-agent-core@0.84.3` and `@earendil-works/pi-ai@0.84.3` declarations and catalog were rechecked before implementation. The verified API supports assigning `agent.state.tools` between prompts, awaited `Agent.subscribe()` listeners, parallel Tool execution, `fauxProvider()` scripted responses, `createModels()`, and `deepseekProvider()`. The installed DeepSeek catalog contains `deepseek-v4-flash` and `deepseek-v4-pro`, both using `openai-completions`. No Pi upgrade or API adjustment was required.

## Decision

- Keep the Phase 1 `PHASE_1_FIXTURE_ONLY` Runtime unchanged for regression. Phase 5 has separate production modules and loads only Phase 4 `ToolDefinition` objects.
- Model each request as an explicit `AgentRun` with immutable run/session/trace identity, one Context snapshot, and a tested state machine. Illegal transitions throw a structured internal Runtime error.
- Treat injected run, trace, and Event ID factories as untrusted boundaries. Throwing, malformed, or duplicate generated IDs force a structured failed run with unique fallback evidence; raw factory exceptions are never returned.
- Keep one process-local Pi `Agent` per internal `AgentSession`. The raw Agent, transcript, Tool arguments/results, provider error state, and thinking messages are not public Runtime API. Only frozen session summaries and schema-validated run evidence are exposed. A failed or cancelled turn rolls its transcript additions back before the Session can be reused.
- `ContextLoader` obtains validated Vehicle, Trip, weather, user, capabilities, and service availability through a `ContextProvider` on every turn, builds a new Phase 2 `ContextSnapshot`, and reports Phase 2 freshness for the snapshot and the underlying Vehicle/Trip timestamps. Non-fresh context cannot enter model execution. An optional latest-version provider makes `NOT_LATEST` enforceable at the production factory boundary.
- Resolve the available Tool list from the Phase 4 sealed Registry on every turn. Assign only that list to `agent.state.tools`. RX names remain absent.
- Use exactly one `PiToolAdapter` for `ToolDefinition -> AgentTool` conversion and one `PiEventAdapter` for Pi lifecycle -> DriveGuard Runtime Event conversion. The Tool adapter defensively validates and clones formal input and output schemas and waits for dispatched dependency work to settle before cancellation becomes terminal. The Event adapter enforces start/end pairing and replaces provider-controlled call IDs with per-run opaque IDs. Runtime Events retain safe identity and lifecycle metadata only; they do not retain prompts, arguments, results, raw provider Tool-call IDs, credentials, or hidden reasoning.
- Default `PHASE_5_RUNTIME_MODE` to `read_only`, which exposes only non-side-effect R0 Tools. `development` requires explicit opt-in, uses only the controlled formal Registry, rejects non-loopback Simulator origins, and is labeled `NON_PRODUCTION` / `PRE_POLICY`. This is a temporary exposure guard, not a Policy Engine or confirmation workflow.
- Allow one active run per Session and return `SESSION_BUSY` for a concurrent prompt. Different Sessions use distinct Pi Agent/transcript state and may run concurrently.
- Use a closed Runtime error taxonomy and return no raw stack. Provider and explicitly configured sensitive values are redacted from caller-visible text.
- Treat Runtime Event sinks as an external failure boundary. Sink rejection is converted to a structured `INTERNAL_ERROR`; a failed terminal completion delivery cannot leave a caller-visible failed result with `RUN_SUCCEEDED` state.
- Use `DEEPSEEK_API_KEY` and optional `DEEPSEEK_MODEL` only from the process environment. Missing or unknown configuration produces `CONFIGURATION_ERROR`; no credential file is read.

## Consequences

- Phase 5 demonstrates formal Tool execution against Simulator/development providers, but side-effect execution in `development` is not production-safe because Policy, Confirmation, and Reliable Executor do not exist yet.
- Session, run activity, Context allocators, and Runtime Events are process-local. Redis, PostgreSQL, NATS business workflow, distributed coordination, durable audit, and recovery are not claimed.
- Context is refreshed before every new prompt, while the Pi conversation transcript remains in the Session. Conversation memory cannot substitute for current World State.
- Runtime Events are intentionally narrower than Pi events. Later observability consumers can depend on DriveGuard event contracts without depending on Pi internal event shapes.
- A live DeepSeek smoke remains an explicit opt-in gate. Automated tests use Pi `fauxProvider()` and remain offline.
