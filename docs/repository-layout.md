# Repository layout

`DriveGuard/` is the main checkout. Its sibling `DriveGuard_phase/<stage>/` holds registered Git worktrees, each with its own branch/index and shared object history. The stage directory is outside the main checkout, its test discovery and its Docker build context. Both are real directories, not symlinks.

Current reusable source is in apps/, packages/, services/, tests/, evals/, benchmarks/ and infra/. Stage-only documents and raw results are retained in historical phase branches/worktrees, not in main. The original a88b20a tree and all earlier commits remain intact. `git show a88b20a:<old-path>` reads any removed historical artifact.

`DriveGuard_phase/11-observability` contains residual Docker bind-mount assets only; it is not a
registered Git worktree. Historical worktrees retain their historical internal paths for
reproducibility. Active phase worktrees store stage-only evidence under `artifacts/`.

Historical Phase 14/15 failures remain on their original branches. Later closure phases retain their
own PASS evidence without rewriting those failures. Phase 16–18 accepted source/config/docs were
integrated source-only; their `artifacts/**` trees remain on phase branches.

## Post-release retained worktrees

The 2026-09-14 cleanup review kept four registered worktrees because each still contains unique
uncommitted historical evidence. None is eligible for normal `git worktree remove`, and no force
removal is authorized:

| Worktree                                       |                          Dirty evidence | Retention reason                                                                                                                     |
| ---------------------------------------------- | --------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| `17-staging-release-operational-readiness`     |                      19 untracked files | live PostgreSQL/Redis/JetStream backups, durable upgrade/rollback state, manifest and reports are absent from committed path history |
| `17.1-operational-evidence-security-closure`   |                      11 untracked files | raw SARIF, Trivy and SPDX outputs are absent from committed path history                                                             |
| `18.2-production-release-evidence-closure`     | 3 modified tracked + 14 untracked files | failed-gate source changes, auth smoke, Gitleaks results and release checklist remain uncommitted evidence                           |
| `18.3-least-privilege-storage-release-closure` | 2 modified tracked + 14 untracked files | final gate/smoke, Gitleaks, Trivy and SPDX evidence is the authoritative candidate-scoped security record                            |

`git worktree prune` was run after the review; it removed no registered worktree. Revisit these only
after their exact dirty evidence is committed or otherwise archived and verified.

For any explicitly authorized future maintenance stage: create a worktree from main, store
stage-specific evidence in `artifacts/`, retain reusable tests in `tests/`, execute the gate, and
merge only accepted reusable changes. If the branch includes `artifacts/`, make a source-only
integration commit/branch and retain the full phase branch for provenance. Never assume a clean Git
status implies a passing gate.
