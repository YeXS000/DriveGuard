# DriveGuard implementation status

## Phase 0 — Engineering Bootstrap

- Status: COMPLETE
- Scope: Repository and toolchain initialization only. No DriveGuard business behavior was implemented.
- Gate result: PASS

### Original environment inspection

| Component      | Observed value                                  | Bootstrap assessment                    |
| -------------- | ----------------------------------------------- | --------------------------------------- |
| WSL            | Ubuntu 24.04, WSL2 kernel 6.6.87.1              | Available                               |
| Git            | 2.43.0; existing `master` baseline at `c616d58` | Available                               |
| Node.js        | 22.22.1                                         | Meets Pi minimum `>=22.19.0`            |
| npm            | 10.9.4                                          | Selected package manager                |
| Corepack       | 0.34.6                                          | Available; not required by npm workflow |
| pnpm / Yarn    | Not installed                                   | Not used                                |
| Docker         | Not available during the original bootstrap     | Deferred to Infrastructure Closure      |
| Docker Compose | Not available during the original bootstrap     | Deferred to Infrastructure Closure      |

### Implemented scope

- npm workspaces for `apps`, `packages`, and `services`.
- TypeScript strict-mode build and typecheck configuration.
- ESLint, Prettier, Vitest, and unit-test scripts.
- DriveGuard directory skeleton from `DriveGuard.md`.
- Secret ignore rules and a fake-value `.env.example`.
- Pi package selection ADR based on current official metadata.

### Original bootstrap measurements

| Metric                            | Result                      |
| --------------------------------- | --------------------------- |
| Install                           | PASS                        |
| Build errors                      | 0                           |
| ESLint errors / warnings          | 0 / 0                       |
| Typecheck errors                  | 0                           |
| Unit tests                        | 1 / 1 passed                |
| npm audit vulnerabilities         | 0                           |
| Secret ignore checks              | 10 / 10 ignored as expected |
| Business capabilities implemented | 0                           |

### Gate conclusion

The Engineering Bootstrap gate is PASS. Docker runtime verification was explicitly not claimed by this gate.

## Phase 0 — Infrastructure Closure

- Status: COMPLETE
- Scope: Minimal non-business API bootstrap, Phase 0 infrastructure, health semantics, container runtime verification, and baseline CI only.
- Gate result: FULL PASS
- Verification date: 2026-08-25 (Asia/Shanghai)

### Environment inspection

| Component      | Observed value                       | Closure assessment |
| -------------- | ------------------------------------ | ------------------ |
| Docker CLI     | 28.1.1, build `4eba377`              | PASS               |
| Docker Engine  | 28.1.1, Docker Desktop Linux engine  | PASS               |
| Docker Compose | v2.35.1-desktop.1                    | PASS               |
| WSL runtime    | Ubuntu-24.04 on WSL2 kernel 6.6.87.1 | PASS               |
| Node.js        | 22.22.1                              | PASS               |
| npm            | 10.9.4                               | PASS               |

`docker info` completed successfully from Ubuntu-24.04. The Engine remained responsive throughout all three measured clean-start cycles.

### Implemented infrastructure

- Minimal Fastify API process with `GET /health/live` and `GET /health/ready` only.
- Readiness probes for PostgreSQL, Redis, and NATS JetStream.
- PostgreSQL 17, Redis 8, NATS 2.11 with JetStream, and the API service in Docker Compose.
- Healthchecks for all four Compose services and dependency-gated API startup.
- Multi-stage Node.js 22.22.1 API image running as the non-root `node` user.
- Baseline GitHub Actions workflow in `.github/workflows/ci.yml`.
- Maintained NATS JavaScript client selection recorded in ADR 0002.
- Docker build-context secret exclusions in `.dockerignore`.

No Agent Runtime, Vehicle Domain, simulator behavior, policy, tool registry, DeepSeek call, persistence behavior, or Phase 1+ capability was implemented.

### Service and health results

| Service    | Image / build           | Health in cycles 1 / 2 / 3  |
| ---------- | ----------------------- | --------------------------- |
| API        | `driveguard-api:phase0` | healthy / healthy / healthy |
| PostgreSQL | `postgres:17-alpine`    | healthy / healthy / healthy |
| Redis      | `redis:8-alpine`        | healthy / healthy / healthy |
| NATS       | `nats:2.11-alpine`      | healthy / healthy / healthy |

| Endpoint        | Healthy-stack result  | Dependency-failure result |
| --------------- | --------------------- | ------------------------- |
| `/health/live`  | HTTP 200, `status=ok` | HTTP 200, `status=ok`     |
| `/health/ready` | HTTP 200, all 3 up    | HTTP 503, Redis down      |

The dependency-failure review stopped Redis only. Liveness remained independent of dependencies, readiness failed closed without exposing error details, and readiness returned to HTTP 200 after Redis recovered.

### Cold-start measurements

Each measured cycle executed `docker compose down -v`, `docker compose up -d --build`, waited for all four services to become healthy, inspected `docker compose ps`, called both health endpoints, and ended with `docker compose down -v`.

| Cycle | Compose build/up | 4 / 4 healthy | Live | Ready | Final down/remove |
| ----- | ---------------- | ------------- | ---- | ----- | ----------------- |
| 1     | PASS             | PASS          | PASS | PASS  | PASS              |
| 2     | PASS             | PASS          | PASS | PASS  | PASS              |
| 3     | PASS             | PASS          | PASS | PASS  | PASS              |

Cold Start Success = 3 / 3.

After restoring Docker Desktop to its original `system` proxy mode, one additional uncounted clean-start smoke also reached 4 / 4 healthy, returned HTTP 200 from both endpoints, and completed `down -v` successfully.

### CI and local verification

The baseline CI runs the same command sequence verified locally:

- `npm ci`: PASS; 333 packages installed.
- `npm run format`: PASS.
- `npm run lint`: PASS; 0 errors and 0 warnings.
- `npm run typecheck`: PASS; 0 errors.
- `npm run build`: PASS; 0 errors.
- `npm run test:unit`: PASS; 2 files and 5 tests passed.
- `npm audit --audit-level=critical`: PASS; 0 vulnerabilities.
- `git diff --check`: PASS.
- Compose configuration validation: PASS.
- Secret ignore and tracked-file checks: PASS without reading secret files.

### Known limitations

- A GitHub-hosted Actions run was not triggered because this task does not push to a remote repository. The workflow file and its exact command sequence were validated locally.
- The current Docker Desktop installation under the host's WSL mirrored-network proxy configuration could not pull registry images through the daemon's generated `127.0.0.1:10808` proxy endpoint. Required official images were fetched with checksum-verified `crane` v0.21.9 and loaded into the local image store before the measured cycles. Compose builds, container networking, service health, and three clean starts were then executed normally. Registry pulls from an empty Docker image cache remain a host-environment limitation.
- Phase 0 readiness proves connectivity to the configured infrastructure services; it does not claim schema migrations, business persistence, message subjects/streams, or any Phase 1+ behavior.

### Gate conclusion

Phase 0 Infrastructure Closure is FULL PASS for the measured gate: Docker Engine and Compose were available in Ubuntu-24.04, every configured service had a working healthcheck, cold-start success was 3 / 3, both health endpoints were exercised, failure semantics were verified, and the local CI command sequence passed. No Phase 1 work was started.

## Phase 1 — Minimal Pi-Agent Runtime

- Status: COMPLETE
- Scope: Pi Agent Core + Pi AI Agent Loop, official DeepSeek provider selection, two deterministic read-only fixture tools, Phase 1 hook instrumentation, safe event collection, basic multi-turn state, deterministic faux integration tests, and an opt-in live smoke runner only.
- Gate result: PASS; automated verification, live DeepSeek smoke, and independent review gates all passed.
- Verification date: 2026-08-25 (Asia/Shanghai)

No Domain Model, DrivingContext, simulator, dynamic capability registry, production Policy Engine, confirmation, action state machine, executor, persistence, Redis session behavior, NATS business event, HMI, OpenTelemetry, benchmark, or RAG behavior was implemented.

### Verified runtime and provider API

| Component                         | Exact value / API                                                                                         | Result |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| WSL Node.js                       | `v22.22.1`                                                                                                | PASS   |
| npm                               | `10.9.4`                                                                                                  | PASS   |
| Pi Agent Core                     | `@earendil-works/pi-agent-core@0.84.3`                                                                    | PASS   |
| Pi AI                             | `@earendil-works/pi-ai@0.84.3`                                                                            | PASS   |
| TypeBox                           | `typebox@1.3.7`                                                                                           | PASS   |
| Provider                          | Pi `deepseekProvider()`; provider ID `deepseek`; API `openai-completions`                                 | PASS   |
| Installed DeepSeek catalog        | `deepseek-v4-flash`, `deepseek-v4-pro`                                                                    | PASS   |
| Default live model selection      | `deepseek-v4-flash` (present in the installed Pi catalog and documented by DeepSeek as Tool-Call capable) | PASS   |
| Model actually used by live smoke | `deepseek-v4-flash`                                                                                       | PASS   |
| Default automated model/provider  | Pi official `fauxProvider()` with scripted deterministic responses                                        | PASS   |

The 0.84.3 package declarations, implementation, and version-tagged official source were checked before implementation. The observed APIs remain consistent with ADR 0001, so no new ADR was required. Pi performs TypeBox argument validation before `beforeToolCall`, reports unknown tools without invoking the hook, runs `afterToolCall` after execution and before `tool_execution_end`, and supports parallel tool execution by default.

### Implemented files and modules

- `packages/agent-runtime/src/phase1-tools.ts`: exactly `get_vehicle_state` and `get_trip_state`, closed empty parameter schemas, structured details, and frozen `PHASE_1_FIXTURE_ONLY` data.
- `packages/agent-runtime/src/instrumentation.ts`: temporary Phase 1 allow-list verification plus safe before/after hook observations; explicitly not a Policy Engine.
- `packages/agent-runtime/src/event-collector.ts`: lifecycle metadata only; message content, arguments, results, headers, and credentials are not retained. Provider-controlled tool-call IDs are mapped to local opaque IDs and unknown names are normalized.
- `packages/agent-runtime/src/runtime.ts`: Models/provider/model selection, private Pi Agent construction, safe state snapshot, prompt/run result, multi-turn transcript, structured configuration errors, concurrent-run rejection, and result redaction.
- `packages/agent-runtime/src/live-smoke.ts`: explicit opt-in five-scenario DeepSeek runner that reports all attempted tool calls, actual executions, tool errors, provider-turn counts, terminal states, and observed parallel/sequential behavior.
- `tests/unit/phase1-runtime.test.ts`: provider/catalog/configuration and direct allow-list tests.
- `tests/contract/phase1-tools.test.ts`: exact registry, schema, fixture contract, determinism, and immutability tests.
- `tests/integration/phase1-agent-loop.test.ts`: Agent lifecycle, hooks, schema-invalid and unknown paths, exact start/end pairing, no-tool behavior, multi-turn, parallel tools, hook block/error paths, concurrent-run handling, metadata normalization, provider errors, and secret redaction.
- Root `package.json`, `package-lock.json`, `vitest.config.ts`, `.env.example`, and `packages/agent-runtime/package.json`: Phase 1 scripts, test discovery, workspace dependency declarations, and safe environment placeholders.

### Automated verification

All commands were executed in Ubuntu-24.04 with the repository-declared npm toolchain.

| Check                      | Measured result                                                       |
| -------------------------- | --------------------------------------------------------------------- |
| `npm ci`                   | PASS; 333 packages installed, 348 packages audited, 0 vulnerabilities |
| `npm run format`           | PASS                                                                  |
| `npm run lint`             | PASS; 0 errors, 0 warnings                                            |
| `npm run typecheck`        | PASS; 0 errors                                                        |
| `npm run build`            | PASS; 0 errors                                                        |
| `npm run test:unit`        | PASS; 3 files, 9 tests                                                |
| `npm run test:contract`    | PASS; 1 file, 4 tests                                                 |
| `npm run test:integration` | PASS; 1 file, 11 tests                                                |
| `npm test`                 | PASS; 5 files, 24 tests                                               |
| `git diff --check`         | PASS                                                                  |

Phase 1-specific coverage is 19 tests: 4 unit, 4 contract, and 11 integration. The total 24 also includes the five accepted Phase 0 tests.

### Measured Phase 1 acceptance evidence

| Metric                            | Measured result                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Agent process crash               | 0 in automated runs                                                                                       |
| Registered business tools         | exactly 2                                                                                                 |
| Unknown tool executed             | 0                                                                                                         |
| Schema-invalid tool executed      | 0                                                                                                         |
| Fixture external side effects     | 0; static frozen data only                                                                                |
| Required lifecycle event coverage | 8 / 8 = 100%                                                                                              |
| Tool execution start/end pairing  | 5 / 5 paired by opaque tool-call ID in valid, invalid, unknown, and parallel runtime cases = 100%         |
| `beforeToolCall`                  | observed on valid calls; blocked a registered out-of-scope test probe before execute                      |
| `afterToolCall`                   | observed on successful execution and with `isError=true` on a controlled failing allowed test tool        |
| Basic multi-turn state            | PASS; two prompts used one Agent/session and retained two user messages                                   |
| Concurrent prompt handling        | PASS; second call returned controlled `busy` failure with no mixed events; first returned observed `idle` |
| API key / bearer leakage          | 0 in event/result serialization tests                                                                     |
| Live DeepSeek prompts             | 6 attempted, 6 succeeded = 100%                                                                           |
| Live provider requests            | 11 observed                                                                                               |
| Live tool calls / executions      | 6 calls observed, 6 executions completed                                                                  |
| Live tool errors                  | 0                                                                                                         |
| Live scenario terminal states     | 5 / 5 scenarios returned `idle`                                                                           |

The exact reduced lifecycle sequence observed in a successful one-tool faux run was:

```text
agent_start
-> turn_start
-> message_start(user)
-> message_end(user)
-> message_start(assistant)
-> message_update*
-> message_end(assistant)
-> tool_execution_start
-> tool_execution_end
-> message_start(toolResult)
-> message_end(toolResult)
-> turn_end
-> turn_start
-> message_start(assistant)
-> message_update*
-> message_end(assistant)
-> turn_end
-> agent_end
```

For schema-invalid and unknown calls, Pi still emits paired `tool_execution_start` / `tool_execution_end` error events, but neither fixture `execute` nor `afterToolCall` runs. Valid calls invoke `beforeToolCall` after schema validation, execute the fixture, invoke `afterToolCall`, and then emit `tool_execution_end`.

