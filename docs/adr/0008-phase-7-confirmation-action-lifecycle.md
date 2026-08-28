# ADR 0008: Phase 7 confirmation and action lifecycle

- Status: Accepted
- Date: 2026-08-28

## Context

Phase 6 deterministically blocks R2/R3 Tool requests with `REQUIRE_CONFIRMATION`, but it intentionally creates no durable intent and accepts no user confirmation. Phase 7 must bind that decision to one immutable action, accept confirmation only through a trusted non-LLM boundary, reload current Context, and produce a narrow authorization for Phase 8 without executing the Tool.

Reliable execution, retries, circuit breakers, production idempotency, databases, messaging, and HMI/HTTP confirmation APIs remain out of scope.

## Decision

### PendingAction and state machine

- `ActionIntent` binds the canonical Tool definition, schema-validated arguments, R2/R3 risk, run/session/trace/user/vehicle identity, the exact Phase 6 decision and rule, original Context identity/version, timestamps, deterministic summary, and action fingerprint.
- Fingerprints are SHA-256 over deterministic canonical JSON covering Tool name, arguments, session/user/vehicle identity, and Context snapshot/version.
- The central state machine permits the normal path `AWAITING_CONFIRMATION -> CONFIRMED -> READY_FOR_EXECUTION`, the user/TTL terminals `CANCELLED`, `EXPIRED`, and `REJECTED`, and fail-closed `CONFIRMED -> REPLAN_REQUIRED`. `READY_FOR_EXECUTION` is terminal in Phase 7.
- Repository mutation is package-internal. The public package exposes `ConfirmationService.get()` for read-only action status, not repository transition or authorization methods.

### Trusted confirmation boundary and token semantics

- Only `ConfirmationService.confirm({ actionId, confirmationToken, sessionId, userId })` can accept confirmation. Confirmation is not a formal Tool and is never exposed to Pi or the LLM.
- Production tokens use 32 cryptographically random bytes encoded as base64url. Only SHA-256 token hashes are retained in the PendingAction repository.
- Tokens are opaque, action/session/user bound, single-use, and expire after 60 seconds. Equality uses fixed-length `timingSafeEqual` comparison.
- Runtime results contain only the safe action ID, Tool, risk, expiry, and deterministic summary. Plaintext tokens cross a distinct `TrustedConfirmationChallengeChannel`; the default process-local channel supports one-time `take(actionId)` retrieval, rejects expired publication, and removes expired entries on access/publication.
- Leaving `AWAITING_CONFIRMATION` discards the corresponding trusted challenge. If trusted challenge publication fails, Runtime cancels the PendingAction and discards any partial channel entry in a `finally` boundary before failing the run, even if cancellation-event delivery also fails.

### Context revalidation and authorization

- Confirmation reloads current Context and reuses Phase 2 freshness and conflict evaluators with the Phase 6 Tool profile.
- Stale, not-latest, future, relevant-change, unknown-path, missing Tool/profile, identity-change, capability-loss, service-loss, and Context-load failures produce `REPLAN_REQUIRED` with no authorization.
- An irrelevant version change may continue. The original Context is cloned and deeply frozen at action creation.
- Successful revalidation creates one immutable, 10-second `ExecutionAuthorization` bound to action fingerprint, Tool/risk, confirmation, policy rule, and the newly loaded Context identity/version.
- Phase 7 creates and returns the authorization only. It has no code path that consumes it or invokes the R2/R3 handler.

### Events and process-local consistency

- Lifecycle transitions emit the eight required safe events. A default in-memory event sink is always installed when none is supplied.
- Tokens, authorization values, Tool arguments, secrets, prompts, and reasoning are absent from lifecycle events.
- READY state and authorization are committed before `action.ready_for_execution` is emitted, so event observers see the committed state. If delivery fails, the error is surfaced while the legitimately authorized READY action remains terminal; the state graph is not expanded to manufacture a rollback transition.
- This phase is process-local and non-durable. Durable transactional audit/outbox behavior belongs to a later persistence phase.

## Consequences

- Phase 6 remains the sole policy source. `ALLOW` preserves the existing handler path; `DENY` and `REPLAN` remain blocked; `REQUIRE_CONFIRMATION` creates exactly one PendingAction and executes zero underlying side effects.
- Concurrent operations for one action are serialized by a process-local per-action queue, so only one confirmation can authorize.
- Restart loses PendingActions, events, challenge-channel entries, and authorizations. This is an accepted Phase 7 limitation, not production persistence.
- Phase 8 may consume `READY_FOR_EXECUTION` and `ExecutionAuthorization`; Phase 7 must stop before that boundary.
- The real DeepSeek R2 smoke passed with `REQUIRE_CONFIRMATION`, one PendingAction, zero successful Tool executions, unchanged Simulator state, no model success claim, and no plaintext token on safe Runtime surfaces.
