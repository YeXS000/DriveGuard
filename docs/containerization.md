# Containerized release

DriveGuard ships three application images: `driveguard-api`, `driveguard-simulator`, and
`driveguard-hmi`. Each uses the digest-pinned
`node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284`
base, a lockfile-only `npm ci` build stage, an omit-dev runtime stage, and the built-in non-root
`node` account. Compose infrastructure images are pinned by immutable SHA256 digest. No Dockerfile
receives a secret, and `.dockerignore` excludes `.env`, key material, tests, stage artifacts, Git
metadata, and local output.

The default Compose topology is PostgreSQL, Redis, NATS JetStream, the deterministic migration job, simulator, API, and HMI. Persistent named volumes are explicit for PostgreSQL, Redis, and JetStream. Prometheus and Grafana are intentionally excluded from the minimum release topology and require `--profile observability`.

`/health/live` answers process liveness only. `/health/ready` actively checks PostgreSQL, Redis, and the NATS JetStream account; it returns HTTP 503 until every dependency is usable. Compose does not treat simple start order as readiness: API waits for the migration job and healthy infrastructure, while its own healthcheck uses `/health/ready`.

The API accepts SIGTERM/SIGINT by closing admission, draining work within `DRIVEGUARD_SHUTDOWN_TIMEOUT_MS`, closing Fastify and then NATS/PostgreSQL/Redis resources. Its Compose grace period is aligned to that deadline. HMI closes its HTTP listener with an eight-second hard deadline. Pending confirmations remain only pending; they are never executed by shutdown or restart.

The production overlay publishes only HMI, requires JWT/JWKS authentication and explicit secrets,
and places API/application and stateful data services on separate internal networks. Runtime
services use read-only roots, tmpfs, `no-new-privileges`, and `cap_drop: [ALL]`. Networkless
one-shot volume initializers retain only the measured capability set needed to validate and prepare
PostgreSQL, Redis, and NATS named volumes; unexpected existing owner/mode values fail closed.