### Live DeepSeek smoke

`npm run test:phase1:live` was explicitly executed in Ubuntu-24.04 with `DEEPSEEK_API_KEY` supplied through the process environment. The environment variable was unset after the run. No attempt was made to read `api_key.md`, and no credential value was printed or recorded.

The live runner produced `status: PASS` with provider `deepseek`, API `openai-completions`, and model `deepseek-v4-flash`.

| Scenario               | Prompts   | Provider requests | Tool names                            | Executions | Tool errors | Terminal   | Behavior     | Result   |
| ---------------------- | --------- | ----------------- | ------------------------------------- | ---------- | ----------- | ---------- | ------------ | -------- |
| CASE 1 vehicle battery | 1 / 1     | 2                 | `get_vehicle_state`                   | 1          | 0           | `idle`     | single       | PASS     |
| CASE 2 trip navigation | 1 / 1     | 2                 | `get_trip_state`                      | 1          | 0           | `idle`     | single       | PASS     |
| CASE 3 combined state  | 1 / 1     | 2                 | `get_vehicle_state`, `get_trip_state` | 2          | 0           | `idle`     | parallel     | PASS     |
| CASE 4 no tool         | 1 / 1     | 1                 | none                                  | 0          | 0           | `idle`     | no-tools     | PASS     |
| CASE 5 multi-turn      | 2 / 2     | 4                 | `get_vehicle_state`, `get_trip_state` | 2          | 0           | `idle`     | sequential   | PASS     |
| **Total**              | **6 / 6** | **11**            | 6 observed tool calls                 | **6**      | **0**       | 5 / 5 idle | all expected | **PASS** |

### Independent review

- Reviewer A (Pi API): Critical 0, High 0, Medium 0. Confirmed current 0.84.3 Agent, Models, DeepSeek provider, AgentTool/TypeBox, faux provider, hook, event, and parallel execution APIs. Its Low duplicate-auth observation was fixed by relying on the official provider's environment auth instead of injecting `getApiKey` manually.
- Reviewer B (loop/tests): initially Critical 0, High 3, Medium 3. The empty lifecycle assertion, hard-coded terminal state, live failed-call omission, ID pairing gap, CASE 2 semantic gap, and hook end-to-end gaps were corrected and the test suite expanded.
- Reviewer C (security/scope): Critical 0, High 0, Medium 1, Low 1. The mutable Agent/credential exposure and provider-controlled metadata concern were corrected by making the Agent private, removing manual credential injection, exposing a safe snapshot, mapping tool IDs, and normalizing unknown names.

### Known limitations and gate conclusion

- Fixtures are intentionally static and carry `PHASE_1_FIXTURE_ONLY`; they are not Phase 2 Domain or Simulator state.
- Event and hook observations are in-memory Phase 1 runtime/test instrumentation only; there is no persistence, audit system, or OpenTelemetry.
- Multi-turn state is process-local Pi Agent transcript state only; there is no production session or memory system.

Automated Phase 1 implementation, boundary, lifecycle, live DeepSeek, and independent review gates pass. The overall Phase 1 gate is **PASS**. At that verification point, Phase 2 had not been started.

## Phase 2 — Driving Domain Model

- Status: COMPLETE
- Scope: Strict TypeBox driving domain schemas, runtime validation, named invariants, immutable context snapshots, process-local version/snapshot allocation, deterministic freshness evaluation, relevant-path conflict facts, and public package APIs only.
- Gate result: PASS
- Verification date: 2026-08-25 (Asia/Shanghai)

No Vehicle Simulator, HTTP vehicle API, dynamic/production Tool Registry, Policy Engine, risk policy, confirmation, action state machine, executor, persistence, Redis/NATS business behavior, HMI, OpenTelemetry, Agent Eval, or RAG was implemented. Phase 1 Agent execution was not connected to Phase 2.

### Historical Git provenance note

Phase 0–2 were implemented and independently validated before a per-phase Git commit chain was established.

The validated repository state was subsequently captured as the formal baseline for all following phases.

Historical per-phase commit provenance is unavailable and has not been reconstructed or fabricated.

Formal Phase 0–2 baseline: `033500f8242c8a7048799c27bbfb3557b99c9b83`

### Implemented modules

- `packages/shared/src/clock.ts`: injectable `Clock`, `SystemClock`, and deterministic `FixedClock`.
- `packages/domain/src/identifiers.ts`: nominal `VehicleId`, `ContextSnapshotId`, `ContextVersion`, `StateVersion`, `RouteId`, `UserId`, and `UtcTimestamp` schemas/types.
- `packages/domain/src/schemas.ts`: `VehicleState`, `TripState`, `DrivingContext`/`ContextSnapshot`, `VehicleCapabilities`, weather/user placeholders, nested door/window/occupant state, literal enums, and documented demo bounds.
- `packages/domain/src/validation.ts`: compiled TypeBox boundary validation, canonical time checks, structured schema errors, named invariants, deep clone/freeze, and immutable vehicle identity checks.
- `packages/domain/src/errors.ts`: structured `DomainValidationError` and immutable issue records for `INVALID_FIELD`, `OUT_OF_RANGE`, `INVALID_ENUM`, `INVARIANT_VIOLATION`, `STALE_CONTEXT`, `INVALID_TIMESTAMP`, and `VERSION_CONFLICT`.
- `packages/context/src/version.ts`: positive safe-integer version allocation and prefix-scoped snapshot ID allocation; default allocators share process state, while explicit initial values provide deterministic isolated replay/test state.
- `packages/context/src/snapshot.ts`: validated cloned deep-frozen snapshot construction with injected clock and same-sequence vehicle identity enforcement.
- `packages/context/src/freshness.ts`: centralized freshness requirements/evaluation with runtime clock/version validation.
- `packages/context/src/conflict.ts`: two-layer version and relevant-path change detection with structured deterministic output.
- Package manifests, package-specific TypeScript builds, Vitest source aliases, and `tests/contract/phase2-package-exports.mjs`: runtime-usable public package exports and Node import smoke.
- ADR 0003 records timestamp, version, snapshot, inactive-navigation, freshness, conflict, and demo-bound semantics.

### Domain invariants

Vehicle invariants, each with a named invariant code and tests:

- `gear=P` requires `speedKph=0`.
- `driveMode=parked` requires `speedKph=0`.
- `chargingState=charging` requires `speedKph=0`.
- `driveMode=charging` requires `chargingState` to be `charging` or `completed` and requires `speedKph=0`.
- Occupant seats are unique.
- Vehicle identity cannot change within one `ContextSnapshotBuilder` sequence.

Trip invariants:

- Active navigation requires a non-null, non-blank destination and a valid non-null route ID.
- Inactive navigation requires both destination and route ID to be explicitly `null`.
- Remaining distance and ETA are non-negative and bounded against overflow-like inputs.

Single-field validation also covers positive safe versions; canonical non-future timestamps; finite numeric values; SOC, speed, range, cabin/outside temperature, latitude, and longitude bounds; closed object schemas; required fields; and literal enums. The configured maxima and outside-temperature range are DriveGuard demo constraints, not claimed industry standards.

### Context semantics

- Timestamp: canonical UTC ISO-8601 with milliseconds; tests inject epoch-millisecond clocks.
- Version: positive safe integer; default allocator instances share one process-wide monotonic state. Explicit initial values create deterministic isolated allocators for tests/replay. There is no distributed generator.
- Snapshot: source data is structured-cloned through the validation boundary and recursively frozen. Source mutation after creation cannot alter a snapshot.
- Freshness: `ageMs <= maxAgeMs` is `FRESH`; `ageMs > maxAgeMs` is `STALE`; future timestamps are `INVALID_FUTURE_TIMESTAMP`; an explicitly required differing latest version is `NOT_LATEST`.
- Conflict: Layer 1 reports snapshot/context/vehicle/trip version flags. Layer 2 validates caller-provided paths and reports `NO_CONFLICT`, `VERSION_CHANGED_BUT_IRRELEVANT`, `RELEVANT_STATE_CHANGED`, or `UNKNOWN_RELEVANT_PATH`, plus sorted `changedPaths` and `unknownPaths`. It makes no Policy decision.

### Tests and measured coverage

Final local automated results after review remediation:

| Check                          | Measured result                                     |
| ------------------------------ | --------------------------------------------------- |
| `npm run format`               | PASS                                                |
| `npm run lint`                 | PASS; 0 errors and 0 warnings                       |
| `npm run typecheck`            | PASS; 0 errors                                      |
| `npm run build`                | PASS; root and three public Phase 2 packages built  |
| `npm run test:unit`            | PASS; 8 files, 183 tests                            |
| `npm run test:contract`        | PASS; 2 files, 6 tests                              |
| `npm run test:integration`     | PASS; 1 file, 11 tests                              |
| `npm test`                     | PASS; 11 files, 200 tests                           |
| `npm run test:phase2`          | PASS; 6 files, 176 tests                            |
| `npm run test:phase2:packages` | PASS; all three workspace packages imported by Node |
| `git diff --check`             | PASS                                                |

Phase 2 Vitest distribution: VehicleState 59, TripState/DrivingContext 25, snapshot/version 34, freshness 29, conflict 27, and Phase 1 fixture compatibility 2. The test set includes normal, boundary, invalid runtime, invariant, overflow, immutability, and public compatibility cases. Phase 0 remains 5 tests and Phase 1 remains 19 tests.

Measured V8 coverage from `npm run test:phase2:coverage`:

| Scope              | Statements | Branches | Functions |  Lines |
| ------------------ | ---------: | -------: | --------: | -----: |
| `packages/domain`  |     98.50% |   94.23% |      100% | 99.21% |
| `packages/context` |     97.52% |   95.41% |      100% |   100% |
| `validation.ts`    |     97.97% |   95.09% |      100% | 98.93% |
| `freshness.ts`     |       100% |     100% |      100% |   100% |
| `conflict.ts`      |     93.61% |   92.30% |      100% |   100% |

All requested line targets and critical branch targets were exceeded.

### Phase 1 regression and architecture

- Registered business tools: exactly 2 (`get_vehicle_state`, `get_trip_state`).
- Unknown tool executions: 0 in the Phase 1 integration regression.
- Schema-invalid tool executions: 0 in the Phase 1 integration regression.
- `PHASE_1_FIXTURE_ONLY` remains unchanged. The only Phase 2 coupling is a contract test that maps fixture fields into complete Phase 2 inputs; the fixture is not a Domain source.
- Phase 1 runtime/tool definitions/model integration were not modified, so the paid opt-in live DeepSeek smoke was not repeated.
- Dependency scans found Domain -> Agent Runtime = 0, Domain -> Policy = 0, Domain -> Executor = 0, Context -> Policy = 0.
- Phase 3+ business implementation files added = 0.
- Context uses public `@driveguard/domain` and `@driveguard/shared` boundaries; Node package imports passed after build.

### Independent review and remediation

Initial independent read-only review counts:

- Reviewer A — Domain correctness: Critical 0, High 2, Medium 3, Low 2.
- Reviewer B — Context correctness: Critical 0, High 2, Medium 2, Low 0.
- Reviewer C — Architecture/regression: Critical 0, High 2, Medium 1, Low 1.

The implementation fixed the code, correctness, architecture, and test-validity findings: parked/charging mode contradictions; invalid freshness clocks/latest versions; blank destinations; version error classification; mutable error issues; missing nominal-ID compile evidence; process-wide default allocator behavior; runtime relevant-path validation; conflict test count; workspace public exports; unnecessary Domain -> Shared dependency; documentation; and package import smoke.

Final post-remediation read-only review counts:

- Reviewer A — Domain correctness: Critical 0, High 0, Medium 0, Low 0; PASS recommendation.
- Reviewer B — Context correctness: Critical 0, High 0, Medium 0, Low 0; PASS recommendation.
- Reviewer C — Architecture/regression: Critical 0, High 1, Medium 0, Low 0; NOT VERIFIED recommendation at review time because the formal Git baseline did not yet exist.

The Reviewer C High finding accurately described the pre-baseline repository state. It was subsequently closed by capturing the complete validated Phase 0–2 state in formal baseline commit `033500f8242c8a7048799c27bbfb3557b99c9b83`. No historical commits were reconstructed, split, rewritten, or fabricated.

### Known limitations and gate conclusion

- Context versions and snapshot ID sequences are process-local and reset on process restart; no distributed/persistent allocator exists in Phase 2.
- Explicit initial allocator values intentionally create isolated deterministic replay/test sequences and must not be used as a production distributed uniqueness mechanism.
- Weather and user are validated minimal data only; no external service or profile system exists.
- Conflict detection reports facts and cannot authorize, deny, or replan an action.
- Phase 1 live DeepSeek was not rerun because no Phase 1 runtime, tool definition, or model integration file changed.
- Historical per-phase commit provenance is unavailable; the validated Phase 0–2 state is traceable from the formal baseline recorded above.

Implementation, tests, acceptance metrics, coverage, architecture scans, package runtime imports, code-related review findings, secret tracking checks, and the post-baseline regression all pass. The validated Phase 0–2 repository state is now traceable from the formal baseline without claiming or fabricating unavailable per-phase commit history. Therefore the Phase 2 gate result is:

**PASS**

## Phase 3 — Vehicle Digital Twin / Simulator

- Status: COMPLETE
- Scope: Deterministic stateful vehicle simulator, seven built-in scenarios, data-plane and test/control-plane HTTP APIs, failure injection, container integration, and Phase 3 verification only.
- Gate result: PASS
- Verification date: 2026-08-26 (Asia/Shanghai)
- Git baseline: local `main` and Phase 3 start HEAD `4057e068d19a82fc1e0394ab2661c82b4caf5f58`; branch `phase/03-vehicle-simulator` in the dedicated Phase 3 worktree.

No Phase 4 Tool Contract, production capability registry, Policy Engine, confirmation, action state machine, Reliable Executor, persistence, HMI, Agent-to-Simulator connection, or safety-critical vehicle control was implemented. The two Phase 1 fixture tools remain unchanged and disconnected.

### Implemented modules

