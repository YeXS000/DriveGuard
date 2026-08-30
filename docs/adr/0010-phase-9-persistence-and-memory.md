# ADR 0010: Phase 9 persistence and memory boundaries

- Status: Accepted
- Date: 2026-08-30
- Scope: Phase 9 only

## Context

Phase 5–8 runtime, lifecycle, authorization, executor, idempotency, and audit state was
process-local. A restart could therefore lose a conversation, pending confirmation,
authorization consumption, execution outcome, or deduplication ownership. Phase 9 must make those
states recoverable without treating conversation history as current vehicle or trip state.

## Decision

### PostgreSQL is the safety source of truth

PostgreSQL 17 and Drizzle ORM store `agent_sessions`, `conversation_messages`, `pending_actions`,
`execution_authorizations`, `execution_records`, `execution_attempts`, `idempotency_records`, and
`audit_events`. The schema uses the Phase 5–8 domain objects as typed JSON payloads where structured
business data must be preserved; it does not define a second business model.

The migration is forward, repeatable, and tracked by Drizzle. A reverse-order operator rollback is
provided separately. Stable IDs, primary/unique constraints, foreign keys, timestamps, state checks,
and lookup/expiry indexes are enforced by PostgreSQL. Execution rows have a foreign-keyed session
and a database check binding the structured request to the row identity; an R1 request is therefore
not an orphan merely because it has no confirmation-only PendingAction ID. Audit rows are protected
by triggers rejecting `UPDATE`, `DELETE`, and `TRUNCATE`. The migration owner provisions a distinct
least-privilege runtime role whose audit grants are limited to `SELECT` and `INSERT`. Provisioning
rejects a current-user, table-owner, superuser, database/role creator, replication, or bypass-RLS
role. It also rejects existing role memberships and ownership of the public schema or append-only
trigger function, forces `NOINHERIT`, revokes stale grants, and retains `DELETE` only on
`execution_records` for conflict cleanup in the same uncommitted acquisition transaction. The
request-binding check uses null-safe equality for every required request identity field and exact
null/value parity for `actionId`, so missing JSON fields cannot pass through PostgreSQL's `CHECK`
unknown-value semantics.

### Redis is availability-only coordination and cache

Redis stores only a 30-minute TTL-bound conversation cache, session leases, and short-lived idempotency
coordination under the `driveguard:` namespace. Owner-checked Lua release prevents one caller from
releasing another caller's lease. Redis never becomes the sole copy of a PendingAction,
ExecutionAuthorization, ExecutionRecord, idempotency outcome, or AuditEvent.

Redis errors may reduce performance. They do not weaken authorization single-use, durable
idempotency, duplicate protection, or audit correctness. Session coordination falls back to a
PostgreSQL conditional lease. Conversation reads and writes continue through PostgreSQL when the
cache is unavailable. Redis operations are time-budgeted so a hanging availability hint cannot
outlive the authoritative PostgreSQL path.

### Repository boundary and dependency injection

Business code depends on `SessionRepository`, `ConversationRepository`, `PendingActionRepository`,
`AuthorizationRepository`, `ExecutionRepository`, `IdempotencyRepository`, and `AuditRepository`.
PostgreSQL implementations live in `packages/persistence`; cache/coordinator implementations live
in `packages/memory`; in-memory implementations remain available for deterministic unit tests.

The existing `ConfirmationService`, `ReliableToolExecutor`, and production Agent Runtime accept
repositories, durable execution coordination, conversation memory, and session coordination by
dependency injection. SQL and Redis commands remain outside the domain, policy, and Tool layers.
The Phase 9 production binding validates all five durable adapters at runtime. Conversation restore
requires the complete session/user/vehicle identity object and binds it durably before reading any
message; a custom adapter cannot legally restore a transcript from a raw session ID.

### Transaction boundaries

- PendingAction creation commits the session row, action row, Policy audit, and creation audit
  together.
- PendingAction transitions use a database transaction, row lock, legal state transition, and
  conditional state update.
- Confirmation acceptance clears the stored token hash and records the trusted confirmation in the
  same transaction.
- Authorization creation and the `CONFIRMED -> READY_FOR_EXECUTION` transition are atomic.
- Authorization consumption is a conditional `consumed_at is null` update under the action
  transaction. Exactly one concurrent caller may succeed. The request user and vehicle must match
  the stored action before consumption.
