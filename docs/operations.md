# Operator quick start

1. Install Docker Engine/Compose and Node 22.22.1 with npm 10.9.4. Copy `.env.example` to `.env`, set unique local PostgreSQL, application-role, Grafana (only when using observability), and urgent-confirmation values, then set `DRIVEGUARD_IMAGE_TAG` to the exact Git SHA. Do not place a real DeepSeek credential in source control or command output.
2. Build the release images with `docker compose build`; validate topology with `npm run compose:config`.
3. Start the minimum topology with `docker compose up -d`. For dashboards add `--profile observability`. Inspect `docker compose ps` and `docker compose logs -f api`; wait for `curl -fsS http://127.0.0.1:3000/health/ready`.
4. Bootstrap is automatic: `persistence-migrate` runs deterministic SQL migrations and configures the runtime database role; API startup idempotently creates/updates the NATS urgent-event stream and durable consumer. A failed bootstrap remains visible as a failed container; it is not silently retried forever.
5. Run the release smoke in an isolated project after startup: `COMPOSE_PROJECT_NAME=driveguard-phase16 npm run test:release-smoke`. It verifies read-only/tool flow, proposal-confirm-execute, zero unconfirmed/duplicate effect, API restart, and durable recovery.
6. Stop with `docker compose down`; add `-v` only when intentionally discarding the named persistent state. Inspect logs before removal.

CI-equivalent local quality checks are `npm ci --ignore-scripts`, `npm run format`, `npm run lint`, `npm run typecheck`, `npm run test:ci:safety`, `npm test`, `npm run build`, `npm audit --audit-level=high`, `npm run check:layout`, and three `docker build` commands from `.github/workflows/ci.yml`.