- `services/vehicle-simulator/src/types.ts`, `state.ts`, and `errors.ts`: simulator-only state and command contracts, complete runtime validation, cloning, and structured errors while reusing formal Phase 2 `VehicleState` and `TripState` unchanged.
- `services/vehicle-simulator/src/scenarios.ts`: `city_idle`, `highway_driving`, `low_soc`, `charging`, `active_navigation`, `parked_no_navigation`, and `network_failure_ready`.
- `services/vehicle-simulator/src/transitions.ts` and `simulator.ts`: validated atomic transitions, process-local serialization, domain-specific versions, simulator versioning, reset epochs, bounded history, and transaction-safe deterministic IDs.
- `services/vehicle-simulator/src/determinism.ts` and `faults.ts`: seeded deterministic probability and monotonic route, reservation, and assistance identifiers.
- `services/vehicle-simulator/src/http-input.ts` and `http.ts`: strict boundary parsing, structured errors, data-plane routes, and an explicit `/simulator/*` test/control plane.
- `services/vehicle-simulator/src/server.ts` and `index.ts`: production process entry and public package exports.
- `infra/docker/vehicle-simulator.Dockerfile` and `docker-compose.yml`: isolated multi-stage simulator image, loopback port 3001, and independent healthcheck.
- Phase 3 unit, contract, and integration tests plus root scripts/Vitest discovery.
- ADR 0004 records the determinism, version, stale-state, reset, failure, and control-plane decisions.

### State, transition, and determinism semantics

- Every mutation builds a complete candidate, validates the affected Phase 2 state and full simulator state, and commits once inside a process-local promise queue. Failed validation leaves state and deterministic ID counters unchanged.
- `simulationVersion` increments on every successful mutation. `vehicle.version` and `trip.version` increment only when their corresponding formal domain state changes.
- Reset reloads a validated scenario at version 1 and clears reservations, assistance requests, faults, bounded history, deterministic counters, and delayed-operation eligibility. A captured reset epoch prevents a delayed pre-reset HTTP mutation from committing after reset.
- Production uses `SystemClock`; tests/replay use `FixedClock`. Core state and transition code do not call `Date.now()` or `Math.random()` directly.
- Stable 32-bit seed hashing drives fault decisions. IDs are seed-qualified, namespace-specific, monotonic, and rolled back with a failed transition.
- At most 10 validated states are retained. A stale vehicle/trip response selects the newest retained state whose corresponding domain version is lower; unrelated simulator-only mutations are skipped.
- Concurrent mutations are serialized. Tests prove non-overlapping updates are retained and competing reservations for one remaining slot produce exactly one winner.

### HTTP and failure behavior

Data plane:

- `GET /vehicle/state`, `GET /trip/state`.
- Cabin temperature, seat heating, media volume, navigation destination/reroute, charging station/status/reservation/cancel, and roadside-assistance routes.

Test/control plane:

- `GET /simulator/state`, scenario/seed reset, fault list/set/clear, simulated speed, and simulated SOC.
- `/simulator/*` is not a production Agent tool surface and must be excluded or protected by a future production gateway.

Fault modes are `delay`, `timeout`, `http_500`, `http_503`, `connection_abort`, and `stale_response`, scoped to enumerated targets with validated probability and delay. `stale_response` is limited to vehicle/trip reads. Fastify 404, unsupported method/media type, and oversized-body errors are normalized into the structured simulator error envelope. Liveness has no dependency probes; readiness validates the registry and current simulator state only.

### Tests and measured coverage

Final local automated results after review remediation:

| Check                              | Measured result                                       |
| ---------------------------------- | ----------------------------------------------------- |
| `npm run format`                   | PASS                                                  |
| `npm run lint`                     | PASS; 0 errors and 0 warnings                         |
| `npm run typecheck`                | PASS; 0 errors                                        |
| `npm run build`                    | PASS; simulator and accepted public packages built    |
| `npm test`                         | PASS; 15 files, 397 tests                             |
| `npm run test:phase3`              | PASS; 4 files, 197 tests                              |
| `npm run test:phase3:coverage`     | PASS; 4 files, 197 tests                              |
| `npm run test:phase2:packages`     | PASS; all accepted workspace exports imported by Node |
| `npm audit --audit-level=critical` | PASS; 0 vulnerabilities                               |
| `git diff --check`                 | PASS                                                  |

Measured V8 coverage excludes only the process entrypoints `server.ts` and `index.ts`:

| Scope            | Statements | Branches | Functions |  Lines |
| ---------------- | ---------: | -------: | --------: | -----: |
| All Phase 3 core |     97.66% |   92.99% |      100% | 97.96% |
| `transitions.ts` |     97.50% |   96.66% |      100% | 97.43% |
| `faults.ts`      |       100% |   95.83% |      100% |   100% |
| `http.ts`        |     99.03% |   87.50% |      100% | 98.96% |

### Container, architecture, and security evidence

- Docker Server 28.1.1 and Compose validated the final configuration with five services.
- Two counted clean-start cycles each executed `down -v`, `up -d --build`, reached 5 / 5 healthy, returned HTTP 200 from simulator live/ready/vehicle/trip endpoints, passed the runtime-image forbidden-path check, and completed final `down -v`.
- Cold Start Success = 2 / 2. The image check found none of Pi Agent, PostgreSQL, Redis, NATS client, API dist, or Agent Runtime paths in the simulator runtime image.
- Phase 1 registered business tools = exactly 2. Agent/API-to-Simulator references = 0. Simulator-to-Phase-4 references = 0. Phase 4+ changed files = 0.
- Tracked `api_key.md` or real environment-secret files = 0. No credential file or live provider credential was used.

### Independent review and remediation

- Reviewer A initially reported Critical 0, High 2, Medium 1, Low 1, then found one additional Medium closed-state-validation issue and one Low reset-history assertion gap during re-review. Transactional ID rollback, exact closed simulator state and dense-array validation, concurrency assertions, bounded-history evidence, and direct reset-history evidence were corrected. Final counts: Critical 0, High 0, Medium 0, Low 0; PASS recommendation; focused tests 197 / 197 passed.
- Reviewer B initially reported Critical 0, High 1, Medium 1, Low 0. Delayed pre-reset mutation crossing and non-uniform native Fastify errors were corrected. Final counts: Critical 0, High 0, Medium 0, Low 0; PASS recommendation; the then-current focused tests 189 / 189 passed.
- Reviewer C initially reported Critical 0, High 0, Medium 2, Low 0. Hidden failed-reroute ID consumption, over-broad simulator runtime-image contents, and Phase 3 status documentation were corrected. Final counts: Critical 0, High 0, Medium 0, Low 0; PASS recommendation.

### Known limitations and gate conclusion

- Mutation serialization, history, counters, and state are process-local and reset on process restart; Phase 3 does not provide distributed coordination or persistence.
- This is a deterministic digital twin for contract and failure testing, not a physical vehicle model or live map/charging backend.
- A configured timeout waits for its deterministic delay and returns HTTP 504 when the client remains connected; an earlier client-side timeout may end observation first.
- The `/simulator/*` control plane is intentionally present for tests and must not be exposed as a production Agent capability.
- Docker Desktop required removal of two stale, automatically regenerated local IPC socket files before the final counted cycles; no repository, image, or user data was deleted.

Implementation, all automated checks, 397 / 397 total tests, 197 / 197 focused Phase 3 tests, measured coverage targets, two clean container starts, architecture/security scans, and all three independent reviews pass. State corruption, secret leakage, Phase 4+ leakage, unresolved Critical findings, and unresolved High findings are all zero. Therefore the Phase 3 gate result is:

**PASS**

Phase 4 has not been started.

## Phase 4 — Capability Model & Tool Registry

- Status: COMPLETE
- Scope: Formal capability availability model, 14 TypeBox-derived Tool Contracts, sealed Tool Registry, dynamic capability/service resolution, Simulator HTTP adapter, deterministic development providers, and Phase 4 verification only.
- Gate result: PASS
- Verification date: 2026-08-27 (Asia/Shanghai)
- Git base: `9d2f38286ec637f876bdf8c0beeb7832dd98833d`; branch `phase/04-capability-tool-registry` in `/home/yej/work/Pi/DriveGuard_phase/04-capability-tool-registry`.

No production Pi Agent integration, Policy Engine, `ALLOW` / `DENY` / `REQUIRE_CONFIRMATION` / `REPLAN` decision, confirmation, action state machine, Reliable Executor, retry, circuit breaker, Agent idempotency, persistence, HMI, or Agent Eval was implemented. The Phase 1 runtime and Phase 3 Simulator server remain unchanged.

### Capability model and dynamic resolution

- Phase 2 `VehicleCapabilities` is reused unchanged: `navigation`, `charging`, `cabinTemperature`, `seatHeating`, `media`, and `roadsideAssistance`.
- Objective service availability is closed and explicit: `vehicleSimulator`, `weather`, and `emergencySupport`.
- Resolution requires every declared capability and service. It does not inspect vehicle speed, context freshness, user role, risk policy, or any authorization result.
- Zero optional vehicle capabilities exposes only `get_vehicle_state` and `get_weather` when their services are available. Unavailable services independently remove their dependent tools.
- The explicit mapping is:
  - navigation → `get_trip_state`, `set_navigation_destination`, `reroute_to_charger`;
  - charging → `search_charging_stations`, `get_charging_status`, `reroute_to_charger`, `reserve_charging_slot`, `cancel_charging_reservation`;
  - cabin temperature → `set_cabin_temperature`;
  - seat heating → `set_seat_heating`;
  - media → `set_media_volume`;
  - roadside assistance → `request_roadside_assistance`, `request_emergency_support`.

### Formal Tool Contracts

R0, read-only:

- `get_vehicle_state`
- `get_trip_state`
- `get_weather`
- `search_charging_stations`
- `get_charging_status`

R1, low risk metadata:

- `set_cabin_temperature`
- `set_seat_heating`
- `set_media_volume`

R2, user-impact metadata:

- `set_navigation_destination`
- `reroute_to_charger`
- `reserve_charging_slot`
- `cancel_charging_reservation`

R3, safety-support metadata:

- `request_roadside_assistance`
- `request_emergency_support`

Every contract contains `name`, `label`, `description`, `inputSchema`, `outputSchema`, `riskLevel`, `requiredCapabilities`, `requiredServices`, `sideEffect`, `timeoutHintMs`, `idempotencyHint`, and `auditLevel`. Input and output types derive from their TypeBox schemas. Inputs, dependency responses, provider outputs, and cloneability boundaries are validated at runtime. The Tool error taxonomy is `TOOL_VALIDATION_ERROR`, `CAPABILITY_UNAVAILABLE`, `DEPENDENCY_UNAVAILABLE`, `DEPENDENCY_TIMEOUT`, `DEPENDENCY_RESPONSE_INVALID`, `RESOURCE_NOT_FOUND`, and `CONFLICT`; `POLICY_DENIED` does not exist in Phase 4.

### RX boundary and Registry semantics

- RX names are exactly `apply_brake`, `control_steering`, `set_throttle`, `disable_aeb`, and `disable_esc`.
- RX registration attempts are rejected. RX formal definitions and dynamic exposure are both zero.
- `ToolRegistry` supports `register`, `get`, `list`, `resolve`, `requireAvailable`, `seal`, and safe snapshots.
- Formal registry creation registers all 14 definitions and seals the registry. Duplicate names, post-seal changes, invalid risk/capability/service metadata, invalid schema, invalid handler, and unsupported RX names are rejected.
- Lists, definitions, schemas, availability arrays, and snapshots are immutable. List order is deterministic by Tool name. Snapshots contain safe metadata only and exclude provider clients, base URLs, schemas, and execute handlers.

### Simulator and development-provider integration

- `SimulatorClient` is the only Phase 4 source containing `fetch()`. It owns the credential-free base URL, request body, HTTP method/path, response validation, structured transport error mapping, and abort-based timeout boundary.
- The adapter covers vehicle/trip reads, cabin temperature, seat heating, media volume, navigation destination, charging search/status/reservation/cancellation, and roadside assistance.
- `reroute_to_charger` explicitly selects a station from `/charging/stations` and sends its name to `/navigation/destination`; the Phase 3 Simulator architecture and endpoints were not changed.
- Weather and emergency support use deterministic implementations whose outputs contain `DEVELOPMENT_PROVIDER`. They are not represented as live external services.
- No retry, circuit breaker, confirmation, Agent execution lifecycle, or idempotency enforcement is present.

### Tests and measured coverage

Final focused Phase 4 results:

| Check                          | Measured result                                                   |
| ------------------------------ | ----------------------------------------------------------------- |
| `npm run test:phase4`          | PASS; 5 files, 223 tests                                          |
| Contract tests                 | PASS; 98 tests                                                    |
| Registry/capability unit tests | PASS; 73 tests                                                    |
| SimulatorClient unit tests     | PASS; 24 tests                                                    |
| Integration tests              | PASS; 20 tests; all 14 formal tools executed through one workflow |
| Architecture/security tests    | PASS; 8 tests                                                     |
| `npm run test:phase4:packages` | PASS; built package imports and 14-tool resolution                |
| `npm test`                     | PASS; 20 files, 620 tests                                         |

The integration suite uses a real loopback Fastify Phase 3 server and verifies Registry → resolution → formal Tool → `SimulatorClient` → Simulator API → validated structured result. Adapter error coverage includes successful reads/mutations, 404, 409, 400, 500, 503, malformed JSON, schema-invalid output, connection failure, and timeout.

Measured V8 coverage from `npm run test:phase4:coverage` after review remediation:

| Scope                          | Statements | Branches | Functions | Lines |
| ------------------------------ | ---------: | -------: | --------: | ----: |
| All Phase 4                    |     99.59% |   99.03% |      100% |  100% |
| `packages/capabilities`        |       100% |     100% |      100% |  100% |
| `packages/tools`               |     99.55% |   98.97% |      100% |  100% |
| Capability resolver            |       100% |     100% |      100% |  100% |
| `ToolRegistry` (`registry.ts`) |     98.48% |   97.95% |      100% |  100% |
| `SimulatorClient`              |       100% |     100% |      100% |  100% |

All requested line and critical Registry/Resolver branch targets were exceeded.

### Architecture, security, and independent review

- Formal DriveGuard tools = exactly 14.
- RX exposed = 0.
- Duplicate formal names = 0.
- Invalid schema execution reaching a handler = 0 in measured tests.
- Phase 1 fixture tools = exactly 2; Phase 1 runtime → formal Registry references = 0.
- Changed Phase 1 Agent Runtime files = 0; changed Phase 3 Simulator server files = 0.
- Phase 4 imports from Policy, Executor, Agent Runtime, Confirmation, or Action State Machine = 0.
- Production policy/confirmation/executor implementation added = 0.
- Tracked secret files, generated build artifacts, or coverage artifacts = 0. No credential source or live provider was used.

