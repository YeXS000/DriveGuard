# DriveGuard portfolio summary

## Project background

DriveGuard is a TypeScript Agent Runtime for orchestrating driving-related service capabilities
under explicit safety and reliability controls. The project addresses the gap between an LLM's
probabilistic planning and the deterministic authority required for identity, Policy, confirmation,
side effects, recovery, persistence, and audit.

## Core architecture

The HMI/API verifies the caller, validates inputs, and applies bounded admission. The Agent Runtime
may select only registered non-RX capabilities. Typed Tool contracts and deterministic Policy
decide what is allowed; R2 actions require an identity-bound confirmation/action state machine.
The Reliable Executor then applies idempotency, per-vehicle serialization, timeout/retry rules, and
reconciliation before the simulator/external capability is invoked. PostgreSQL, Redis, and NATS
JetStream provide durable business state, bounded memory, and urgent-event delivery. Prometheus,
Grafana, structured logs, traces, and audit records close the operational loop.

## Technology stack

TypeScript strict mode, Node.js 22, npm workspaces, Pi Agent Core/Pi AI, Fastify, Vitest,
PostgreSQL, Redis, NATS JetStream, Docker Compose, GitHub Actions, Prometheus, and Grafana.

## Engineering highlights

1. **Deterministic safety boundary:** kept steering/throttle/braking/AEB/ESC and all RX capabilities
   outside the LLM Tool registry; enforced Policy, confirmation, authorization consumption, and
   receipt-consistent responses.
2. **Reliable side effects:** implemented durable idempotency, same-vehicle serialization,
   bounded retries, circuit breaking, ambiguous-write reconciliation, restart recovery, and
   duplicate-effect prevention.
3. **Measured resilience and capacity:** added bounded admission/backpressure, per-vehicle runtime
   isolation, resource diagnostics, load/fault/soak harnesses, operational drills, and alerts.
4. **Production security and release evidence:** delivered JWT/JWKS identity, claim-backed vehicle
   authorization, internal networks, non-root/read-only/capability-free runtimes, least-privilege
   volume initialization, immutable image/SBOM identity, Gitleaks, Trivy, and CVE classification.

## Verified metrics

- Native Case Pass: 90.00% Development and 92.22% Holdout.
- Tool recall, precision, selection, argument validity, Policy, Critical Policy, and Safety
  Enforcement: 100% on both final Native sets.
- Hard safety/security counters: authentication bypass, confirmation bypass, forbidden action,
  duplicate side effect, false success, cross-user execution, and cross-vehicle execution all 0.
- Sustainable deterministic-provider point: 20 VU at 96.53 requests/s; controlled saturation at
  50 VU with 3,975 controlled 503 and 0 HTTP 500.
- Final 30-minute soak: 140,297/140,297 accepted at 77.936/s with zero mismatch/restart/fatal heap;
  latency ratio 0.983, throughput ratio 1.019.
- Final regression: 2,314/2,314 executed tests and 472/472 critical safety tests; 45 external
  PostgreSQL/Redis tests disclosed as environment-gated skips.
- Security: controlled-source leaks 0; reachable-history findings 26/26 triaged, unresolved 0;
  Critical/fixable/reachable/unclassified High 0; raw no-fix High retained at 43 rows/image.

## Implementation ownership summary

The project work covers domain/context modeling, capability and Tool boundaries, Agent Runtime,
deterministic Policy, confirmation/action lifecycle, Reliable Executor, persistence/memory,
simulator integration, API/HMI, observability, urgent events, Native and external evaluation,
load/resilience tooling, Docker/Compose, CI/CD, staging operations, production authentication,
least-privilege storage, security evidence, and final release documentation.

This summary makes no claim about commercial revenue, DAU, public production traffic, real-car
deployment scale, or functional-safety certification.
