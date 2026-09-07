# Phase 14.1 production topology validation

## Scope and environment

Validation ran on the dedicated `phase/14.1-production-topology-validation` worktree at commit
`008f73d` plus the uncommitted Phase 14.1 fixes recorded by this report. The originally supplied
directory was a different, dirty Phase 14 worktree, so it was not modified.

- Docker Desktop 4.0.0; Docker client/engine 28.1.1; Compose 2.35.1
- Node.js 22.22.1; k6 2.2.0
- Linux x64, 8 logical CPUs, 16,483,852,288 bytes memory
- deterministic faux provider for load, stress, fault, and soak
- Compose project `driveguard141`, isolated from other local DriveGuard projects

The isolated host endpoints were API 3400, Simulator 3401, HMI 3402, Grafana 3403,
Prometheus 19091, PostgreSQL 55434, Redis 56381, Toxiproxy API 18474, and separate proxy ports.
No application secret was copied into source, reports, logs, fixtures, or command arguments.

## Topology and smoke result

The nine-service topology consisted of PostgreSQL, Redis, NATS JetStream, Toxiproxy, Vehicle
Simulator, API/Agent Runtime, HMI, Prometheus, and Grafana. Migrations completed and all services
became healthy.

The final post-restart smoke ran at `2026-09-07T02:42:47.905Z` and passed all ten checks:

| Check                               | Result             |
| ----------------------------------- | ------------------ |
| API live / ready                    | PASS / PASS        |
| PostgreSQL / Redis / NATS readiness | PASS / PASS / PASS |
| Simulator                           | PASS               |
| Toxiproxy routes enabled            | PASS               |
| Session durable read                | PASS               |
| Agent/Executor to Simulator         | PASS               |
| Metrics endpoint                    | PASS               |

The readiness response reported PostgreSQL, Redis, and NATS JetStream `up`. The post-smoke
resource snapshot reported PostgreSQL waiting 0, Redis ready 1, NATS pending/ack-pending 0/0, and
Executor queued 0. Raw evidence is in `reports/topology/smoke.json`.

## Production defects exposed and corrected

Only defects reproduced by the live topology were changed:

1. The k6 VU and setup isolates generated different run identifiers, producing false
   `SESSION_NOT_FOUND` results. Setup now returns each VU's bound session identity.
2. The load vehicle identity now matches the production Simulator identity, and the multi-tool
   prompt requests both vehicle and trip state explicitly.
3. Parallel Tools in one leased run acquired `FOR SHARE` on the same `agent_sessions` row and then
   deadlocked on write promotion. The durable acquisition now serializes with `FOR UPDATE`. The
   corrected production multi-tool probe completed 160/160 requests.
4. PostgreSQL disconnects emitted unhandled Pool and checked-out Client error events and could
   terminate the API. Both sources now have error guards, and session-read dependency failures map
   to controlled HTTP 503 rather than generic HTTP 500.
5. Load/fault contract accounting now distinguishes safe stale-context replans and fault-only
   `SESSION_BUSY` degradation without accepting those outcomes in the normal load gate.

Each production fix has a focused source/behavior test. No Policy, confirmation, Ground Truth,
Scorer, capability boundary, or safety requirement was weakened.

## Final production checks

- Post-fix baseline: all five profiles exited 0.
- Ascending load: 1, 5, and 10 VU exited 0; 20 VU exited 99 at the first unsafe saturation point.
- Fault under load: one final same-run nine-case matrix, all cases exited 0 and recovered.
- Soak: one uninterrupted 30-minute k6 execution, exit 0.
- Restart: two API restarts with durable pending action, execution receipt, deduplication, NATS
  consumer, and cross-identity checks.
- Final smoke after all restarts: 10/10 checks passed.

The topology gate itself is **PASS**. Load, backpressure, and soak findings prevent the aggregate
Phase 14.1 gate from passing.
