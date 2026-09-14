# Repository layout

`DriveGuard/` is the main checkout. Its sibling `DriveGuard_phase/<stage>/` holds registered Git worktrees, each with its own branch/index and shared object history. The stage directory is outside the main checkout, its test discovery and its Docker build context. Both are real directories, not symlinks.

Current reusable source is in apps/, packages/, services/, tests/, evals/, benchmarks/ and infra/. Stage-only documents and raw results are retained in historical phase branches/worktrees, not in main. The original a88b20a tree and all earlier commits remain intact. `git show a88b20a:<old-path>` reads any removed historical artifact.

`DriveGuard_phase/11-observability` contains residual Docker bind-mount assets only; it is not a
registered Git worktree. Historical worktrees retain their historical internal paths for
reproducibility. Active phase worktrees store stage-only evidence under `artifacts/`.

Historical Phase 14/15 failures remain on their original branches. Later closure phases retain their
own PASS evidence without rewriting those failures. Phase 16–18 accepted source/config/docs were
integrated source-only; their `artifacts/**` trees remain on phase branches.

## Post-release worktree closure

The 2026-09-14 repository closure preserved each unique evidence set on its historical phase branch
after a secret scan and integrity review. No phase artifacts were merged into `main`, and no forced
worktree removal was used:

| Historical worktree                            | Evidence commit | Closure disposition                                                                                             |
| ---------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| `17-staging-release-operational-readiness`     | `1777d4b`       | evidence committed and recoverable from the phase branch; worktree removed                                      |
| `17.1-operational-evidence-security-closure`   | `20b69ac`       | retained because running container `/driveguard-phase171-prometheus-1` bind-mounts its Prometheus configuration |
| `18.2-production-release-evidence-closure`     | `02876ae`       | evidence committed and recoverable from the phase branch; worktree removed                                      |
| `18.3-least-privilege-storage-release-closure` | `a7e1f6e`       | evidence committed and recoverable from the phase branch; worktree removed                                      |

`git worktree prune` was run after the safe removals. The one remaining worktree is clean and has a
live runtime dependency; it must be revisited only after that container is intentionally retired.

For any explicitly authorized future maintenance stage: create a worktree from main, store
stage-specific evidence in `artifacts/`, retain reusable tests in `tests/`, execute the gate, and
merge only accepted reusable changes. If the branch includes `artifacts/`, make a source-only
integration commit/branch and retain the full phase branch for provenance. Never assume a clean Git
status implies a passing gate.
