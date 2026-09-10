# ADR 0003: Phase 2 domain and context semantics

- Status: Accepted
- Date: 2026-08-25

## Context

Phase 2 establishes runtime-validated driving state and immutable context snapshots without adding a simulator, Policy Engine, executor, or Agent capability. The implementation needs one explicit meaning for timestamps, versions, inactive navigation, immutability, freshness, and conflict facts.

## Decision

- Domain schemas use TypeBox as the runtime source of truth and derive TypeScript types with `Static`. ID schemas add small nominal brands so `VehicleId`, `ContextSnapshotId`, `RouteId`, and other identifiers cannot be mixed implicitly.
- Timestamps are canonical UTC ISO-8601 strings with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Clocks provide epoch milliseconds and are injected into deterministic tests. Vehicle and trip timestamps cannot be later than snapshot `capturedAt`.
- State and context versions are positive safe integers. Omitting the initial version from `ContextVersionAllocator` uses one process-wide monotonic sequence. Supplying an initial value creates an isolated deterministic allocator for replay and tests; this is not a distributed version generator.
- Snapshot IDs are `<prefix>:<positive sequence>`. Allocators using the same prefix and no explicit initial sequence share process state. Different prefixes remain distinct by construction. Explicit initial sequences are limited to deterministic replay and tests.
- `ContextSnapshotBuilder` clones validated source data, deeply freezes the result, and rejects a vehicle ID change within one builder sequence. Invalid source data cannot become a snapshot.
- When `navigationActive=false`, `destination` and `routeId` must both be `null`; DriveGuard does not retain an inactive previous route in the formal Phase 2 state.
- Freshness uses `ageMs = nowMs - capturedAt`. `ageMs <= maxAgeMs` is `FRESH`; greater age is `STALE`; a future `capturedAt` is `INVALID_FUTURE_TIMESTAMP`. `requiresLatest=true` additionally requires a valid latest version and reports `NOT_LATEST` when it differs.
- Conflict detection reports facts only. It separately reports snapshot/context/vehicle/trip version changes, compares only caller-declared validated relevant paths, returns deterministic sorted `changedPaths`, and reports unknown paths. It never emits `ALLOW`, `DENY`, or `REPLAN`.
- `@driveguard/shared`, `@driveguard/domain`, and `@driveguard/context` expose source types for TypeScript and built JavaScript for Node runtime imports. Context imports only these public package APIs.
- Numeric maximums such as 500 km/h demo speed, 5,000 km estimated range, and -60 to 60 degrees Celsius outside temperature are defensive DriveGuard demo engineering bounds. They are not represented as automotive industry standards.

## Consequences

- Snapshot/version uniqueness is process-local and resets on process restart. Distributed allocation belongs to later persistence architecture.
- Phase 2 supplies no risk policy and makes no execution decision. Later modules may consume freshness and conflict facts but must not reinterpret them as implicit authorization.
- The explicit inactive-navigation null semantics avoid ambiguous optional fields but do not preserve route history.
- Package build artifacts must be regenerated before direct Node package imports; the Phase 2 package-export smoke performs this build first.
