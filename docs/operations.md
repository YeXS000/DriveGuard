# DriveGuard operational runbook

This runbook operates a production-like staging Compose project. It never uses `latest`, never prints credentials, and does not provide a path for an LLM to control vehicle actuators. Run all commands from the repository root with Docker Engine available.

## Preconditions

Use a full Git SHA and an isolated project name. Copy `.env.example` to a local ignored `.env`, replace the required values outside shell history, and keep it out of reports and source control.

```bash
export DRIVEGUARD_STAGING_PROJECT=driveguard-phase17
export DRIVEGUARD_RELEASE_SHA="$(git rev-parse HEAD)"
git status --short
docker version
docker compose version
npm run compose:config
```

The commands refuse a project name not beginning with `driveguard-phase17`. A clean deployment additionally requires an explicit acknowledgement because it removes only that project's named volumes.

On a Windows-hosted WSL checkout without the Docker Desktop WSL CLI integration, set `DRIVEGUARD_DOCKER_COMMAND=docker.exe` and set the _Windows-host_ `DRIVEGUARD_IMAGE_TAG` to the same full release SHA before invoking WSL; production Linux uses the default `docker`.

## Deploy

```bash
npm run staging:operations -- build
DRIVEGUARD_ALLOW_CLEAN_RESET=1 npm run staging:operations -- fresh-deploy
npm run staging:operations -- smoke
```

`build` writes `artifacts/17-staging-release-operational-readiness/reports/final/release-candidate-manifest.json`. It records the Git SHA, tag, build timestamp, Node/npm/Docker versions, and image content identity. A registry digest is preferred; an unpushed candidate records its Docker image ID and is not promoted as a registry digest. `fresh-deploy` creates fresh Compose networking and PostgreSQL, Redis, NATS, Prometheus, and Grafana volumes, runs migration, waits for health checks, and verifies API/HMI/simulator readiness.

`build` uses an already verified fixed base image by default, which permits an isolated staging environment without registry access. Set `DRIVEGUARD_PULL_BASE_IMAGES=1` only when registry access is healthy and a fresh base-image pull is required.

## Check health, logs, and metrics

```bash
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" ps
curl --fail-with-body http://127.0.0.1:3000/health/ready
curl --fail-with-body http://127.0.0.1:3001/health/ready
curl --fail-with-body http://127.0.0.1:9090/-/ready
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" logs --tail=200 api
curl --fail 'http://127.0.0.1:9090/api/v1/alerts?active=true'
```

Readiness must list PostgreSQL, Redis, and NATS as `up`; a running container alone is not sufficient. Request, session, and trace identities remain in redacted logs/traces, never Prometheus labels.

## Upgrade

For an actual N-to-N+1 change, build both exact tags before use. If no prior release exists, use the same stable SHA for both variables; the command still forces a versioned recreate, re-runs deterministic bootstrap, and proves durable state without claiming a feature change.

```bash
export DRIVEGUARD_RELEASE_N_SHA="$(git rev-parse HEAD)"
export DRIVEGUARD_RELEASE_N_PLUS_1_SHA="$(git rev-parse HEAD)"
npm run staging:operations -- upgrade
```

The probe creates one pending R2 confirmation and one completed execution before recreating the release. After readiness it verifies the durable session, pending confirmation, and execution receipt. The simulator is intentionally non-persistent: it must restart with zero reservations, proving that a completed side effect was not automatically replayed. The probe records IDs only, never confirmation credentials.

## Rollback

The drill intentionally attempts an unavailable image with `--no-build`; that is the controlled rollback trigger and never represents a functional release change. It restores the known-good SHA and repeats durable-state verification.

```bash
export DRIVEGUARD_KNOWN_GOOD_SHA="$(git rev-parse HEAD)"
npm run staging:operations -- rollback
```

Rollback succeeds only when the missing image fails, the known-good image becomes ready, and the pending confirmation plus receipt remain readable with no duplicate simulator effect.

## Backup and restore

Backups are sensitive operational material. Keep them in a protected directory outside Git and verify selected Compose volume labels before restoring.

```bash
export BACKUP_DIR="$(pwd)/artifacts/17-staging-release-operational-readiness/reports/backup-restore/manual"
mkdir -p "$BACKUP_DIR"
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" exec -T postgres pg_dump -U "${POSTGRES_USER:-driveguard}" "${POSTGRES_DB:-driveguard}" > "$BACKUP_DIR/postgres.sql"
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" exec -T redis redis-cli --rdb /tmp/driveguard-phase17-redis.rdb
REDIS_CONTAINER="$(docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" ps -q redis)"
docker cp "$REDIS_CONTAINER:/tmp/driveguard-phase17-redis.rdb" "$BACKUP_DIR/redis.rdb"
NATS_VOLUME="$(docker volume ls -q --filter "label=com.docker.compose.project=$DRIVEGUARD_STAGING_PROJECT" --filter "label=com.docker.compose.volume=nats-data")"
test -n "$NATS_VOLUME"
docker run --rm --entrypoint tar -v "$NATS_VOLUME:/data:ro" -v "$BACKUP_DIR:/backup" nats:2.11-alpine czf /backup/nats-jetstream.tar.gz -C /data .
sha256sum "$BACKUP_DIR/postgres.sql" "$BACKUP_DIR/redis.rdb" "$BACKUP_DIR/nats-jetstream.tar.gz" > "$BACKUP_DIR/SHA256SUMS"
```

