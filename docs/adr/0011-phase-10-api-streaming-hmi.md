# ADR 0011: Phase 10 API, streaming, and HMI boundaries

- Status: Accepted
- Date: 2026-08-31
- Scope: Phase 10 only

## Context

Phases 5–9 provide the production Agent Runtime, deterministic Policy gate, trusted confirmation
lifecycle, Reliable Executor, and durable PostgreSQL/Redis repositories. Phase 10 needs an
application-facing HTTP and streaming boundary without reimplementing that business logic or
exposing internal Runtime events, persistence adapters, or the Vehicle Simulator to the HMI.

## Decision

### API and application-service boundary

`apps/api` is the application boundary. Fastify routes perform TypeBox validation and delegate to
`DriveGuardApiService`. The service composes only the existing production Runtime,
`ConfirmationService`, and durable repositories. Routes contain no database calls, action-state
mutation, Simulator calls, Policy replacement, or direct Tool execution.

All `/v1` calls require schema-validated `x-driveguard-user-id` and
`x-driveguard-vehicle-id` headers and return the `DEVELOPMENT_IDENTITY_BOUNDARY` response marker.
Session, PendingAction, and Execution lookups compare the complete user/vehicle binding; action
commands additionally compare the session. A mismatch is hidden as not found. This boundary is
explicitly non-OAuth and must be replaced by deployment authentication in a later phase.

Success responses use `{ "data": ... }`; errors use a stable `{ "error": { "code", "message" } }`
envelope. Validation coercion and unknown-property removal are disabled, so malformed external
input is rejected rather than normalized silently. Production error responses contain no stack,
SQL, filesystem path, provider detail, or secret.

### Curated SSE contract

`POST /v1/sessions/:sessionId/messages/stream` returns only the public events `run.started`,
`assistant.delta`, `tool.requested`, `policy.decision`, `confirmation.required`, `tool.completed`,
`assistant.completed`, and `run.failed`. Internal Context, capability, model, reasoning, and raw
Runtime event objects are not forwarded.

Assistant text deltas use a separate sanitized Runtime callback rather than expanding the accepted
internal `RuntimeEvent` union. This preserves the Phase 5 event contract while permitting Phase 10
streaming. Client disconnect removes the listener, cancels the still-cancellable session request,
and suppresses further socket writes. Durable state committed before disconnect remains governed by
the existing Runtime, lifecycle, and Executor transaction boundaries.

### Confirmation and execution

The application receives a one-time plaintext confirmation challenge only on the trusted API/HMI
response path. PendingAction persistence continues to store only the token hash. Before publishing
the challenge, the application service matches action ID, session, user, vehicle, and challenge
session/user. Confirm, reject, and cancel always invoke the existing Runtime and
`ConfirmationService`; no route or HMI code mutates action state.

Confirmation follows Context revalidation, single-use `ExecutionAuthorization`, and the Reliable
Executor. A durable `READY_FOR_EXECUTION` action may resume after an API restart even when its
original confirmation display window has elapsed; the existing authorization expiry and durable
idempotency checks remain authoritative. An action still in `AWAITING_CONFIRMATION` is rejected when
its confirmation window expires.

### Persistence and HMI

Sessions, conversation, PendingActions, authorizations, executions, and audit data use the Phase 9
production bindings. `GET /v1/executions/:executionId` reads request identity, record, attempts, and
result in one PostgreSQL statement so its subject and status view are consistent. World state is
not persisted by the API and is reloaded by the Runtime on every turn.

The minimal HMI creates/restores sessions, consumes SSE, displays Tool and Policy progress, renders
the deterministic action summary, important parameters, risk, and expiry, supports Confirm/Reject,
and distinguishes waiting, executing, success, failure, replan-required, and expired states. It
calls only the API. A small Node 22 static server proxies `/api` inside Compose; this avoids adding a
second package manager or an unavailable web-server image and contains no business logic.

### Runtime and deployment configuration

The standalone API defaults to the installed DeepSeek provider and requires `DEEPSEEK_API_KEY` from
the environment. Compose explicitly selects the Pi faux provider for deterministic non-production
acceptance and never reads a key file. Development side effects still require the existing explicit
opt-in. An exact additional Simulator origin may be supplied for the private Compose network only;
the existing loopback-only default remains unchanged.

PostgreSQL, Redis, NATS, Vehicle Simulator, API, migration, and HMI are Compose services. NATS remains
health-checked infrastructure only and has no Phase 10 business subjects, publisher, or consumer.

### Phase boundary

This decision implements Phase 10 HTTP, SSE, confirmation/action/session/execution APIs, and the
minimal HMI only. It does not add Phase 11 observability, Phase 12 urgent-event handling, NATS
business orchestration, OAuth, formal load testing, benchmark infrastructure, or vehicle actuator
control. RX capabilities remain absent from the LLM Tool Registry and API surface.

## Consequences

- Development identity headers are suitable only for the explicit non-production boundary.
- SSE is unidirectional and best effort; durable action/execution state is recovered through the
  normal GET APIs after reconnect.
- Confirmation credentials exist briefly in the application response and HMI memory but are not
  logged or returned by action-read APIs.
- Compose acceptance uses a deterministic faux provider; live DeepSeek behavior remains opt-in and
  is not needed for the Phase 10 gate.
- Formal authentication, observability, urgent-event processing, load tests, and production HMI
  hardening remain later-phase work.
