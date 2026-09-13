# CI and release checks

GitHub Actions runs on pull requests and `main`: reproducible `npm ci`, format, lint, typecheck, targeted policy/confirmation/idempotency/context/isolation regression, the full Vitest suite, build, high-severity npm audit, repository-layout verification, three immutable-SHA Docker image builds, Compose configuration validation, and a committed-secret scan.

Image builds are tagged with `github.sha`; `latest` is never the release identifier. On an operator workstation, set `DRIVEGUARD_IMAGE_TAG` to `git rev-parse HEAD` before `docker compose build`. The manifest records the source SHA, branch, tool versions, fixed base images, image tag, and recorded validation results without reading or serializing any secret.

The PR workflow intentionally excludes soak/load/CAR and live-LLM evaluation. Those are performance or provider qualification workflows, not a packaging regression; their historical evidence must remain separately scoped.

The canonical application image names are `driveguard-api`, `driveguard-simulator`, and
`driveguard-hmi`, matching Compose and release manifests. The latest observed hosted green run is
DriveGuard CI run 34470398420 for source-only main commit
`3c6526f8cbbf07e8ffc4ccf43b40c09286688a57`. Phase 18 and Phase 19 final validation was also
executed locally using the repository commands; a release operator must require a hosted green run
for the eventual authorized integration/tag SHA before publication.