Restore only into an empty, separately named staging project after checking target volume labels. This is destructive to that target's persistent state; preserve its backup first.

```bash
export RESTORE_PROJECT=driveguard-phase17-restore
export RESTORE_DIR="$BACKUP_DIR"
docker compose --project-name "$RESTORE_PROJECT" up -d --wait --wait-timeout 90 postgres redis nats persistence-migrate
# persistence-migrate creates the application role needed by the SQL dump ACLs.
# This is an empty, separately named restore target: remove bootstrap schema only, never a live schema.
docker compose --project-name "$RESTORE_PROJECT" exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-driveguard}" -d "${POSTGRES_DB:-driveguard}" -c 'DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA public;'
docker compose --project-name "$RESTORE_PROJECT" exec -T postgres psql -U "${POSTGRES_USER:-driveguard}" -d "${POSTGRES_DB:-driveguard}" < "$RESTORE_DIR/postgres.sql"
RESTORE_REDIS="$(docker compose --project-name "$RESTORE_PROJECT" ps -q redis)"
docker compose --project-name "$RESTORE_PROJECT" stop redis
docker cp "$RESTORE_DIR/redis.rdb" "$RESTORE_REDIS:/data/dump.rdb"
docker compose --project-name "$RESTORE_PROJECT" start redis
RESTORE_NATS_VOLUME="$(docker volume ls -q --filter "label=com.docker.compose.project=$RESTORE_PROJECT" --filter "label=com.docker.compose.volume=nats-data")"
test -n "$RESTORE_NATS_VOLUME"
docker compose --project-name "$RESTORE_PROJECT" down
docker run --rm --entrypoint sh -v "$RESTORE_NATS_VOLUME:/data" -v "$RESTORE_DIR:/backup:ro" nats:2.11-alpine -c 'rm -rf /data/* && tar xzf /backup/nats-jetstream.tar.gz -C /data'
docker compose --project-name "$RESTORE_PROJECT" up -d --wait --wait-timeout 90 --no-build
```

After restoring, run durable-state verification against the restored project and inspect migration and NATS logs. PostgreSQL, Redis AOF/RDB state, and JetStream data are backed up because this topology uses all three durably; no transient HTTP cache is backed up.

## Restart

```bash
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" restart api
npm run staging:operations -- readiness
npm run staging:operations -- smoke
```

## Dependency outage

Use only staging. API readiness must return 503 while Redis or PostgreSQL is unavailable; the service must not false-success a protected action.

```bash
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" stop redis
curl --fail-with-body http://127.0.0.1:3000/health/ready || true
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" start redis
npm run staging:operations -- readiness
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" restart nats
npm run staging:operations -- readiness
```

## SERVICE_BUSY or queue saturation

Do not defeat bounded admission by raising limits during an incident. Capture `driveguard_admission_active`, `driveguard_admission_queued`, `driveguard_admission_rejected_total`, and `driveguard_executor_queued`; reduce incoming traffic or wait for the finite queue to drain. Alert thresholds assume the reviewed 32 request and 256 Executor queue limits: 26 queued requests (about 80%) or 205 queued Executor operations (about 80%). Change alerts in the same review as any capacity change.

## API unhealthy

Check migration, dependencies, API logs, and the last alert before recreating API. Do not remove volumes as an API recovery step.

```bash
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" ps persistence-migrate api postgres redis nats
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" logs --tail=300 persistence-migrate api
docker compose --project-name "$DRIVEGUARD_STAGING_PROJECT" up -d --no-build --force-recreate api
npm run staging:operations -- readiness
```

## Failed migration

Stop promotion, retain failed migration logs, and roll back application images only after checking migration compatibility. Never overwrite a live project. Restore into the separate project procedure above, verify the backup, and require a reviewed migration-specific recovery plan before destructive repair.

## Safety hard failure

`ConfirmationBypass`, `ForbiddenActionExecuted`, or `DuplicateSideEffect` is a critical incident even if a request appears successful. Freeze promotion, preserve logs/traces and relevant durable records, prevent additional affected requests, and investigate through the Policy -> confirmation -> Executor audit path. Do not manually retry a potentially ambiguous side effect.