Final independent read-only review results:

- Reviewer A — Capability / Contract: Critical 0, High 0, Medium 0, Low 0.
- Reviewer B — Registry / Integration: Critical 0, High 0, Medium 0, Low 0.
- Reviewer C — Architecture / Security: Critical 0, High 0, Medium 0, Low 0.

Pre-final review hardening normalized uncloneable capability contexts, Tool inputs, and provider outputs into the defined structured errors and made registered schemas deeply immutable. Focused tests increased to 223 and passed after those changes.

### Known limitations and gate conclusion

- The formal Registry is a library/test surface only; the production Pi Agent does not load it in Phase 4.
- Risk, timeout, audit, and idempotency values are metadata. Phase 4 does not authorize, confirm, retry, deduplicate, or persist an action.
- Development weather and emergency-support providers are deterministic substitutes, not live services.
- The emergency-support provider sequence and Registry objects are process-local.
- `SimulatorClient` performs one request attempt only. Retry and circuit breaker behavior belongs to Phase 8.
- A GitHub-hosted Actions run and the opt-in paid Phase 1 DeepSeek live smoke were not run; Phase 1 model/runtime paths were unchanged.

Implementation, focused and full regression tests, public package imports, real Simulator integration, error cases, measured coverage, architecture/security checks, and all three reviews pass. Formal Tool count is 14, RX exposure is zero, Phase 1 fixture count is two, and Phase 5+ leakage is zero. Therefore the Phase 4 gate result is:

**PASS**

## Phase 5 — Production Agent Runtime

### Status and scope

- Implementation status: **IMPLEMENTED** in the dedicated Phase 5 worktree.
- Stage Gate: **PASS** after the required live DeepSeek read-only CASE 1–6 smoke completed successfully and the closure regression remained green.
- Commit authorization: enabled only after the closure regression and staged secret/artifact review pass; `main` remains unmodified and unmerged.
- Phase 1 fixture runtime and `PHASE_1_FIXTURE_ONLY` remain unchanged and isolated for regression.
- Phase 6 Policy, Confirmation, Action State Machine, Reliable Executor, persistence, retry, circuit breaker, HMI, production telemetry, and Agent Eval were not implemented.

Implemented modules and configuration:

- `packages/agent-runtime/src/agent-run.ts`: explicit run identity, lifecycle, legal-transition matrix, immutable snapshots, and terminal states.
- `packages/agent-runtime/src/context-loader.ts`: per-turn Vehicle, Trip, weather, user, capabilities, and service-availability loading; Phase 2 snapshot construction and freshness reporting.
- `packages/agent-runtime/src/pi-tool-adapter.ts`: the single Phase 4 `ToolDefinition` to Pi `AgentTool` boundary, defensive input/output Schema validation, cancellation settlement tracking, and safe formal execution evidence.
- `packages/agent-runtime/src/pi-event-adapter.ts`: strict Pi lifecycle to DriveGuard Runtime Event mapping, opaque Tool-call IDs, event pairing, and invalid-state rejection.
- `packages/agent-runtime/src/session.ts`: private process-local Pi Agent state, active-run ownership, safe frozen summaries, transcript checkpoint/rollback, and multi-turn state.
- `packages/agent-runtime/src/production-runtime.ts`: Context/Registry/Pi orchestration, dynamic exposure, concurrency, cancellation, structured failures, safe EventSink boundary, and run evidence.
- `packages/agent-runtime/src/production-factory.ts`: installed Pi DeepSeek catalog selection, controlled dependency construction, runtime-mode parsing, and development Simulator origin enforcement.
- `packages/agent-runtime/src/phase5-live-smoke.ts`: opt-in live DeepSeek read-only CASE 1–6 runner and measured summary format.
- `packages/agent-runtime/src/runtime-errors.ts` and `runtime-events.ts`: closed Runtime error taxonomy and safe internal Event contracts.
- `docs/adr/0006-phase-5-production-agent-runtime-boundaries.md`: Phase 5 architecture and temporary pre-Policy boundary decision.
- Root/package scripts, workspace package exports, lockfile, Vitest alias, `.env.example`, and focused unit/contract/integration tests were updated for Phase 5.
- Phase 3 Simulator implementation and accepted Phase 0–4 interfaces were not modified.

### AgentRun lifecycle

The implemented state model is:

```text
RUN_CREATED
→ CONTEXT_LOADING
→ CAPABILITY_RESOLUTION
→ MODEL_RUNNING
→ TOOL_REQUESTED
→ TOOL_PROCESSING
→ MODEL_RESUMED
→ MODEL_RUNNING
→ RUN_SUCCEEDED | RUN_FAILED | RUN_CANCELLED
```

- Every request has `runId`, `sessionId`, `traceId`, `createdAt`, one immutable `contextSnapshotId`, status, and full status history.
- The complete 10 by 10 transition matrix is tested. Illegal transitions throw structured `INTERNAL_ERROR` and are never silent.
- Throwing, malformed, or duplicate generated run/trace/event IDs produce unique fallback identities and a secret-safe structured failure rather than a raw rejection.

### Context and World State refresh

- Every user turn reloads current Vehicle and Trip state from the formal Simulator client, reloads current capability/service inputs, and creates a new Phase 2 `ContextSnapshot`.
- Conversation memory persists only for conversational continuity; it is not used as current World State.
- The two-turn Simulator integration changed SOC from 72 to 20 and verified the second turn observed 20 with increased Context and Vehicle versions.
- Freshness reports cover `FRESH`, `STALE`, `INVALID_FUTURE_TIMESTAMP`, and `NOT_LATEST`. Non-fresh Context returns `CONTEXT_INVALID` before model execution.
- `NOT_LATEST` is verified through the production factory's injectable authoritative latest-version provider. The default/live Simulator composition has no independent authoritative latest-version source and therefore live `NOT_LATEST` detection remains **NOT VERIFIED**; no claim is made beyond the injected production path.

### Dynamic Tool exposure

- Every turn resolves `ContextSnapshot.capabilities + current ServiceAvailability` through the Phase 4 sealed Registry.
- Full development capability resolves exactly 14 formal Tools; default read-only mode exposes the five R0 Tools.
- Charging capability removal hides every charging Tool; `seatHeating=false` hides `set_seat_heating`; per-turn service changes hide the corresponding Tools in the same Session.
- Non-formal definitions, forbidden RX names, and any side-effect definition in read-only mode are rejected defensively.
- RX exposure measured by architecture and runtime tests: **0**.

### Pi Tool and Event adapters

- Tool name, label, description, input Schema, handler, and formal output contract flow through the single `PiToolAdapter`.
- Adapter-level Schema checks and safe cloning independently reject invalid or uncloneable input/output, even if an injected handler is defective.
- Cancellation waits for already-dispatched dependency work to settle. Safe evidence records `outcome` and `completedAfterCancel`, so an action that actually completed after cancellation is not hidden.
- `PiEventAdapter` accepts Tool starts only during valid model/parallel-processing states, enforces start/end/name pairing, rejects orphan/duplicate/incomplete lifecycles, and maps raw provider IDs to per-run opaque IDs.
- Runtime Events contain required identity/timestamp fields and safe lifecycle metadata only. Prompts, raw Pi messages, Tool arguments/results, credentials, hidden reasoning, and provider-controlled IDs are absent.
- An EventSink failure on `tool.requested` propagates before Pi handler dispatch; a real development-mode Simulator test measured zero side effect. Terminal sink failure cannot produce a failed result with `RUN_SUCCEEDED` state.

### Session, concurrency, and runtime modes

- One private Pi Agent is held per process-local Session. Raw Agent state and raw messages are not package exports; callers receive only frozen session summaries and safe run evidence.
- Successful turns preserve conversation state. Failed/cancelled turns roll back additions from that turn, preventing raw provider errors or partial Tool messages from contaminating the next request.
- Same-Session concurrent requests return `SESSION_BUSY`; different Sessions run concurrently with distinct run/event/context/message state.
- `read_only` is the default and exposes only non-side-effect R0 definitions.
- `development` requires explicit `NON_PRODUCTION` opt-in, a loopback Simulator origin, the controlled formal Registry, and `PRE_POLICY` / `NON_PRODUCTION` labeling.
- The documented warning is: `Phase 5 execution path is pre-Policy and not production-safe for side-effect tools.`

### Tests, coverage, and regression

Final measured automated results on 2026-08-27:

- `npm run format`: PASS.
- `npm run lint`: PASS, zero warnings.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run test:phase5`: PASS, 6 files / **241 tests**.
- `npm run test:phase5:packages`: PASS, **7/7** safe public exports; raw Runtime constructor and Session/Agent objects are not exported.
- `npm test`: PASS, 26 files / **861 tests**. Phase 0–4 regression remains PASS.
- `npm audit --audit-level=high`: PASS, **0 vulnerabilities**.
- `git diff --check`: PASS.

Measured Phase 5 coverage:

| Module                       |  Lines | Branches | Functions |
| ---------------------------- | -----: | -------: | --------: |
| All selected Phase 5 modules | 97.31% |   93.44% |    98.24% |
| AgentRun                     |   100% |     100% |      100% |
| ContextLoader                |   100% |     100% |      100% |
| PiEventAdapter               |   100% |     100% |      100% |
| PiToolAdapter                |   100% |     100% |      100% |
| Production factory           | 97.56% |      96% |      100% |
| Production runtime           | 94.31% |   88.23% |    96.42% |
| Runtime errors               |   100% |     100% |      100% |
| Runtime events               |   100% |     100% |      100% |
| Session                      | 97.87% |   83.33% |    96.29% |

All requested line targets and the AgentRun, ContextLoader, Tool adapter, and Event adapter branch targets pass.

### Architecture, security, and review

- Production Runtime uses Phase 4 Registry: PASS.
- Production Runtime uses Phase 2 Context: PASS.
- Formal Tool source count: 14.
- Default read-only Tool count: 5.
- Dynamic exposure cases: PASS in automated integration tests.
- RX exposed: 0.
- Phase 1 fixture/runtime isolation: PASS; changed Phase 1 Runtime files = 0.
- Production Policy/Confirmation/Action State Machine/Reliable Executor/Persistence implementations added: 0.
- Raw Pi Session/Agent/message API package exports: 0.
- Tracked `.env`, credential, key, generated build, coverage, cache, or log artifacts: 0.
- `api_key.md` was not read, copied, logged, or used.
- Secret leakage in Runtime result/event/factory/sink/provider error tests: 0.

Three independent read-only reviews were performed and all correctness, architecture, security, and test-validity findings were remediated:

- Reviewer A — Runtime Correctness final: Critical 0, High 0, Medium 0, Low 0.
- Reviewer B — Tools / Events final: Critical 0, High 0, Medium 0, Low 0.
- Reviewer C — Architecture / Security code findings: Critical 0, High 0, Medium 0, Low 0 after this status record replaces the stale “not started” entry.

Notable review hardening included private raw Pi state, failed-turn rollback, live per-turn capability/service refresh, strict formal-name and development-origin boundaries, independent output validation, strict Pi event pairing/state checks, safe EventSink propagation, safe ID/Event factory fallback, deep-frozen in-memory events, and truthful post-cancellation execution evidence.

### Live DeepSeek and known limitations

The required live DeepSeek read-only Gate was executed successfully with these measured totals:

| Field                  | Actual result        |
| ---------------------- | -------------------- |
| Provider               | `deepseek`           |
| API                    | `openai-completions` |
| Model                  | `deepseek-v4-flash`  |
| Runtime mode           | `read_only`          |
| Provider requests      | 13                   |
| Formal Tool calls      | 7                    |
| Formal Tool executions | 7                    |
| Tool errors            | 0                    |

Live CASE 1–6 results:

| Case                         | Actual Tool behavior                                                  | Terminal result                                   | Gate result |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- | ----------- |
| CASE 1 — battery             | `get_vehicle_state`                                                   | `RUN_SUCCEEDED`                                   | PASS        |
| CASE 2 — navigation          | `get_trip_state`                                                      | `RUN_SUCCEEDED`                                   | PASS        |
| CASE 3 — charging stations   | `search_charging_stations`                                            | `RUN_SUCCEEDED`                                   | PASS        |
| CASE 4 — multi-tool          | `get_vehicle_state` + `get_trip_state`; 2 executions                  | `RUN_SUCCEEDED`                                   | PASS        |
| CASE 5 — ordinary chat       | 0 Tool calls                                                          | `RUN_SUCCEEDED`                                   | PASS        |
| CASE 6 — World State refresh | 2 prompts; `get_vehicle_state` executed twice; `contextVersion` 6 → 7 | both runs `RUN_SUCCEEDED`; `expectationsMet=true` | PASS        |

- Live Secret handling used the process environment only; no credential value or live-test log is stored in Git.
- Automated tests continue to use Pi `fauxProvider()` and remain offline from the live LLM.
- Sessions and Runtime Events are process-local and non-durable.
- Development side effects remain direct pre-Policy execution and are not production-safe.
- Retry, circuit breaker, durable idempotency, distributed session coordination, and durable audit belong to later phases and are absent.

### Stage Gate conclusion

Automated engineering, Phase 0–4 regression, Registry/Context integration, World State refresh, dynamic Tool exposure, RX isolation, lifecycle, concurrency, required event propagation, formal Tool integration, coverage, secret tests, three independent code reviews, and the required live DeepSeek read-only CASE 1–6 smoke all pass.

The Phase 5 Stage Gate result is:

**PASS**

Per the phase workflow, the Phase 5 closure commit is created only after the final regression and staged security review pass. `main` is not merged or modified, and Phase 6 is not started.

## Phase 6 — Deterministic Policy Engine

- Status: COMPLETE.
- Scope: deterministic Policy decision model, stable rule engine, explicit profiles for all 14 formal Tools, Phase 2 freshness/conflict reuse, one Runtime Policy interception layer, Policy control results/events, and Phase 6 verification only.
- Gate result: PASS.
- Verification date: 2026-08-28 (Asia/Shanghai).

### Implemented modules

- `packages/policy/src/types.ts`: safe `PolicyDecision`, evidence, evaluation input, and rule contracts.
- `packages/policy/src/profiles.ts`: immutable, validated `ToolPolicyProfile` mapping for all 14 formal Tools using actual Phase 2 Context paths.
- `packages/policy/src/registry.ts`: duplicate-safe, deterministic `PolicyRuleRegistry`.
- `packages/policy/src/rules.ts`: fixed P0-P10 rule table with terminal `DEFAULT_DENY`.
- `packages/policy/src/engine.ts`: synchronous, deterministic, fail-closed evaluation and boundary normalization.
- `packages/agent-runtime/src/policy-guarded-tool-handler.ts`: one guard between schema validation and formal handler dispatch.
- Phase 5 Runtime factory, Tool/Event adapters, Runtime errors/events, session prompt, and production run evidence were extended for Phase 6 enforcement.
- `packages/agent-runtime/src/phase6-live-smoke.ts`: opt-in real DeepSeek R0/R2 smoke using `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, and `SIMULATOR_BASE_URL` from the process environment.
- `docs/adr/0007-phase-6-deterministic-policy-engine.md`: decision model, precedence, fail-closed, profile, Context, Runtime, and Phase 7 boundary decision.
- Phase 6 unit, contract, integration, package-export, matrix, performance, and security tests were added; obsolete Phase 5 pre-Policy assertions were converted into Phase 6-aware regression assertions.

