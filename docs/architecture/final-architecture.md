# Final architecture

## Safety authority and request path

DriveGuard separates language-model planning from deterministic authority. The production request
path is:

```text
User / HMI
  -> Bearer JWT
  -> JWKS signature and claim verification
  -> claim-backed vehicle authorization
  -> API route validation and bounded admission
  -> identity-bound Agent Runtime
  -> capability filtering, Tool routing, and schema validation
  -> deterministic Policy decision
  -> confirmation/action state machine when required
  -> Reliable Executor
  -> simulator or external capability
  -> authoritative state refresh and durable execution receipt
  -> receipt-consistent final response
```

The LLM may interpret a request, select from registered capabilities, and provide arguments. It
never receives steering, throttle, braking, AEB, ESC, or other RX actuator capabilities. A model
request cannot bypass Tool schemas, Policy, confirmation state, executor authorization,
idempotency, persistence, or audit.

## Runtime components

- **HMI:** serves the browser client and proxies API traffic. In production it forwards a Bearer
  token and does not invent user identity headers.
- **Authentication and authorization:** verifies explicitly allowed RS256/ES256 JWTs against JWKS;
  validates issuer, audience, time bounds, subject, and configured vehicle scope. Verified `sub`
  becomes `userId`; the selected vehicle must be in token scope.
- **API and admission:** validates route input and identity bindings, limits active/queued work,
  returns bounded `SERVICE_BUSY` responses, exposes liveness/readiness, and drains on shutdown.
- **Agent Runtime:** loads bounded conversation/context state, invokes the configured Pi model,
  filters candidate Tools, and collects bounded, secret-safe lifecycle observations.
- **Tool and Policy boundary:** typed schemas validate external arguments. The deterministic Policy
  Engine assigns the allowed decision; critical capability prechecks may repair only an already
  resolved one-to-one omission before Policy evaluation.
- **Confirmation/action lifecycle:** records a frozen action fingerprint and identity-bound state.
  Confirmation resumes that exact action; stale or mismatched state fails closed.
- **Reliable Executor:** enforces authorization consumption, idempotency, per-vehicle write
  serialization, timeouts, retry classes, circuit breaking, and ambiguous-write reconciliation.
- **Simulator/external capability:** the validated execution boundary. Simulator state is keyed by
  vehicle and is test infrastructure, not real vehicle hardware.
- **State refresh and response:** authoritative state and execution receipts determine the final
  response; failed or unknown outcomes cannot be presented as success.

## State, messaging, and operational control

- **PostgreSQL** is authoritative for sessions, action lifecycle, executions, idempotency,
  authorization, urgent events, and append-only audit correlations. Durable state survives API
  restart.
- **Redis** stores bounded conversation memory with offline command queuing disabled.
- **NATS JetStream** provides durable urgent-event delivery and explicit consumer recovery.
- **Recovery** classifies read/write failures, retries only permitted reads, reconciles ambiguous
  writes against authoritative state, and otherwise returns safe degradation.
- **Idempotency** combines process-local single-flight protection with durable ownership,
  fingerprint conflict detection, and receipt replay. It prevents duplicate side effects across
  retries and restart.
- **Observability** provides bounded-cardinality metrics, structured secret-safe logging,
  dependency-aware readiness, tracing, dashboards, and 12 operational/safety alert rules.
- **Audit** binds user, vehicle, session, action, trace, Policy, confirmation, and execution
  lifecycle without storing JWTs or credentials.

## Production topology

The production Compose overlay publishes only the HMI edge port. API, simulator, PostgreSQL,
Redis, NATS, Prometheus, and Grafana use internal application/data networks. Application services
run as non-root with read-only root filesystems, tmpfs scratch space, `no-new-privileges`, and
`cap_drop: [ALL]`.

PostgreSQL, Redis, and NATS remain non-root with all capabilities dropped. Separate networkless,
one-shot initializers prepare only their named volumes and retain the measured minimum capability
sets. Unexpected existing ownership/modes fail instead of being recursively repaired.

The three application images use the digest-pinned
`node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284`
base, multi-stage lockfile builds, pruned runtime dependencies, and the `node` account. Images are
identified by full source SHA and local image digest. The formal Trivy/SBOM qualification remains
bound to the Phase 18.3 candidate source `e7f8e196…`; the later `v1.0.0` source was rebuilt by
exact-SHA hosted CI, but that workflow does not claim a new Trivy/SBOM qualification.

## Delivery and release workflow

GitHub Actions checks installation, format, lint, typecheck, build, critical safety, full
regression, npm audit, repository layout, Gitleaks, SHA-tagged image builds, and Compose config.
Stage branches retain raw evidence under `artifacts/`; accepted reusable source/config/docs are
integrated to `main` without stage artifacts. Deployment, upgrade, rollback, backup/restore,
failure drills, alert firing/recovery, image scanning, SBOM, and production smoke remain explicit
release evidence rather than inferred CI outcomes.

Relevant decisions are ADR 0006 through 0013 for the runtime safety chain, ADR 0018/0019/0021 for
capacity and context retention, ADR 0022 for operations, and ADR 0023–0025 for production security,
JWT/JWKS, and least-privilege storage.

The published `v1.0.0` identity is source SHA `87dfe346…`, annotated tag object `d7a8a5df…`, and
hosted CI run 34764056549. Registry publication, multi-host orchestration, hardware-in-the-loop,
and real-vehicle certification remain outside this release.
