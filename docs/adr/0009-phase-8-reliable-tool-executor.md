# ADR 0009: Phase 8 reliable Tool execution model

- Status: Accepted
- Date: 2026-08-29

## Context

Phase 7 creates a short-lived `ExecutionAuthorization` and leaves the action in the terminal
`READY_FOR_EXECUTION` state, but deliberately cannot consume the authorization or invoke the Tool.
The Phase 5/6 formal Runtime also still invokes an allowed Tool handler directly after Policy.
Phase 8 must make one process-local Executor the only formal side-effect entry, while preserving the
accepted Policy, confirmation, action-state, Tool Contract, and Simulator boundaries.

PostgreSQL, Redis, NATS workflow, distributed locking, durable audit, HMI, production telemetry,
urgent-event handling, and load testing remain outside this phase.

## Decision

### One execution entry and independent lifecycle

- `@driveguard/executor` exposes `ReliableToolExecutor.execute(ExecutionRequest)` as the single
  formal execution entry.
- The request binds execution, run, session, trace, Tool, validated arguments, action fingerprint,
  risk, exact Policy decision, idempotency key, and caller creation time. R2/R3 additionally bind action,
  authorization, and revalidated Context identity/version.
- The Executor independently verifies the canonical sealed Registry definition, formal/RX name,
  risk, input Schema, Policy binding, and request shape. It never accepts an LLM Tool call directly.
- Executor state is independent from Phase 7 and is fixed as `CREATED -> RUNNING -> SUCCEEDED |
FAILED | RETRY_EXHAUSTED | OUTCOME_UNKNOWN`, with `CREATED -> REJECTED` for pre-dispatch failures.
  Illegal transitions fail closed and leave state unchanged.

### Authorization consumption

- R0/R1 require an exact matching `ALLOW` decision.
- A PolicyEngine-issued R0/R1 permit is process-locally bound to the canonical Registry definition,
  actual validated arguments, run/session/trace, action fingerprint, and Context snapshot/version. It
  is atomically consumed once; exact idempotent replay returns the cached result before re-consumption.
- R2/R3 require an exact matching `REQUIRE_CONFIRMATION` decision plus a trusted lookup through
  `ConfirmationService.consumeExecutionAuthorization`.
- The trusted service verifies READY state, existence, expiry, prior consumption, action,
  authorization ID, Tool, session, and revalidated Context binding. It recomputes the action
  fingerprint from the trusted PendingAction user/vehicle/original Context identity plus the actual
  arguments supplied to the Executor, so a caller cannot reuse an authorization with altered input.
- Per-action repository serialization makes marking an authorization consumed process-local atomic.
  Concurrent consumers produce exactly one success. `READY_FOR_EXECUTION` remains unchanged; Phase 8
  records consumption separately instead of changing Phase 7 state semantics.
- A consumed authorization is not restored when later event delivery, dependency, or execution fails.
  This is fail closed and can sacrifice availability; durable transactional recovery belongs to a
  later persistence phase.

### Idempotency and concurrency

- `IdempotencyManager` keys entries by `idempotencyKey + actionFingerprint` and an Executor-generated
  digest of Tool, actual arguments, run/session/trace, risk, Policy evidence, authorization/action,
  and Context bindings. Only a complete trusted-binding match single-flights and returns a safe
  deduplicated terminal result. A changed fingerprint or any changed trusted binding returns
  `IDEMPOTENCY_CONFLICT` before authorization consumption or Tool dispatch. The same execution ID is
  safe for exact sequential/concurrent transport replay; a new key may not reuse an existing ID.
- Authorization, idempotency, and breaker coordination use independent key-scoped Maps. Different
  keys do not share a global execution lock.
- Entries and records are process-local and currently retained for the process lifetime. Restart
  loses them, and this phase does not claim distributed or durable exactly-once behavior.