- Execution creation and idempotency ownership acquisition commit together before Tool side effects.
- Execution finalization commits the final record, attempts, durable idempotency result, and final
  audit together.

PostgreSQL unavailability before durable ownership is acquired fails closed and the owner callback
is not invoked.

Expiry and lease comparisons use PostgreSQL server time inside the authoritative transaction rather
than trusting an application host clock. Conversation appends and execution finalization are fenced
by the current PostgreSQL session owner.

### Durable idempotency and crash recovery

An idempotency row binds key, action fingerprint, full request binding, and execution ID. The same
key and same binding reuses the stored outcome. A changed fingerprint or binding returns
`IDEMPOTENCY_CONFLICT`. An owner lease represents an execution that may still be in flight.

After a process loss, an incomplete execution is never blindly retried. A duplicate receives
`OUTCOME_UNKNOWN`; after lease expiry the unknown terminal result is persisted and audited. This is
an at-most-once safety choice. It may require operator or downstream reconciliation in a later
phase, but Phase 9 does not add that workflow.

If finalization throws after PostgreSQL has already committed but before the client receives the
COMMIT acknowledgement, the coordinator re-reads the result bound to the same execution ID and
returns that durable terminal result. If no result exists or reconciliation is unavailable, the
original finalization failure remains authoritative.

A `READY_FOR_EXECUTION` action can be resumed after a crash between confirmation commit and executor
acquisition. The stable `confirmed:<actionId>` idempotency key makes a repeated recovery return the
same durable outcome. Once the executor commits `SUCCEEDED`, a later session heartbeat or release
failure cannot replace that success with a retryable runtime failure.

### Conversation memory is not world state

Only `sessionId`, `role`, `content`, `createdAt`, and `sequence` are conversation memory. Runtime
restart restores that transcript into a new AgentSession. Every new turn still invokes the existing
ContextLoader and obtains current VehicleState and TripState from ContextProvider/Simulator before
capability resolution, Policy, or Tool execution. Redis contains no vehicle or trip snapshot fields.
The session row additionally binds the transcript to one user ID and vehicle ID; a mismatch fails
before transcript restoration reaches the model.

R0/R1 action fingerprints are recomputed by the executor from tool, arguments, session, user,
vehicle, and Context. For R2/R3, the fingerprint preserves the confirmed action's original Context,
while `ExecutionAuthorization` separately binds the successful confirmation-time Context
revalidation. The single-use authorization consumer validates both the stored fingerprint and the
request user/vehicle, so the two Context roles are not conflated.

### Audit model

Repositories append safe events for Policy decision, PendingAction creation, confirmation
accept/reject, Context revalidation, authorization issue/consume, execution start/retry/final result,
and idempotency deduplication. Every audit row requires validated user and vehicle subjects.
Metadata rejects access/refresh tokens, credentials, cookies, authorization, API keys, secrets,
passwords, headers, reasoning, and chain-of-thought fields before persistence. Conversation content
applies the corresponding credential/cookie/token/authorization/reasoning sanitizer before the
PostgreSQL append as well as before cache population.

### Phase boundary

This decision adds persistence and memory only. It does not add Phase 10 HMI/API work, NATS business
orchestration, complete observability, urgent-event handling, or direct vehicle control. RX
capabilities remain absent from the model Tool registry.

## Consequences

- Durable state operations depend on PostgreSQL health and intentionally fail closed when it is
  unavailable.
- Redis can be lost or flushed without losing safety-authoritative records.
- Append-only audit protection makes corrections additive rather than mutating history.
- Expired ambiguous executions remain `OUTCOME_UNKNOWN`; automatic recovery side effects are out of
  scope.
- Data retention, archival, outbox delivery, multi-region failover, and operator reconciliation are
  future decisions, not Phase 9 claims.

## API verification

The implementation pins `drizzle-orm` 0.45.2, `pg` 8.23.0, and `redis` 6.2.1 in the single npm
lockfile. It follows the installed Drizzle node-postgres/migrator declarations and the Redis Node
client `connect`, `SET NX PX`, and `EVAL` contracts. No architectural adjustment from
`DriveGuard.md` was required, so no compatibility exception is recorded.
