# DriveGuard v1.0.0

Project = **COMPLETE**. Production Release Readiness = **READY** under the measured DriveGuard
project gate. This source release does not claim commercial traffic, real-vehicle deployment, or
production-vehicle certification.

## Highlights

- A professional responsive cockpit HMI backed by the real JWT/auth, API, SSE, session, vehicle
  context, protected-action confirmation, execution-receipt, health, and reconnect flows.
- Safety-aware LLM orchestration with deterministic Policy, confirmation, and reliable execution.
- Complete Native Development/Holdout quality gates with hard safety metrics at 100% and all hard
  counters at zero.
- Bounded load/backpressure, stable 30-minute soak, fault recovery, durable restart,
  backup/restore, upgrade/rollback, alerts, and operational runbooks.
- Hardened production Compose topology with JWT/JWKS authentication, vehicle authorization,
  internal networks, and least-privilege storage initialization.
- Immutable three-image candidate identity, SPDX SBOMs, Gitleaks closure, and CVE classification.

## HMI

The desktop-first interface combines the assistant conversation with live vehicle, trip,
charging, and dependency state. R2 actions use a dedicated confirmation card rather than ordinary
chat text and visibly distinguish pending, confirmed, executing, completed, and failed states.
Bounded progress labels expose understanding, vehicle checks, execution, completion, and required
replanning without exposing model chain-of-thought. The HMI never adds a demonstration-only success
path.

## Architecture and safety guarantees

The model may plan and request only registered service capabilities. It cannot directly control
steering, throttle, braking, AEB, ESC, or other RX actuators. Side effects always traverse Tool
validation, deterministic Policy, identity-bound confirmation when required, and the Reliable
Executor. Durable idempotency, reconciliation, state refresh, receipts, and audit prevent retries or
model text from becoming an unauthorized or falsely successful action.

Final measured hard metrics: Critical Policy Recall 100%, Safety Enforcement 100%, authentication
bypass 0, confirmation bypass 0, forbidden action executed 0, duplicate side effect 0, false
success 0, cross-user execution 0, and cross-vehicle execution 0.

## Quality metrics

- Native Development: 420/420 evaluated, Case Pass 90.00%.
- Native Holdout: 180/180 evaluated, Case Pass 92.22%.
- Required Tool Recall, Tool Precision, selection, argument validity, Policy, and Critical Policy:
  100% on both sets.
- Confirmation Lifecycle: 94.59% Development, 100% Holdout.
- Official external CAR-bench: raw Pass@1 41.60%, valid-only Pass@1 66.67%; 47 upstream
  infrastructure failures remain in the raw result.

## Performance qualification

- Backend P95: 3.28 ms in the Phase 14.1 production topology baseline.
- Sustainable point: 20 VU, 11,653 iterations, 96.53 requests/s, Agent P95 517.60 ms.
- Controlled saturation: 50 VU, 3,975 controlled 503s, HTTP 500 and leaked external busy both 0.
- Final 30-minute soak: 140,297/140,297 accepted at 77.936/s, HTTP 500/mismatch/restart/fatal heap
  all 0; latency ratio 0.983 and throughput ratio 1.019.

These capacity figures use a deterministic faux provider and the tested single-host topology; they
are not external-provider or public-production throughput claims.

## Reliability and operations

Nine of nine production-topology fault cases recovered. Pending confirmation and execution receipt
survived restart; ambiguous writes reconciled without duplicate side effects. Clean deployment,
migration, same-SHA upgrade, known-good rollback, PostgreSQL/Redis/JetStream backup and restore,
dependency recovery, and alert firing/recovery passed their retained evidence.

## Security

Production verifies signed JWTs through JWKS, derives the user from `sub`, validates claim-backed
vehicle scope, and rejects development identity headers. Only HMI is host-published. Runtime
services are non-root with read-only roots, `no-new-privileges`, and all capabilities dropped.

The final controlled-source Gitleaks scan found 0; 26 reachable-history matches were all triaged as
historical report text with 0 unresolved. Final images have 0 Critical, 0 fixable Critical/High,
0 reachable/unclassified High, 0 image secrets, and 0 Critical/High misconfigurations. Each image
still has 43 raw no-fixed-version High rows classified `NOT_REACHABLE`; this release does not claim
zero vulnerabilities.

## Known limitations

Live planning depends on an external LLM and its quotas. Validation uses a simulator rather than
real vehicle hardware. Forty-five external-service integration tests may be skipped when their
PostgreSQL/Redis environment is absent. Image exceptions and deployment assumptions require
periodic review. See [docs/known-limitations.md](docs/known-limitations.md).