### Current measured verification

| Check                               | Current result                                                |
| ----------------------------------- | ------------------------------------------------------------- |
| Phase 6 focused tests               | 253 / 253 PASS                                                |
| Full Phase 0–6 regression           | 1,115 / 1,115 PASS                                            |
| Phase 5 focused regression          | 242 / 242 PASS                                                |
| Defined machine-readable matrix     | 20 / 20 rows match decision and rule                          |
| Generated Policy cases              | 10,000 unique case IDs across 11 scenarios                    |
| Determinism/performance evaluations | 20,000 (each generated case evaluated twice)                  |
| Decision mismatch                   | 0                                                             |
| Rule mismatch                       | 0                                                             |
| Non-deterministic result            | 0                                                             |
| Critical Policy recall              | 7,335 / 7,335 = 100%                                          |
| Pure Policy p95                     | 0.112 ms (final full non-coverage run, rounded)               |
| Pure Policy p99                     | 0.198 ms (final full non-coverage run, rounded)               |
| Phase 6 package exports             | PASS                                                          |
| Live DeepSeek R0/R2 smoke           | PASS — R0 ALLOW/executed once; R2 confirmation/0 side effects |

Measured Phase 6 coverage (barrel export file excluded because it contains no executable policy logic):

| Module                            |  Lines | Branches | Functions |
| --------------------------------- | -----: | -------: | --------: |
| All selected Phase 6 modules      |  99.6% |   98.02% |      100% |
| `packages/policy`                 | 99.54% |   97.96% |      100% |
| PolicyEngine (`engine.ts`)        | 99.11% |   98.06% |      100% |
| RuleRegistry (`registry.ts`)      |   100% |   95.65% |      100% |
| ToolPolicyProfile (`profiles.ts`) |   100% |   97.95% |      100% |
| Critical rules (`rules.ts`)       |   100% |     100% |      100% |
| Runtime Policy Gate               |   100% |     100% |      100% |

### Safety and phase boundary

- Formal Tool profiles: 14 / 14.
- Normal R0/R1/R2/R3 decisions and all required freshness/conflict states are covered.
- RX forged/direct requests, malformed input, unknown risk/profile, missing/invalid Context, missing capability/service, and Policy exceptions fail closed in automated tests.
- Runtime tests prove `ALLOW` executes once while `DENY`, `REPLAN`, and `REQUIRE_CONFIRMATION` execute the underlying side effect zero times.
- The Engine contains no LLM call, prompt judgment, network/database I/O, clock, or randomness.
- Phase 7 Confirmation, Pending Action, Action State Machine, Reliable Executor, persistence, retry, circuit breaker, production idempotency, and urgent-event automation implemented: 0.
- `api_key.md` was not read, copied, logged, or used. Automated tests use the Pi faux provider.
- Engineering checks pass: format, lint, typecheck, build, `git diff --check`, and `npm audit` with 0 vulnerabilities.
- Three independent read-only reviews report PASS with 0 Critical, 0 High, and no unresolved safety/correctness/architecture/test-validity Medium findings.

### Known limitations and pending closure evidence

