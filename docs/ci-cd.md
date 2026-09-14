# CI and release checks

GitHub Actions runs on pull requests and `main`: reproducible `npm ci`, format, lint, typecheck, targeted policy/confirmation/idempotency/context/isolation regression, the full Vitest suite, build, high-severity npm audit, repository-layout verification, three immutable-SHA Docker image builds, Compose configuration validation, and a committed-secret scan.

Image builds are tagged with `github.sha`; `latest` is never the release identifier. On an operator workstation, set `DRIVEGUARD_IMAGE_TAG` to `git rev-parse HEAD` before `docker compose build`. The manifest records the source SHA, branch, tool versions, fixed base images, image tag, and recorded validation results without reading or serializing any secret.

The PR workflow intentionally excludes soak/load/CAR and live-LLM evaluation. Those are performance or provider qualification workflows, not a packaging regression; their historical evidence must remain separately scoped.

The canonical application image names are `driveguard-api`, `driveguard-simulator`, and
`driveguard-hmi`, matching Compose and release manifests. DriveGuard CI run
[34764056549](https://github.com/YeXS000/DriveGuard/actions/runs/34764056549) passed for exact source
`87dfe34645b93c64833604bad4ba29029ee3cf00` before the annotated `v1.0.0` tag and GitHub Release
were published. The final local release gate recorded 2,319/2,319 regression and 472/472 critical
safety tests. Load, soak, external benchmark, Trivy, and SBOM evidence retain their separately
documented source scopes.
