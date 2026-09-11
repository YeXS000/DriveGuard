# ADR 0022: SHA-bound operational release procedure

## Status

Accepted for Phase 17 staging validation.

## Context

DriveGuard already has deterministic migration, Compose health checks, persistent PostgreSQL/Redis/JetStream volumes, and bounded Prometheus metrics. A release candidate still needs an operator-verifiable procedure for deployment, versioned recreate, rollback, backup/restore, alerting, and dependency recovery. The release must not depend on `latest`, expose credentials, or change the safety decision path.

## Decision

The three application images are `driveguard-api`, `driveguard-simulator`, and `driveguard-hmi`, all tagged by a full 40-character Git SHA. The release manifest records the candidate's content identity; a registry RepoDigest is preferred and a local Docker image ID is explicitly labelled as local rather than claimed as a registry digest.

`scripts/staging-operations.mjs` operates only a project name beginning with `driveguard-phase17`; destruction of its named volumes requires an explicit acknowledgement. Upgrade and rollback preserve and verify a pending confirmation plus a completed execution receipt. The rollback trigger is an intentionally absent image run with `--no-build`, followed by restoration of the known-good SHA.

Prometheus loads bounded-cardinality operational alert rules. The three safety alerts consume an explicit hard-failure counter with a fixed `event` vocabulary and do not carry request, session, or trace identities. The counter is observational only and changes neither Policy, confirmation, nor Executor behavior.

## Consequences

This adds operational automation and a runbook without altering Ground Truth, Scorer, RX capability restrictions, or the LLM-to-side-effect boundary. Live stage-gate evidence remains mandatory: implemented rules and scripts do not make a gate pass until a running staging topology proves deployment, alerts, recovery, upgrade/rollback, and backup/restore.