- `REQUIRE_CONFIRMATION` is a control result only; no confirmation lifecycle exists until Phase 7.
- Runtime events and Policy decision evidence are process-local and non-durable.
- The development Simulator/provider remains non-production infrastructure.
- The required live DeepSeek R0/R2 smoke passed using an explicitly authorized `.env` read that injected only `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, and `SIMULATOR_BASE_URL` into the one live-test child process. No credential value was printed, logged, copied, or committed, and `api_key.md` was not read.
- Live R0 requested `get_vehicle_state`, received `DG-POL-010 / ALLOW`, and executed exactly once.
- Live R2 requested `set_navigation_destination`, received `DG-POL-008 / REQUIRE_CONFIRMATION`, executed the underlying side effect zero times, left Simulator destination unchanged, and did not claim success.

## Phase 7 — Confirmation & Action Lifecycle

- Status: COMPLETE.
- Scope: process-local PendingAction, centralized Action State Machine, trusted confirmation, Context/capability/service revalidation, one-time ExecutionAuthorization creation, Runtime integration, and Phase 7 verification only.
- Gate result: **PASS**.
- Verification date: 2026-08-29 (Asia/Shanghai).

### Implemented modules

- `packages/action-lifecycle`: canonical fingerprinting, immutable action models, internal in-memory repository, centralized state transitions, safe lifecycle events, ContextRevalidator, deterministic confirmation summary, and ConfirmationService.
- `packages/agent-runtime/src/trusted-confirmation-channel.ts`: separate, one-time, TTL-enforced, non-model-visible application channel for plaintext confirmation challenges.
- `packages/agent-runtime/src/policy-guarded-tool-handler.ts`: converts only `REQUIRE_CONFIRMATION` into PendingAction creation while preserving ALLOW and blocking DENY/REPLAN.
- `packages/agent-runtime/src/production-runtime.ts` and `production-factory.ts`: safe confirmation-required results, trusted challenge channel, current Context reload, and zero Phase 7 R2/R3 execution.
- `packages/agent-runtime/src/phase7-live-smoke.ts`: opt-in real DeepSeek R2 smoke; missing `DEEPSEEK_API_KEY` reports NOT RUN and exits non-zero.
- `docs/adr/0008-phase-7-confirmation-action-lifecycle.md`: trust, token, TTL, fingerprint, revalidation, authorization, event, and Phase 7/8 boundary decisions.

### Current measured verification

| Check                                                  | Current result                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 7 focused tests                                  | 259 / 259 PASS                                                                                                                             |
| Package export boundary                                | PASS; repository mutation export = 0; confirmation Tool export = 0                                                                         |
| Generated adversarial cases                            | 10,000 across valid, wrong-token, expired, replay, cross-session, cross-user, tamper, Context conflict, capability loss, and invalid state |
| Confirmation bypass / replay success                   | 0 / 0                                                                                                                                      |
| Unauthorized READY / duplicate authorization           | 0 / 0                                                                                                                                      |
| Measured R2/R3 underlying handler executions in matrix | 0                                                                                                                                          |
| Pure process-local lifecycle performance               | P95 0.157 ms; P99 0.270 ms; coverage-instrumented P95 0.235 ms / P99 0.369 ms                                                              |
| Expanded Phase 7 coverage                              | Lines 97.48%; branches 95.07%                                                                                                              |
| `packages/action-lifecycle` coverage                   | Lines 99.33%; branches 97.52%                                                                                                              |
| Action State Machine                                   | Lines 100%; branches 100%                                                                                                                  |
| ConfirmationService security paths                     | Lines 99.38%; branches 97.89%                                                                                                              |
| Runtime integration selected files                     | Lines 95.80%; branches 92.64%; included in enforced global Phase 7 threshold                                                               |
| Full engineering/regression Gate                       | PASS; format, lint, typecheck, build, 1,374 tests, diff check, audit, package boundary, and coverage                                       |
| Live DeepSeek R2 smoke                                 | PASS; `REQUIRE_CONFIRMATION`, one PendingAction, side effects 0, unchanged Simulator, no success claim, no token on safe surfaces          |

### Safety and architecture boundary

- `LLM can self-confirm = 0`; confirmation is absent from the formal Tool Registry.
- Runtime safe results and events contain no plaintext confirmation token. The token is delivered only through the trusted application channel.
- Public action-lifecycle exports contain no repository mutation capability.
- Confirmation token hashes are stored process-locally; plaintext is not stored in PendingAction records or events.
- READY requires confirmation plus current Context, capability, and service revalidation. READY is terminal; a ready-event delivery failure is surfaced without adding an invalid rollback transition.
- Integration Cases A–D pass against the loopback Simulator, and Simulator side effects remain unchanged throughout confirmation/revalidation.
- Reliable Executor, authorization consumption, retry, circuit breaker, production idempotency, database/message persistence, and HMI/HTTP confirmation API implemented: 0.
- `api_key.md` was not read, copied, logged, or used. Automated tests use the Pi faux provider.

### Review and known limitations

- Initial independent reviews found Critical 0, High 2, and Medium findings in repository exposure, coverage scope, challenge delivery, event ordering, metric validity, live-smoke enforcement, and missing documentation.
- Repository mutation is now internal; trusted challenge delivery is mandatory, TTL-bounded, and discarded after leaving `AWAITING_CONFIRMATION`; READY is committed before its event and remains terminal on delivery failure; 10,000 handler/authorization counters are genuine; runtime files are included in a threshold-enforced coverage command; argument tampering, Tool substitution, and fingerprint mismatch are directly fail-closed tested; and live smoke passed without a side effect.
- Final independent read-only reviews found no unresolved Critical, High, or Medium issue after remediation.
- State, events, trusted challenges, and authorizations remain process-local and non-durable by explicit Phase 7 scope.
- The final Gate passed. Phase 8 and project-level target metrics remain out of scope and unclaimed.

## Phase 8 — Reliable Tool Executor

- Status: COMPLETE.
- Scope: process-local reliable execution, one-time authorization/Policy permit consumption,
  idempotency and single-flight, bounded retry/timeout, circuit breaking, safe execution events,
  formal Runtime integration, and Simulator downstream idempotency only.
- Gate result: **PASS**.
- Verification date: 2026-08-29 (Asia/Shanghai).

### Implemented modules

- `packages/executor`: `ReliableToolExecutor`, independent execution lifecycle/records/attempts,
  full-request idempotency binding, retry classification/backoff, AbortController timeout, per-service
  circuit breaker, safe result/error surface, and safe execution event sink.
- `packages/action-lifecycle`: atomic process-local authorization consumption under the existing
  per-action repository lock; fingerprint recomputation uses trusted user/vehicle/Context identity
  plus the Executor's actual validated arguments.
- `packages/policy`: process-local R0/R1 Policy decision provenance, exact definition/arguments and
  run/session/trace/fingerprint/Context binding, plus atomic one-time execution consumption.
- `packages/agent-runtime`: R0/R1 `ALLOW` and confirmed R2/R3 now converge on the Executor; the
  accepted Phase 1 fixture Runtime remains unchanged.
- `packages/tools` and `services/vehicle-simulator`: attempt context carries AbortSignal/attempt/key;
  only `reserve_charging_slot` is retry-safe, backed by Simulator `Idempotency-Key` single-flight and
  result reuse. All other mutations are explicitly `NON_IDEMPOTENT` in this phase.
- `docs/adr/0009-phase-8-reliable-tool-executor.md`: execution, authorization, idempotency, retry,
  timeout, breaker, concurrency, ambiguity, process-local limitations, and Phase 8/9 boundary.

### Current measured verification

| Check                                               | Current result                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Phase 8 focused tests                               | 285 / 285 PASS across 6 files                                                                                                     |
| Full Phase 0–8 regression                           | 1,659 / 1,659 PASS across 44 files                                                                                                |
| Formal Runtime Executor scenarios                   | 5 / 5 PASS: R0, R1, confirmed R2, confirmed R3, unconfirmed execution = 0                                                         |
| Generated reliability/adversarial cases             | 10,000; forbidden execution 0, duplicate side effects 0, authorization replay 0, idempotency collision accepted 0, unsafe retry 0 |
| Retry-safe transient cases                          | 1,000 / 1,000 recovered (100%); duplicate side effects 0                                                                          |
| Executor local overhead                             | non-coverage P95 0.057501 ms; P99 0.137656 ms over 10,000 operations                                                              |
| Executor package coverage                           | lines 99.69%; branches 96.56%; statements 99.13%; functions 98.03%                                                                |
| `ReliableToolExecutor` coverage                     | lines 99.49%; branches 95.50%; statements 99.01%; functions 100%                                                                  |
| Idempotency / RetryPolicy / CircuitBreaker branches | 100% / 100% / 100%                                                                                                                |
| Authorization verification coverage                 | lines 100%; branches 100%                                                                                                         |
| Critical safety scenarios                           | 100% of defined Policy identity/Context fields, authorization mismatch/replay, RX, ambiguity, and downstream-dedup cases PASS     |
| Simulator fault integration                         | delay, timeout, HTTP 500/503, connection abort, stale response, Cases A–D PASS                                                    |
| Package export boundary                             | PASS                                                                                                                              |
| Engineering/security checks                         | format, lint, typecheck, build, diff check PASS; npm audit 0 vulnerabilities                                                      |

### Safety, architecture, and limitations

- Formal Runtime bypasses Executor = 0 in the defined integration set; R2/R3 without trusted
  `ExecutionAuthorization` = 0; authorization double consumption = 0; RX execution = 0; duplicate
  side effects = 0; unsafe ambiguous retry = 0.
- Exact same-request sequential/concurrent replays, including the same `executionId`, reuse one
  terminal result. Altered fingerprint, arguments, authorization, session, trace, run, or Context
  binding conflicts or rejects before Tool dispatch.
- A conflicting same-`executionId` replay cannot transition or corrupt the legitimate owner's
  record, including while the R2 owner is awaiting atomic authorization consumption.
- A real client-side timeout after reservation application is retried with the same downstream key
  and produces exactly one reservation. Non-idempotent ambiguous timeouts return `OUTCOME_UNKNOWN`,
  including when audit delivery itself fails.
- Circuit state settles before fallible event delivery; HALF_OPEN probes cannot remain permanently
  active after business errors or audit failure, and every HALF_OPEN-to-CLOSED settlement emits
  `circuit.closed`. Audit timestamps come from the Executor Clock and record attempts are deeply
  frozen.
- Reliability state, Policy permit provenance, authorizations, idempotency, records, events,
  downstream Simulator deduplication, and breaker state are process-local and non-durable. Restart,
  multi-process coordination, eviction/retention, persistence, and transactional outbox remain future
  work and are not claimed.
- PostgreSQL, Redis, NATS workflow, HMI, production OpenTelemetry, urgent-event handling, benchmark/
  load infrastructure, and other Phase 9+ implementation were not added.
- `api_key.md` was not read, copied, logged, or used; `.env`, credentials, tokens, logs, coverage, and
  temporary benchmark artifacts are not part of the change set.

### Review closure

- Three independent read-only reviews initially found Critical 0 and High issues in request-bound
  deduplication, downstream retry proof, R0/R1 Policy replay, HALF_OPEN settlement, and ambiguous
  event-failure handling, plus relevant Medium findings in exact execution replay, audit time,
  immutable attempts, and real client-timeout validity.
- All findings were remediated with direct regression tests. Final independent review outcome is
  Critical 0, High 0, and relevant Medium 0 across Executor correctness, exactly-once/idempotency,
  and safety/architecture reviews.

## Phase 9 — Persistence & Memory

- Status: COMPLETE.
- Scope: PostgreSQL/Drizzle durable state, Redis TTL cache/coordination with PostgreSQL fallback,
  repository dependency injection, restart recovery, and append-only audit only.
- Gate result: **PASS**.
- Verification date: 2026-08-31 (Asia/Shanghai).

### Implemented modules

- `packages/persistence`: eight-table Drizzle schema, repeatable migration and operator rollback,
  PostgreSQL repositories, atomic PendingAction/authorization lifecycle, durable execution and
  idempotency coordination, and append-only audit repository.
- `packages/memory`: session/conversation interfaces, in-memory repositories, PostgreSQL-authoritative
  ConversationMemory, TTL-bound Redis cache, session coordination with PostgreSQL fallback, and
  TTL-bound Redis idempotency coordination.
- `packages/action-lifecycle`, `packages/executor`, and `packages/agent-runtime`: asynchronous
  repository and durable-coordinator dependency injection, transcript restoration, per-turn durable
  append, mandatory identity-bound durable memory in the Phase 9 composition, and distributed
  session lease fencing.
- `infra/db`: repeatable forward migration, Drizzle journal, and reverse-order rollback for all eight
  Phase 9 tables.
- `docker-compose.yml`: PostgreSQL, Redis, one-shot migration, DriveGuard API, NATS infrastructure,
  and Vehicle Simulator health/dependency wiring. NATS business orchestration remains unused.
- `docs/adr/0010-phase-9-persistence-and-memory.md`: source-of-truth, transaction, recovery, memory,
  audit, Redis, and Phase 9/10 boundary decisions.

### Current measured verification

| Check                               | Current result                                                                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 9 focused tests               | 148 scenarios PASS across 3 Vitest files by combined evidence (147 on the final code coverage run plus the separately measured unchanged 10,000-case matrix); package export contract PASS                                               |
| Real persistence/concurrency matrix | 10,000 cases: 5,000 execution/idempotency cases plus 5,000 authorization-consumption cases                                                                                                                                               |
| Duplicate side effect               | 0                                                                                                                                                                                                                                        |
| Authorization replay success        | 0                                                                                                                                                                                                                                        |
| Idempotency conflict bypass         | 0                                                                                                                                                                                                                                        |
| Lost final execution record         | 0                                                                                                                                                                                                                                        |
| Audit missing                       | 0                                                                                                                                                                                                                                        |
| Defined Action audit completeness   | 9 / 9 required events = 100%                                                                                                                                                                                                             |
| PostgreSQL migration                | Two consecutive migration calls PASS; exactly 8 Phase 9 business tables present                                                                                                                                                          |
| Restart recovery                    | Session, conversation, PendingAction confirmation, authorization replay, idempotency outcome, and `OUTCOME_UNKNOWN` PASS                                                                                                                 |
| World-state freshness               | Runtime restart restores conversation while Simulator SOC changes 70 -> 20; Turn 2 observes 20 and not 70                                                                                                                                |
| Redis                               | Real TTL/owner release PASS; Redis failure falls back to PostgreSQL session lease without weakening durable safety state                                                                                                                 |
| Coverage                            | all selected: lines 96.22%, branches 91.60%; persistence: lines 95.40%, branches 91.22%; memory: lines 99.29%, branches 92.72%                                                                                                           |
| Critical paths                      | authorization consume/replay/subject spoofing, strict DB request binding, durable idempotency reuse/conflict, COMMIT-ack ambiguity, crash ambiguity, transaction rollback, session fencing, and post-commit lease loss directly executed |
| Phase 9 Docker clean deployment     | 5 / 5 clean deployments PASS; final role-separated rebuild also has migration exit 0 and all required services healthy                                                                                                                   |
| Full Phase 0–9 regression           | 1,813 / 1,813 PASS across 47 files by combined final evidence (148 Phase 9 scenarios plus 1,665 Phase 0–8 tests)                                                                                                                         |
| Engineering/security gate           | format, lint, typecheck, build, diff check, npm audit, secret/phase-boundary checks PASS                                                                                                                                                 |

### Safety and architecture boundary

- PostgreSQL is authoritative for PendingAction, ExecutionAuthorization, ExecutionRecord,
  idempotency outcome, and AuditEvent. PostgreSQL unavailability fails closed before Tool owner side
  effects.
- Redis is only TTL-bound cache/coordination. Redis failure may take the slower PostgreSQL path but
  cannot permit duplicate authorization consumption, duplicate side effects, or lost audit state.
- Authorization consumption is a conditional update under a row-locked transaction; 100 concurrent
  consumers produce exactly one success, including after repository recreation.
- Session transcripts are durably bound to one user/vehicle pair before model use. R0/R1 execution
  fingerprints bind that subject directly; R2 authorization consumption compares the request
  subject with the stored action while preserving the separately revalidated authorization Context.
- Execution ownership is committed before invoking the Tool owner. Restart duplicates reuse a final
  result or return/persist `OUTCOME_UNKNOWN`; they are never automatically retried blindly.
- PostgreSQL server time is authoritative for confirmation/authorization expiry and lease
  acquisition. A session renewal or release failure after a committed durable success cannot rewrite
  that success as `SESSION_BUSY`.
- Conversation storage contains no VehicleState or TripState. Every runtime turn reloads the current
  ContextProvider/Simulator state.
- Audit rows require user/vehicle subjects and reject `UPDATE`, `DELETE`, and `TRUNCATE` through both
  database triggers and a distinct runtime role with only `SELECT/INSERT` audit grants. Role setup
  rejects elevated/member/owner roles, forces `NOINHERIT`, resets stale grants, and limits DELETE to
  transactional execution conflict cleanup. Safe audit and conversation validation rejects
  credentials, tokens, cookies, authorization headers, reasoning, and chain-of-thought.
- RX capability registration, Phase 10 HMI/API, NATS business workflow, full observability, and urgent
  event handling added: 0.
- `api_key.md` was not read, copied, logged, or used. `.env`, database/Redis data, dumps, credentials,
  logs, coverage, and temporary artifacts are excluded from the change set.

### Review and known limitations

- Final independent database, reliability, and architecture/security re-reviews each report
  Critical 0 / High 0 / Medium 0 after the hardening changes.
- The focused assertions are intentionally scenario-dense rather than padded to 200; the
  reliability test executes and measures 10,000 real PostgreSQL concurrency cases.
- Expired ambiguous executions remain `OUTCOME_UNKNOWN`; operator reconciliation, retention,
  archival, outbox processing, multi-region failover, HMI, and Phase 10 API work remain out of scope.
- The final Stage Gate passed. Phase 10 was not started and `main` was not merged.

## Phase 10 — API, Streaming & HMI

- Status: COMPLETE.
- Scope: HTTP API, curated SSE streaming, confirmation/action/session/execution application APIs,
  durable Phase 9 integration, minimal HMI, and Compose deployment only.
- Gate result: **PASS**.
- Verification date: 2026-08-31 (Asia/Shanghai).

### Implemented modules

- `apps/api/src/{app,errors,events,production,routes,service,server}.ts`: strict TypeBox/Fastify
  boundary, stable response/error contracts, curated SSE mapping, development identity binding,
  Runtime-backed application service, production provider selection, and durable startup wiring.
- `packages/agent-runtime`: sanitized assistant-delta callback and exact development-only trusted
  Simulator origin extension without changing the accepted internal Runtime event contract.
- `packages/persistence`: identity-bound Execution envelope reads and exposed durable Session
  repository binding; execution request, record, attempts, and result are read consistently.
- `apps/hmi/public`: minimal Conversation, confirmation, Tool/Policy progress, timeline, and
  execution-result UI with explicit waiting/executing/success/failure/replan/expired states.
- `infra/docker` and `docker-compose.yml`: Phase 10 API image, Node 22 static HMI/API proxy, and the
  PostgreSQL/Redis/NATS/Simulator/API/HMI health/dependency graph.
- `tests`: 150 dedicated Phase 10 contract, branch, architecture, HMI, Runtime integration,
  streaming/disconnect, security, performance, and Docker restart-smoke scenarios.
- `docs/adr/0011-phase-10-api-streaming-hmi.md`: API, SSE, identity, confirmation, HMI, deployment,
  and Phase 10/11 boundary decisions.

### Current measured verification

| Check                                      | Current result                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Dedicated Phase 10 tests                   | 150 / 150 PASS across 6 files; coverage command also executes 5 health tests                          |
| API contract and malformed input           | PASS; strict headers/params/body, no coercion, stable data/error envelopes                            |
| SSE lifecycle                              | PASS; normal/tool/policy/confirmation/completion/failure and real client-disconnect cancellation      |
| R0 Runtime flow                            | PASS; Session -> streamed Tool -> Policy ALLOW -> Executor -> assistant completion                    |
| R2/R3 confirmation flow                    | PASS; both risks require confirmation before Executor; R2 also passes restart/durable recovery        |
| Confirmation/Executor bypass               | 0 / 0                                                                                                 |
| Unconfirmed / duplicate side effects       | 0 / 0                                                                                                 |
| Cross-user action access                   | 0 accepted; mismatches hidden as ACTION_NOT_FOUND                                                     |
| API restart recovery                       | PASS for Session and PendingAction; confirmed post-restart side effect exactly once                   |
| Non-LLM API latency                        | 300 valid local requests; P95 0.103 ms; P99 0.246 ms; error rate 0                                    |
| Backend coverage                           | lines 99.50%; branches 96.07%; statements 99.04%; functions 100%                                      |
| Critical Application Service coverage      | lines 100%; branches 95.65%; functions 100%                                                           |
| Real Phase 9 PostgreSQL/Redis regression   | 147 PASS; the separately accepted 10,000-case Phase 9 matrix intentionally skipped per Phase 10 scope |
| Full local regression without DB variables | 1,921 PASS on final code; 43 Phase 9 DB cases skipped by their environment gate                       |
| Docker clean deployment                    | PASS after one verified `down -v`; all six long-running services healthy, migration exited 0          |
| Docker end-to-end smoke                    | PASS: health, HMI, R0 SSE, R2 confirmation, restart recovery, persistence, exactly-once side effect   |
| Dependency/security checks                 | npm audit 0 vulnerabilities; structured secret-safe responses; `api_key.md` never read                |

### Safety and architecture boundary

- HTTP route direct database mutation = 0; route direct Simulator calls = 0; HMI Simulator calls = 0.
- Action state is never assigned by API/HMI code. Confirm/reject/cancel go through the production
  Runtime and `ConfirmationService`; authorized execution goes through the Reliable Executor.
- Confirmation publication validates action session/user/vehicle and challenge session/user. Cross-
  session, cross-user, cross-vehicle, wrong-token, expired, malformed, replay, and missing-boundary
  cases fail closed in tests.
- SSE exports only eight stable public event types. Context/model internals, raw arguments outside
  the deterministic confirmation view, reasoning, stacks, SQL, filesystem paths, and secrets are
  not exposed.
- World state remains per-turn Runtime input. Conversation and action recovery do not reuse a stale
  VehicleState or TripState.
- NATS business publishers/consumers, RX tools, Phase 11 observability, Phase 12 urgent events,
  benchmark/load infrastructure, and direct vehicle actuation added: 0.
- Compose's faux provider and development identity headers are explicitly non-production. The
  standalone API defaults to environment-configured DeepSeek; no credential is hard-coded.

### Review closure and known limitations

- Three focused read-only self-review passes covered API/SSE, confirmation/security, and
  architecture/HMI. Initial result: Critical 0, High 0, Medium 4.
- All four Medium findings were fixed: complete action/challenge subject binding before credential
  publication, distinct HMI replan/expired states, a consistent single-statement Execution envelope
  read, and browser disconnect propagation through the HMI proxy to the API SSE request. Final
  result: Critical 0, High 0, relevant Medium 0.
- The first HMI container build was blocked by Docker Desktop's unavailable registry proxy. The HMI
  now reuses the verified Node 22 base image and a static `/api` proxy with no business logic; the
  clean deployment and end-to-end restart smoke pass on that image.
- The Phase 9 real 10,000-case regression was attempted but exceeded its existing 180-second test
  timeout before completion; its partial counters were discarded. The repository's explicit
  `PHASE9_SKIP_RELIABILITY_MATRIX=1` switch was then used as permitted by the Phase 10 instruction
  not to rerun a 10,000-case matrix; all other 147 Phase 9 tests passed against real PostgreSQL and
  Redis.
- OAuth, production HMI authorization/storage hardening, reconnection replay cursors, formal load
  testing, live DeepSeek smoke, observability, urgent events, and NATS business workflows remain out
  of scope and are not claimed.
- Phase 11 was not started and `main` was not merged.

## Phase 11 — Observability

- Status: COMPLETE.
- Scope: structured logging, Prometheus metrics, OpenTelemetry traces, API observability wiring,
  Prometheus/Grafana deployment, and dashboard provisioning only.
- Gate result: **PASS**.
- Verification date: 2026-08-31 (Asia/Shanghai).

### Implemented modules

- `packages/observability`: typed Pino business logs with centralized redaction, bounded-cardinality
  Prometheus counters/gauges/histograms, OpenTelemetry span correlation, and independently isolated
  best-effort observers.
- `apps/api`: request trace lifecycle, safe HTTP outcome logging/metrics, `GET /metrics`, dependency
  readiness gauges, model-usage observation, and production startup/shutdown composition.
- `packages/agent-runtime` and `packages/executor`: additive safe model-usage, Policy reason-code, and
  Action/Execution correlation fields on existing accepted event streams; no new business event type
  or decision path.
- `infra/observability` and `docker-compose.yml`: pinned Prometheus/Grafana services, scrape config,
  provisioned datasource, and a dashboard with Agent, Safety, Reliability, and Infrastructure rows.
- `tests`: 80 focused logging, metrics, tracing, architecture, R0/R2/R3 integration, and real
  Simulator dependency-failure scenarios plus the Phase 11 Docker smoke.
- `docs/adr/0012-phase-11-observability.md`: logging/redaction, tracing, metric-cardinality,
  isolation, deployment, and phase-boundary decisions.

### Current measured verification

| Check                                      | Current result                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated Phase 11 tests                   | 80 / 80 PASS across 4 files                                                                                                                                      |
| Observability package coverage             | lines 95.53%; branches 73.28%; statements 93.11%; functions 94.52%; required lines >= 90% and branches >= 70% PASS                                               |
| Required trace nodes                       | 15 / 15 defined spans directly asserted; one OpenTelemetry trace ID from HTTP through Runtime, Policy, Confirmation, Executor, Tool, dependency, and persistence |
| R0/R2/R3 observability flow                | PASS; R2 and R3 include confirmation wait, revalidation, Action ID, Execution ID, Tool, Simulator, and persistence correlation                                   |
| Action/Execution association               | 100% for the defined successful R2/R3 flows                                                                                                                      |
| Dependency failure visibility              | Real Simulator HTTP 503, retry, safe error code, failed attempt span, and recovery PASS                                                                          |
| Real Phase 9 PostgreSQL/Redis regression   | 147 PASS; 9 / 9 required Action audit events present; the previously accepted 10,000-case matrix intentionally not rerun                                         |
| Full local regression without DB variables | 2,001 PASS on the final Phase 11 tree; 43 Phase 9 DB cases skipped by their environment gate                                                                     |
| Docker deployment                          | PASS; migration exit 0 and all 8 long-running services healthy in the isolated Phase 11 Compose project                                                          |
| Docker observability smoke                 | PASS: 41 business HTTP requests, 20 Agent runs, 20 executions, Prometheus target up, Grafana datasource OK, 326 structured business logs                         |
| Dashboard validation                       | 4 required rows provisioned; 16 / 16 PromQL panel queries accepted by live Prometheus                                                                            |
| Secret/cardinality scan                    | 0 injected-secret occurrences in logs; 0 forbidden high-cardinality metric labels                                                                                |
| Engineering/security gate                  | format, lint, typecheck, build, diff check PASS; npm audit 0 vulnerabilities                                                                                     |

### Safety and architecture boundary

- Observability is downstream of the primary durable event/audit sinks. Log, metric, and trace
  failures are isolated independently and cannot change Policy decisions, confirmation state,
  execution authorization, retry/idempotency/circuit behavior, or Tool outcomes.
- The side-effect path remains LLM -> Tool Contract -> Policy -> Confirmation/Action state machine ->
  Reliable Executor -> Tool/dependency -> persistence/audit. Direct HTTP/HMI Simulator calls,
  Runtime Executor bypass, RX Tool registration, and direct vehicle actuation added: 0.
- Metrics never label by user, session, run, trace, Action, Execution, prompt, or payload. Logs and
  spans preserve correlation without raw prompts, model reasoning, chain-of-thought, credentials,
  authorization/cookie values, or confirmation/execution secrets.
- Existing Runtime and lifecycle events remain authoritative. The only event-shape changes are
  additive optional safe fields carrying already-existing Policy reason and Action correlation.
- Prometheus, Grafana, and OTLP are not health dependencies. Their failure cannot make the API's
  business health path fail or change a business result.
- `api_key.md` was not read, copied, logged, or used. Provider credentials remain environment-only.

### Review closure and known limitations

- Three focused self-review passes covered trace lifetime/correlation, metric completeness and
  cardinality, and architecture/security boundaries. They found two High trace-lifetime retention
  issues plus relevant Medium Context-conflict attribution and restart-safe pending-gauge gaps.
- All findings were fixed with regression tests: only bounded active Agent parents can cross event
  boundaries, aborted HTTP requests close their spans, the already-existing Policy reason code feeds
  Context conflict metrics/logs/spans, and process-local pending state cannot underflow after restart.
  Final review result: Critical 0, High 0, relevant Medium 0.
- The first registry pull was blocked by Docker Desktop's unavailable local proxy. Official pinned
  images were imported with a SHA256-verified release of `regctl`; Docker Desktop configuration and
  the existing Phase 10 project were not modified.
- Without `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, production creates/ends spans but does not retain or
  export them. Trace hierarchy is validated with the opt-in in-memory test exporter; external trace
  storage and collector deployment remain operator configuration, not a claimed Phase 11 service.
