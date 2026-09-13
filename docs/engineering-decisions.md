# Engineering decisions

## Why the LLM is not the safety authority

Model output is probabilistic, provider-dependent, and may be incomplete or malformed. DriveGuard
therefore limits the model to interpretation and capability requests. RX actuators are absent from
the Tool registry, and every permitted side effect must cross typed validation, deterministic
Policy, confirmation state, executor authorization, persistence, and audit. This keeps model text
from becoming direct control-plane authority.

## Why Policy is deterministic

Risk classification and authorization must be repeatable, reviewable, and testable across retries
and model variations. The Policy Engine consumes validated capability/context facts and emits a
typed decision. Critical-path precheck can repair only a uniquely resolved missing capability; it
does not weaken Ground Truth or let the model decide Policy.

## Why confirmation is a state machine

A prompt-level “are you sure?” cannot reliably bind identity, action, arguments, context version,
or time. The action lifecycle persists a frozen fingerprint and allowed transitions. Confirmation
must match user, vehicle, session, action, and current state, and it resumes the exact saved action.
Stale, duplicate, mismatched, or replayed confirmations are rejected or return the original receipt.

## Why idempotency and reconciliation are both required

Retries can occur after timeouts, disconnects, process restart, or an ambiguous response. An
idempotency key plus canonical fingerprint prevents two different requests from sharing ownership
and deduplicates exact replay. For an ambiguous write, DriveGuard reads authoritative state before
deciding whether execution occurred; it never blindly repeats a side effect. Durable records make
this behavior survive API restart.

## Bounded concurrency and backpressure

Unbounded work caused unsafe response modes and heap pressure in earlier phases. The final design
bounds active/queued API admission, read/write executor capacity, per-session runtime retention,
model context, event/trace identifiers, Redis behavior, PostgreSQL pools, and NATS backlog. Writes
to the same vehicle serialize. Capacity exhaustion becomes controlled `503 SERVICE_BUSY` with
`Retry-After`, while duplicate/conflict checks occur before capacity waiting.

## Context race resolution

Earlier performance runs observed `CONTEXT_INVALID` and incomplete mismatch evidence. The runtime
now loads an atomic simulator snapshot, preserves structured context failures, performs only
bounded stale-context replanning, and captures immutable per-mismatch evidence. Phase 15.3 then ran
the direct A–E race matrix, a prospective semantic set, and a synthetic negative harness without
reconstructing the three irrecoverable historical payloads.

## Sustainable performance qualification

DriveGuard separates backend, Agent, provider, Tool, Policy, and Executor timing. Ascending load
identifies the last passing point and the first controlled saturation point; a 30-minute run checks
latency/throughput ratios, heap slope, crashes, queues, connections, handles, and semantic results.
Failed rounds remain archived. The final 20-VU/96.53 req/s point uses a deterministic provider and
is not described as external-provider or public-production throughput.

## Production authentication

Development `x-driveguard-*` headers were explicitly rejected as forgeable. Production fails closed
unless JWT mode, issuer, audience, JWKS URL, allowed algorithms, and vehicle claim are configured.
The API verifies signature and claims, derives user identity from `sub`, authorizes the selected
vehicle from trusted scope, and preserves downstream session/action/execution bindings. Unknown
`kid` triggers one bounded JWKS refresh for rotation.

## Least-privilege containers and storage

Application and data services run non-root with read-only roots, tmpfs, no-new-privileges, and all
capabilities dropped. Named-volume ownership cannot be prepared by those restricted runtimes, so
networkless one-shot initializers perform only idempotent owner/mode checks with measured minimum
capabilities. Unexpected existing volumes fail closed; the design does not use privileged mode,
host networking, `cap_add: ALL`, or recursive permissive repair.

## Release security gate

The gate combines controlled-source and reachable-history Gitleaks, raw image vulnerability data,
image-secret and misconfiguration scans, CVE-level reachability/fixability classification, SPDX
SBOMs, immutable image identity, authenticated production/restart/audit smoke, critical safety, and
full regression. A raw no-fixed-version High row remains disclosed even when classified
`NOT_REACHABLE`; “0 vulnerabilities” is not an allowed summary.

## Evidence and worktree integrity

Each phase uses a registered sibling worktree. Raw reports stay on the phase branch under
`artifacts/`; only accepted source/config/docs/tests enter `main`. FAIL checkpoints and `NOT RUN`
rows are retained. A clean tree or green subset never substitutes for the explicit gate criteria.