- `DriveGuard.md` describes a later same-vehicle side-effect queue. The explicit Phase 8 request does
  not carry `vehicleId` in `ExecutionRequest` and limits serialization to authorization,
  idempotency, and breaker keys, so Phase 8 does not invent a vehicle-global queue. Cross-key
  same-vehicle durable ordering remains a future architecture concern and is not claimed here.

### Downstream idempotency and ambiguous outcomes

- The optional Tool execution context carries `AbortSignal`, attempt number, and the stable
  idempotency key without exposing them to the LLM.
- The Simulator client forwards `Idempotency-Key`. The charging-reservation endpoint implements a
  process-local single-flight/result cache and rejects key/fingerprint conflicts. Simulator reset
  clears this test state.
- `reserve_charging_slot` is now `IDEMPOTENT` because its Simulator downstream contract enforces the
  key. An applied reservation followed by a response timeout may therefore be retried with the same
  key and still creates one reservation.
- Every other side-effect Tool is `NON_IDEMPOTENT` in Phase 8 because its downstream endpoint has no
  equivalent result-reuse contract; superficially repeatable state setters are not treated as proof.
- Side-effect Tools without a proven retry-safe contract are never blindly retried after timeout or
  ambiguous dependency settlement. They terminate `OUTCOME_UNKNOWN`.

### Retry, timeout, and circuit breaker

- Errors are classified as `RETRYABLE`, `NON_RETRYABLE`, or `AMBIGUOUS_SIDE_EFFECT`.
- Retryable dependency timeout/unavailability uses at most three attempts with centralized 50 ms and
  100 ms bounded backoff. Tests inject the Sleeper; no reliability test waits in real time.
- Validation, authorization, Policy, resource/business conflict, idempotency conflict, and malformed
  dependency response paths do not retry.
- Every attempt is bounded by the Tool's accepted `timeoutHintMs`. `AbortTimeoutController` aborts
  the operation, ignores late settlement, and returns a structured timeout.
- `CircuitBreaker` is process-local per sorted dependency group (falling back to Tool name), with
  threshold 5, cooldown 20 seconds, and one HALF_OPEN probe. Its states are CLOSED, OPEN, and
  HALF_OPEN. Clocks are injected. Breaker bookkeeping settles before fallible audit delivery, and a
  definitive non-retryable HALF_OPEN response closes/releases the probe rather than stranding it.

### Runtime and safe results/events

- Formal R0/R1 `ALLOW` uses the Executor through the Runtime Policy guard's `allowedExecution`
  callback. The accepted Phase 1 fixture Runtime remains unchanged.
- Trusted `ProductionDriveGuardRuntime.confirmAndExecute` performs Phase 7 confirmation/revalidation
  and then sends the resulting R2/R3 authorization to the same Executor.
- The Runtime never uses the handler callback as an alternate formal ALLOW path; the Executor invokes
  the canonical Registry definition.
- `ExecutionResult` exposes only execution identity, Tool, terminal status, attempt count,
  deduplication, timestamps, safe result, and a closed safe error. Retry and breaker internals are not
  returned to the LLM.
- Execution lifecycle timestamps come from the injected Executor Clock; caller `createdAt` is
  validated as request metadata but cannot forge audit ordering.
- Execution events contain only execution/run/session/trace/Tool/attempt/time plus safe code or delay
  metadata. Arguments, confirmation tokens, authorization secrets, credentials, prompts, stacks, and
  reasoning are excluded.

## Consequences

- Formal Runtime Policy or confirmation bypass is zero in the measured Phase 8 paths, and RX remains
  blocked by Registry and Executor defenses.
- Exactly-once and breaker state are process-local only. Process restart, multi-process coordination,
  durable recovery, retention/eviction, and transactional audit/outbox behavior remain unimplemented.
- The Simulator's `Idempotency-Key` behavior is deterministic test infrastructure, not a claim about
  production external providers.
- Phase 8 adds no PostgreSQL, Redis, NATS business workflow, HMI, production telemetry pipeline,
  urgent-event automation, benchmark/load framework, or Phase 9 schema.