- No new large performance/safety matrix, urgent-event handling, NATS business workflow, evaluation
  harness, or Phase 12 implementation was added. The Stage Gate passed; `main` was not merged.

## Phase 12 — Urgent Event Handling

- Status: COMPLETE.
- Scope: validated urgent-event ingestion, NATS JetStream delivery, PostgreSQL deduplication and
  processing leases, deterministic classification/planning, current Context refresh, existing
  Policy/Confirmation/Executor integration, safe API/HMI notification, and Phase 11 observability.
- Gate result: **PASS**.
- Verification date: 2026-08-31 (Asia/Shanghai).

### Implemented modules

- `packages/urgent-events`: closed immutable event model, deterministic classifier/planner, formal
  safe dispatcher, durable processor, notification hub, observations, and JetStream publisher/
  durable consumer with ACK/NAK/redelivery/DLQ semantics.
- `packages/persistence`: `urgent_events` migration/schema/repository, event fingerprint equality
  binding, atomic processing ownership, expiry recovery, safe result metadata, and runtime-role
  grants.
- `apps/api` and `apps/hmi`: production consumer composition, identity-filtered history/SSE routes,
  safe urgent projections, existing PendingAction confirmation reuse, and urgent status UI.
- `packages/observability`: urgent structured events, three bounded Prometheus metric families, and
  NATS/process/Context/Policy/Executor-or-confirmation trace correlation.
- `docker-compose.yml` and `tests/smoke/phase12-docker-smoke.mjs`: Phase 12 API wiring and repeatable
  real NATS/PostgreSQL/Redis/API/Simulator/Prometheus/Grafana/HMI smoke with restart recovery.
- `docs/adr/0013-phase-12-urgent-event-handling.md`: event, priority, delivery, deduplication,
  Context, safety, notification, observability, and Phase 12/13 boundary decisions.

### Current measured verification

| Check                             | Current result                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated Phase 12 tests          | 92 / 92 PASS across 6 files                                                                                                        |
| Event model/classification        | 45 / 45 PASS, including schema, closed payloads, thresholds, immutability, and canonical fingerprint equality                      |
| NATS ACK/redelivery/DLQ semantics | 9 / 9 focused PASS; real invalid publication reached `driveguard.urgent.dlq`                                                       |
| Durable processor/deduplication   | 13 / 13 PASS; exact duplicate, concurrent duplicate, active lease, restart, and ID-content collision boundaries                    |
| Formal safety integration         | 11 / 11 PASS; R0 Executor, R2 confirmation, current-Context conflict, failed-execution recovery, Context outage, and five RX names |
| Architecture/observability/API    | 14 / 14 PASS; no direct Simulator path, bounded labels, trace parentage, safe history, and user/vehicle notification filtering     |
| Docker clean deployment           | PASS from empty isolated volumes; migration exit 0 and all 8 long-running services healthy                                         |
| Real LOW_SOC flow                 | NATS -> Context -> Policy R2 -> PendingAction -> explicit confirmation -> revalidation/authorization -> Executor SUCCEEDED         |
| Real VEHICLE_FAULT flow           | NATS -> Context -> Policy R3 -> PendingAction; no unconfirmed side effect                                                          |
| Duplicate event side effects      | 0; PostgreSQL attempt count remained 1 and only one action/execution effect was present                                            |
| Invalid event execution / DLQ     | 0 / PASS                                                                                                                           |
| Consumer restart recovery         | PASS; active lease redelivery survived API restart and was reacquired exactly once after expiry (`attempt_count = 2`)              |
| API/HMI/observability             | safe history and live SSE PASS; urgent metrics present; secret leakage 0; forbidden high-cardinality metric label count 0          |
| Full local Phase 0–12 regression  | 2,093 PASS; 43 environment-gated Phase 9 cases skipped in the no-database command                                                  |
| Engineering/security gate         | format, lint, typecheck, build, diff check PASS; npm audit 0 vulnerabilities; `api_key.md` never read                              |

### Safety and architecture boundary

- NATS direct Tool execution = 0 and NATS/HTTP/HMI direct Simulator mutation = 0. Every candidate is
  a registered formal Tool and reaches the existing Policy Engine before any business execution.
- Policy bypass = 0, Confirmation bypass = 0, Executor bypass = 0, and RX execution = 0 in the
  defined architecture and integration sets. CRITICAL events retain the same R2/R3 confirmation
  requirements as non-urgent requests.
- Event payload is not current world state. The processor reloads Context before deterministic
  planning, and the dispatcher refreshes/revalidates it again before Policy. A reported SOC of 5%
  with refreshed SOC of 20% resolves without an action.
- PostgreSQL is the deduplication and lease authority. The validated-event SHA-256 fingerprint binds
  ID equality without storing the payload; same-ID altered content is rejected, and active leases
  use delayed redelivery rather than a terminal ACK.
- Failure before durable ownership, unavailable Context, invalid schema, conflicting event identity,
  missing Tool/profile, failed execution recovery, and exhausted redelivery all fail closed without
  blind Tool execution.
- Prometheus labels use only event type, severity, and status. Original payloads, credentials, user/
  vehicle/session/run/trace/event IDs, secrets, and `api_key.md` are not logged or used as labels.
- Phase 13 benchmark/evaluation implementation and broad event-bus refactoring added: 0. `main` was
  not merged.

### Review closure and known limitations

- Focused self-review covered NATS reliability/restart/DLQ, event-ID equality, Context and safety
  boundaries, persistence ownership, API/HMI projection, metrics cardinality, secrets, and Phase 13
  leakage. It found and fixed: failed recovered executions incorrectly treated as handled; active
  processing redeliveries incorrectly ACKed; broad stream-initialization exception handling; and
  same-ID/different-content claim substitution.
- Each finding has a direct regression test plus real Docker restart/DLQ evidence where applicable.
  Final review result: Critical 0, High 0, safety/reliability-relevant Medium 0.
- The SSE notification hub is process-local; safe history is durable, but missed confirmation
  credentials are intentionally not replayed from history. Production authentication, durable
  notification replay/outbox, multi-user routing, retention operations, and external OTLP storage
  remain future work.
- The Stage Gate passed. Phase 13 was not started and `main` was not merged.

## Phase 13 — Agent Evaluation Benchmark

- Status: COMPLETE; Engineering Gate **PASS**.
- Scope: dual-track official CAR-bench integration and DriveGuard-Native evaluation framework only.
  Phase 14 Safety/Adversarial Evaluation was not started.
- Verification date: 2026-09-01 (Asia/Shanghai).

### Implemented modules

- `evals/external/car-bench`: pinned official metadata, pre-run 125-task compatibility manifest,
  evaluation-only Python adapter, Pi/DeepSeek JSON bridge, and official-run wrapper.
- `evals/native`: versioned 600-case `DriveGuard-Eval-v1.0.0` Ground Truth across ten categories,
  with natural-language prompts, explicit Tool/argument/Policy/confirmation/outcome fields and
  optional Context/fault/urgent data.
- `evals/runner` and `evals/scorers`: deterministic and opt-in live modes, filters, case isolation,
  deterministic core metrics, production Runtime/Policy/Confirmation/Executor and Urgent Processor
  observations, latency collection and typed failure analysis.
- `evals/reports`: separate External, Native and Phase 13 summary outputs; no combined accuracy; an
  append-only long-form `performance-history.csv` records the 2026-09-01 baseline for future
  experiment comparisons.
- `docs/adr/0014-phase-13-agent-evaluation-benchmark.md`: dual-track boundary, original-plan
  refinement, metric, reproducibility, integrity and cost decisions.

### Current measured verification

| Check                           | Current result                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Phase 0–12 preflight regression | 2,093 PASS; 43 existing environment-gated Phase 9 cases skipped                                                 |
| Phase 13 focused tests          | 57 / 57 PASS across 4 files                                                                                     |
| Final full regression           | 2,150 PASS; 43 existing environment-gated Phase 9 cases skipped                                                 |
| Native dataset validation       | 600 / 600 valid; category counts 50/70/70/90/60/50/60/70/45/35                                                  |
| Native benchmark integrity      | 600/600 structured unique; prompt Ground Truth leakage 0; max exact prompt reuse 7                              |
| CAR-bench compatibility         | 125 / 125 generated before model execution                                                                      |
| CAR-bench official final        | Full Test 125/125; Base 56%; Hallucination 14%; Disambiguation 52%; Overall Pass@1 38.40%                       |
| Native live final               | 600/600; run `phase13:d6acfddd-0179-41b2-956e-ec950b34ca2d`; Quality Targets 4/10 HIT                           |
| Native hard safety counters     | Forbidden Action Executed 0; Confirmation Bypass 0; Duplicate Side Effect 0                                     |
| Native Context / Urgent         | Context Refresh Accuracy 100%; Urgent Event Handling Success 100%                                               |
| Native latency                  | Simple p50/p95 2011.40/4121.10 ms; Multi-tool p50/p95 3853.38/10745.26 ms                                       |
| Failure retention               | Native 642 typed records; External all 77 official failures retained, including timeout/upstream simulator rows |

### Gate, integrity and limitations

- CAR-bench official evaluator semantics, tasks and post-result selection were not modified. The
  DeepSeek transport patch preserves original Pydantic validation; Python non-finite diagnostic
  values are normalized to strict JSON `null` only in the aggregate artifact.
- External failures comprise 26 official reward failures without infrastructure error, 24 bounded
  planning bridge timeouts, and 27 official LLM user-simulator `UnboundLocalError` failures. They
  all remain official failures; no case was deleted or reclassified as a pass.
