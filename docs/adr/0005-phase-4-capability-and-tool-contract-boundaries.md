# ADR 0005: Phase 4 capability and Tool Contract boundaries

- Status: Accepted
- Date: 2026-08-27

## Context

Phase 4 introduces the formal DriveGuard capability space, 14 Tool Contracts, dynamic exposure, and adapter-backed execution without connecting those tools to the Pi Agent Runtime. The long-term architecture in `DriveGuard.md` includes roles, preconditions, policy decisions, confirmation, retry, idempotency enforcement, and reliable execution. The authorized Phase 4 scope is narrower: risk, timeout, and idempotency are descriptive metadata only, while authorization and execution lifecycle behavior belong to later phases.

Phase 2 already defines a closed `VehicleCapabilities` object with the six required capability flags. Phase 3 already supplies the data-plane HTTP endpoints for vehicle/trip reads, cabin and media mutations, navigation, charging, and roadside assistance. It does not supply weather or emergency-support endpoints. Its generic `/navigation/reroute` endpoint also cannot identify a charging station, while the formal Phase 4 Tool is specifically `reroute_to_charger`.

## Decision

- Reuse the Phase 2 `VehicleCapabilities` schema unchanged. `@driveguard/capabilities` adds a closed service-availability context for `vehicleSimulator`, `weather`, and `emergencySupport`; it does not add policy results or vehicle-state authorization conditions.
- Define the 14 formal Tool names exactly once. The only accepted risks are `R0`, `R1`, `R2`, and `R3`. The RX names `apply_brake`, `control_steering`, `set_throttle`, `disable_aeb`, and `disable_esc` are rejected at registration and never appear in the formal definitions.
- Define each Tool from TypeBox input and output schemas and derive handler types from those schemas. Every input is validated before a handler runs, every output is validated before return, and closed objects reject extra properties where appropriate.
- Tool metadata contains label, description, schemas, risk, required capabilities, required services, side-effect flag, timeout hint, idempotency hint, and audit level. These hints do not authorize, retry, deduplicate, or confirm execution.
- Keep the capability-to-Tool mapping explicit and auditable. `reroute_to_charger` requires both navigation and charging. A Tool is dynamically exposed only when all declared capabilities and objective service dependencies are available.
- Build formal registries through a factory that registers all definitions and seals the registry. Registration rejects duplicates, RX names, invalid risk/availability metadata, invalid schemas, and invalid handlers. Registry lists and snapshots are deterministic and immutable. Snapshots contain only safe metadata, never schemas, clients, providers, or execute handlers.
- Centralize all Simulator HTTP transport in `SimulatorClient`. It owns the credential-free base URL, JSON transport, abort-based request timeout, response validation, and safe mapping to Tool-level errors. It implements no retry, circuit breaker, Agent idempotency, confirmation, or action lifecycle.
- Implement `reroute_to_charger` by listing Simulator charging stations, selecting the requested station explicitly, and using the existing navigation-destination endpoint. This preserves the formal Tool semantics without changing the Phase 3 Simulator API.
- Provide deterministic `DevelopmentWeatherProvider` and `DevelopmentEmergencySupportProvider` implementations. Their outputs carry the literal `DEVELOPMENT_PROVIDER`; they do not represent live external services.
- Leave the Phase 1 `PHASE_1_FIXTURE_ONLY` runtime and its two tools unchanged. Loading the formal registry into Pi remains Phase 5 work.

## Consequences

- Capability resolution is reproducible and contains no hidden policy or risk authorization behavior.
- `CAPABILITY_UNAVAILABLE` means an unavailable declared capability/service or an unregistered name; it is not `POLICY_DENIED`.
- Direct calls to a formal Tool in Phase 4 validate and reach an adapter/provider, but they are test and library behavior only. No production Agent can access this registry yet.
- Timeout and idempotency metadata can guide later policy/executor phases, but Phase 4 provides no retry, exactly-once guarantee, or confirmation enforcement.
- The development providers and process-local emergency request sequence are deterministic test substitutes and must be replaced or explicitly configured by a later integration phase before any production claim.
