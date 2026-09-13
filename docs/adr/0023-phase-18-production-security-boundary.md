# ADR 0023: Phase 18 production security boundary

## Status

Accepted for Phase 18 hardening; it deliberately blocks production startup.

## Context

The API's only caller identity mechanism is `x-driveguard-user-id` and
`x-driveguard-vehicle-id`. Source and the Phase 10 ADR mark those headers as a
development boundary. They are sufficient for deterministic test isolation but
are forgeable at a public gateway, so they cannot be promoted as production
authentication.

## Decision

`DRIVEGUARD_DEPLOYMENT_ENV=production` now fails before any listener or
dependency connection is opened, with an explicit trusted-authentication
blocker. Phase 18 also provides a production Compose overlay that exposes only
the HMI gateway, isolates application/data networks, removes direct service
ports, and declares least-privilege container controls.

The overlay requires a real deployment secret and an explicit provider. It
does not enable the development execution opt-in, test bootstrap, fault
injection, or a mock provider. The existing default Compose file remains the
explicit staging/development topology used by retained Phase 17 evidence.

## Consequences

This is a fail-closed security hardening, not a replacement authentication
architecture. A future, separately authorized phase must add a trusted
server-side identity provider and bind its verified identity to sessions,
vehicles, confirmations, and HMI requests before the production startup guard
may be changed. Therefore Phase 18 cannot receive a production-release PASS.
