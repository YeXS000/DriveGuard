# Containerized release

DriveGuard ships three application images: `driveguard-api`, `driveguard-vehicle-simulator`, and `driveguard-hmi`. Each uses a fixed `node:22.22.1-bookworm-slim` base, a lockfile-only `npm ci` build stage, an omit-dev runtime stage, and the built-in non-root `node` account. Compose infrastructure images are pinned by immutable SHA256 digest. No Dockerfile receives a secret, and `.dockerignore` excludes `.env`, key material, tests, stage artifacts, Git metadata, and local output.

The default Compose topology is PostgreSQL, Redis, NATS JetStream, the deterministic migration job, simulator, API, and HMI. Persistent named volumes are explicit for PostgreSQL, Redis, and JetStream. Prometheus and Grafana are intentionally excluded from the minimum release topology and require `--profile observability`.

`/health/live` answers process liveness only. `/health/ready` actively checks PostgreSQL, Redis, and the NATS JetStream account; it returns HTTP 503 until every dependency is usable. Compose does not treat simple start order as readiness: API waits for the migration job and healthy infrastructure, while its own healthcheck uses `/health/ready`.

The API accepts SIGTERM/SIGINT by closing admission, draining work within `DRIVEGUARD_SHUTDOWN_TIMEOUT_MS`, closing Fastify and then NATS/PostgreSQL/Redis resources. Its Compose grace period is aligned to that deadline. HMI closes its HTTP listener with an eight-second hard deadline. Pending confirmations remain only pending; they are never executed by shutdown or restart.
