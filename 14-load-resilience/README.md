# Phase 14 — Load, Resilience & Production Readiness

This directory contains the Phase 14 test harness, fault topology, executable tests, and measured
reports. It does not duplicate application source. Production changes remain in the existing
`apps/`, `packages/`, and `services/` modules.

## Safety boundary

Load handling does not weaken Policy, Confirmation, capability registration, idempotency, or
reconciliation. RX capabilities remain unavailable to the LLM. Capacity exhaustion fails with a
bounded queue and controlled `503 SERVICE_BUSY` response.

## Commands

```bash
npm run build
npm run test:phase14
node 14-load-resilience/scripts/local-capacity.mjs
PATH=/path/to/k6:$PATH PHASE14_PROFILE=load npm run load:phase14
docker compose -f docker-compose.yml -f 14-load-resilience/compose.toxiproxy.yml up -d
node 14-load-resilience/scripts/toxiproxy-fault.mjs latency simulator
```

High concurrency uses the deterministic/faux provider. A live provider is capped at five VUs by
the matrix runner. Secrets are read only from the normal environment and are never included in
reports.

The current gate conclusion and explicit unverified items are in
[`docs/final-report.md`](docs/final-report.md).