- Native prompts contain zero formal Tool/Policy labels. The final live result follows that fix and
  supersedes earlier diagnostic runs. Required-Tool execution, successful forbidden execution,
  confirmation bypass and duplicate Tool+argument side effects have distinct measured semantics.
- Native quality misses are retained: Normal 55.38%, Tool Selection 51.61%, Argument Validity
  92.06%, Critical Policy Recall 78.39%, Simple p95 4.12s and Multi-tool p95 10.75s. Quality target
  misses do not alter the Engineering Gate or authorize data deletion.
- `api_key.md` was never read. Live credentials were injected only through an interactive process
  environment and removed after each run. The temporary credential must be rotated because a local
  PowerShell type-conversion error included it in terminal diagnostics before the corrected
  SecureString path was used; it was not written into repository artifacts.
- Final validation passed: format, lint, typecheck, build, 57/57 focused tests, 2,150-test full
  regression, diff check, and npm audit with 0 vulnerabilities.
- Review closure: Critical 0, High 0, and benchmark-credibility-relevant Medium 0 after fixing strict
  JSON serialization, prompt Ground Truth leakage, expected REPLAN handling, confirmation-bypass
  attribution, required-Tool execution, forbidden-execution, and duplicate-side-effect semantics.
- Engineering Gate **PASS**; Quality Targets **4/10 HIT**. Phase 14 was not started and `main` was
  not merged.

## Phase 13.1 — Evaluation Calibration & Scorer V2

- Status: COMPLETE; Stage Gate **PASS**.
- Scope: Ground Truth V2, deterministic Scorer V2, trace sufficiency/offline rescore, CAR-bench
  validity taxonomy, isolated Native concurrency, and independent reporting only. Agent prompt,
  Tool descriptions/routing, Policy rules, production confirmation/execution semantics, and Phase
  13.2 optimization were not changed.
- Verification date: 2026-09-02 (Asia/Shanghai).

### Implemented modules

- `evals/native/v2-types.ts`, `evals/native/datasets/v2.ts`, and `v2-validator.ts`: 600 Task
  Contracts with conditional Tool use, typed arguments, action Policy, lifecycle, outcome, recovery,
  and final-response requirements.
- `evals/scorers/argument-matchers.ts` and `evals/scorers/v2.ts`: deterministic action/channel-level
  scoring and Agent/Evaluation/Infrastructure attribution.
- `evals/runner/native-v2-runner.ts`, `v2-cli.ts`, and live trace extensions: ordered output,
  configurable concurrency, five-part identity, independent per-case Simulator, and isolated retry
  semantics.
- `evals/reports/offline-rescore.ts` and CAR-bench classification: explicit legacy trace
  insufficiency, OLD/NEW transition buckets, audit manifests, and independent external validity.
- `13.1-evaluation-calibration-scorer-v2`: design, V1/V2 comparison, baseline status, required
  regression matrix, and frozen generated reports.

### Current measured verification

| Check                       | Current result                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------- |
| V1 preservation             | 600 cases; SHA-256 `3429011c3ed86889812ffcdd66d1c1cc3d1b26bf4bc2eb615381524adcae51a8` |
| V2 schema                   | 600/600 PASS                                                                          |
| Required scorer regressions | 15/15 PASS                                                                            |
| Focused Phase 13.1 suite    | 33/33 PASS across 5 files                                                             |
| Full local regression       | 2,183 PASS across 71 files; 43 existing Phase 9 DB cases environment-gated            |
| Engineering checks          | format, lint, typecheck, build, diff check PASS; npm audit 0 vulnerabilities          |
| Deterministic V2            | 600/600 PASS, concurrency 4; explicitly non-live                                      |
| Live offline rescore        | PASS/PASS 220; PASS/FAIL 84; FAIL/PASS 32; FAIL/FAIL 264; 600/600 scorable            |
| Trace-sufficiency audit     | Critical 199/199; confirmation 151/151; fault 45/45; urgent 35/35                     |
| CAR-bench reclassification  | VALID 48; AGENT 26; INFRA 51; EVALUATOR 0; no rerun/reward change                     |
| Live Native quality         | 600 VALID; case pass 42.00%; concurrency 4; Agent/Eval/Infra errors 869/0/0           |
| Live serial latency         | 600 VALID; concurrency 1; Simple P50/P95 2571.21/6750.62 ms; Multi 3389.41/5635.76 ms |

### Gate and limitations

- Known last-Policy, strict free-text equality, urgent REPLAN execution, fake-verbal-confirmation,
  stale-final-response, and Boolean fault-recovery scorer defects have direct regression coverage.
- Confirmation Bypass, Duplicate Side Effect, and Forbidden Action Executed remain independent hard
  zero counters; classification failure cannot be hidden by downstream safety enforcement.
- Historical V1-only traces remain insufficient, but the frozen 600-case live V2 trace supports the
  complete delta without guessed fields. All Critical, Confirmation, Fault, Urgent, PASS-to-FAIL,
  and scorer-bug FAIL-to-PASS populations were audited at 100% coverage.
- Both credential-backed Native runs completed with benchmark retries 0. Provider-internal retries
  remain unobserved rather than guessed. The three hard safety counters remained zero.
- The phase-level Stage Gate is **PASS**. The frozen baseline identifies real Agent weaknesses for a
  separately authorized Phase 13.2; no optimization was performed here.
- The temporary live credential was injected through no-echo stdin into child-process memory only
  and expired with the process. `api_key.md` was not read or used; no key was persisted or committed.
- `main` remains unchanged and Phase 13.2 was not started.

## Phase 13.2 — Agent Quality Remediation & Reliability Hardening

- Status: IMPLEMENTED LOCALLY; final Stage Gate **FAIL**.
- Scope: recovery, confirmation completion, critical-Policy reachability, goal routing, argument
  binding, final-response synchronization, endpoint configuration, deterministic dev/holdout
  selection, and latency reduction only. Phase 14 was not started.
- Verification date: 2026-09-04 (Asia/Shanghai).

### Implemented modules

- `packages/executor/src/recovery.ts` plus executor/client integration: bounded reads, explicit
  timeout/503/connection/ambiguous/duplicate taxonomy, receipts, reconciliation, and safe stop.
- `packages/agent-runtime/src/goal-router.ts`, `argument-binder.ts`, and `final-response.ts`:
  minimal Tool shortlist, explicit-value canonicalization, frozen confirmation completion, state
  refresh, and response/receipt consistency.
- `evals/native/split.ts` and Phase 13.2 runner commands: deterministic stratified 420/180 split and
  separate development, holdout, and serial-latency output paths.
- `evals/runner/live-provider.ts`: provider availability failures have explicit validity taxonomy;
  Native faults are armed after initial Context loading; formal Tool evidence retains validated
  arguments independently of downstream execution outcome. Scorer V2 and Ground Truth V2 remain
  unchanged.
- `docs/adr/0016-phase-13.2-provider-endpoint-and-recovery.md`: verified installed model/endpoint
  and deterministic recovery decisions.

### Current measured verification

| Check                     | Current result                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest focused regression | 116/116 PASS across 6 files; Tool evidence, confirmation dedup, routing, runner timing and provider validity                                |
| Stage A                   | 840/840 recoverable outcomes; 160/160 safe degradations; blind retry/duplicate effect/empty response 0                                      |
| Stage B                   | 1,000/1,000 ordered confirmation completions; stale and empty response 0; replay effect count 1                                             |
| Critical Policy           | 10,000 cases, 20,000 evaluations, 7,335/7,335 critical correct, mismatch 0                                                                  |
| Goal routing              | 565/565 Agent cases exact; Tool recall/precision 100%/100%; Urgent 35 remains separate                                                      |
| Argument binding          | 548/548 explicit contracts correct                                                                                                          |
| Local planning latency    | 10,000 serial; P50/P95/P99 0.0032/0.0059/0.0151 ms; not end-to-end provider latency                                                         |
| Local hard safety         | 10,000 adversarial Executor runs; all five unsafe counters 0                                                                                |
| Deterministic split       | development 420/420 and holdout 180/180 oracle PASS; explicitly non-live                                                                    |
| Frozen evaluation         | dataset hash unchanged; Scorer V2, GT V2, regression set and hard criteria diff clean                                                       |
| Official live dev round 2 | 420/420 VALID; case 87.38%; normal 93.96%; Tool recall/precision 100%/100%; arguments 95.48%; critical/safety 100%/100%; hard counters 0    |
| Official live dev round 3 | 420/420 VALID; case 89.76%; normal 92.58%; arguments 99.76%; Critical Policy Recall 99.23%; frozen Safe Degradation 83.87%; hard counters 0 |
| Attribution regression    | Post-fix live request 1/1 `INFRA_FAILURE`; quota failure no longer represented as valid Agent data                                          |
| Live holdout/latency/CAR  | NOT RUN: development minimum gate was not met                                                                                               |
| Full regression           | 2,220 PASS across 79 files; 43 existing Phase 9 database cases environment-gated                                                            |

### Gate and limitations

- Format, lint, typecheck, and build pass. One initial full-suite attempt hit the existing 5-second
  timeout on the 600-reset Simulator test; the test passed alone in 2.12 seconds and the complete
  rerun passed it in 4.83 seconds. PostgreSQL/Redis cases remain environment-gated when services are
  absent.
- The deterministic 420/180 runs verify only selection/scorer/report plumbing; they do not measure
  Agent quality or provider latency.
- Official DeepSeek development runs used `https://api.deepseek.com` with model
  `deepseek-v4-flash`; all three complete runs had 420 VALID observations and zero evaluation or
  infrastructure errors.
- Round 2 met every directly comparable minimum quality threshold except the frozen
  `Safe Degradation` aggregate. It reports 25/31 because six applied write timeouts were safely
  reconciled to real success; degradation among cases that actually degraded was 25/25.
- Round 3 corrected failed-Tool schema evidence, but stochastic omission in
  `EXECUTOR_FAULT_RECOVERY-004` reduced Critical Policy Recall to 99.23%, below the exact 100%
  minimum. Per-case benchmark retry or result splicing was not used.
- Frozen evaluation inconsistencies are retained in `evaluation-change-review.md`: blanket failed
  outcomes for successfully reconciled writes, successful `EXECUTED` lifecycle requirements for
  failed fault cases, an all-fault Safe Degradation denominator, and lexical response false
  positives. No Scorer/GT relaxation was made.
- The invalid 420-case attempt is retained in a clearly labelled audit directory. Its pre-fix
  metrics are inadmissible; a live post-fix regression and direct unit tests verify the corrected
  infrastructure attribution.
- Final code-diff review found Critical 0 and High 0; no unresolved safety-boundary issue was found.
- Final Stage Gate is **FAIL**. Holdout, serial latency, and CAR-bench stayed sealed; no Phase 13.2
  commit or merge to `main` was made. Phase 14 was not started.

## Phase 13.2.1 — Gate Stabilization & Reliability Closure

- Status: COMPLETE; final Stage Gate **PASS**.
- Scope: Scorer V2.1 fault semantics, Critical Path Guard, constrained one-to-one plan repair,
  evaluation clock/fault stabilization, three-round Critical and Fault gates, official Development,
  sealed Holdout, serial latency, and external CAR-bench only. Phase 14 was not started.
- Verification date: 2026-09-04 (Asia/Shanghai).

### Implemented modules

- `evals/scorers/v2.1.ts` and reporting: terminal fault states, applicability-specific recovery and
  degradation denominators, and explicit audit counters without Ground Truth weakening.
- Agent Runtime Critical Path Guard and precheck: records mandatory critical capabilities before
  planning and permits one constrained repair of an already resolved one-to-one capability mapping.
- Native runner/evaluator: duplicate-request fault lifetime, provider-latency-safe evaluation clock,
  execution-event recapture, and response-staleness applicability corrections.
- `13.2.1-gate-stabilization`: root-cause evidence, ADR, regression reports, official gate reports,
  CAR-bench raw/aggregate evidence, and final report.

### Measured verification

| Check                | Result                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Critical stability   | 3/3 rounds; 130 cases each; Critical Policy 100%, Safety 100%, hard/audit counters 0                                 |
| Fault V2.1 stability | 3/3 rounds; 31/31 handling, 10/10 recovery, 21/21 safe degradation each round                                        |
| Development          | 420/420; case 90.00%; normal 92.03%; Tool/argument/Policy/Critical/Safety 100%; confirmation 94.59%; hard counters 0 |
| Holdout              | 180/180; case 92.22%; normal 91.03%; all named quality/safety gates 100%; hard counters 0                            |
| Serial latency       | 180/180, concurrency 1; Simple P50/P95 1689.12/3220.14 ms; Multi 2109.48/2564.85 ms                                  |
| External CAR-bench   | 125/125; Raw/Valid Pass@1 41.60%/66.67%; VALID/AGENT/INFRA/EVALUATOR 52/26/47/0                                      |
| Focused regression   | 80/80 PASS across 13 files                                                                                           |
| Full regression      | 2,252 PASS across 83 files; 43 existing environment-gated tests skipped                                              |
| Engineering checks   | format, lint, typecheck, build, diff check, frozen hashes, and secret scan PASS                                      |

### Gate, integrity, and limitations

- Agent code was frozen at `9a62b7df9a114c0dcb5965977b034ad2b90f64da`; later changes were
  limited to evaluation correctness and evidence. The final evaluator correction is
  `49ad013e5a4ed0e75f8cc327cdada7762d1a6f68`.
- The frozen dataset and Scorer V2 hashes remain
  `70ef4ea213bd0d46674b70a4d99334d11e2ec16644777fe5054a6a52278d601f` and
  `d185ee551dcafaef3a87a160f99073c646b2b10f89bc4db3a1b8314093524d4f`.
- CAR-bench remains an independent external track. It used official commit
  `54990894241f2c07e9b523928c2a29e9b693d313`, one trial, no task/evaluator-semantic
  modifications, and no post-result cherry-picking. Its 47 infrastructure failures, dominated by
  upstream user-simulator invalid JSON/`UnboundLocalError` and bridge timeouts, remain raw failures.
- Development retains 51 Agent failures and Holdout 14. Passing the phase gates is not a claim of
  perfect general quality. PostgreSQL/Redis cases remain environment-gated when unavailable.
- Review closure: Critical 0, High 0, unresolved safety-boundary issues 0. The temporary credential
  existed only in the no-echo child process and expired with it; no secret was persisted.
- Final Stage Gate **PASS**. `main` was not merged and Phase 14 was not started.
