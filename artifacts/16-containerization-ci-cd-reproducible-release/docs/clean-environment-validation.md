# Clean-environment validation

A distinct Compose project, `driveguard_phase16_clean`, was verified absent before the run. It created a new network and new PostgreSQL, Redis, and NATS named volumes; host ports 31600--31602, 35432, and 36379 prevented contact with existing DriveGuard containers.

The release images were first built with `docker compose build --no-cache`, then the exact source-SHA tags were built. `docker compose up -d --pull never` created the fresh topology and ran the migration job successfully. A second migration invocation succeeded. API restart re-ran the idempotent JetStream initialization and the release smoke restored persistent state.

Readiness was 200 before the fault, 503 after Redis was stopped, and 200 after Redis restarted. API SIGTERM stopped with exit code 0 inside the 10-second requested bound and restarted to readiness 200.
