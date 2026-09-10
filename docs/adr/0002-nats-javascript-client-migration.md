# ADR 0002: Use the maintained NATS JavaScript v3 packages

- Status: Accepted
- Date: 2026-08-25

## Context

Phase 0 Infrastructure Closure adds a readiness probe for the architecture-mandated NATS JetStream dependency. The legacy `nats@2.29.3` package was initially selected from its last published version, but npm reported during installation that the package is deprecated and has moved to the official `nats-io/nats.js` v3 monorepo.

Official documentation and registry metadata were rechecked before implementation. The maintained Node transport is `@nats-io/transport-node@3.4.0`, which re-exports the Core NATS API and requires Node.js `>=18`. JetStream APIs are now supplied separately by `@nats-io/jetstream@3.4.0`. The Node transport still exposes `connect()`, and the returned connection exposes `flush()` for a server round trip. JetStream capability is verified through `jetstreamManager(connection).getAccountInfo()`.

Official references:

- <https://github.com/nats-io/nats.js>
- <https://github.com/nats-io/nats.js/blob/main/migration.md>
- <https://www.npmjs.com/package/@nats-io/transport-node>

## Decision

- Do not retain the deprecated `nats` package.
- Use `@nats-io/transport-node@3.4.0` for the Node.js connection.
- Use `@nats-io/jetstream@3.4.0` only to verify that the configured NATS server has a usable JetStream account.
- Keep this usage limited to Phase 0 readiness. No subjects, streams, consumers, persistence contracts, or business events are created.

## Consequences

- The readiness endpoint verifies both Core NATS connectivity and JetStream availability.
- Later NATS upgrades or business integration require separate phase approval and current official-document verification.
