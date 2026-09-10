# Repository layout

`DriveGuard/` is the main checkout. Its sibling `DriveGuard_phase/<stage>/` holds registered Git worktrees, each with its own branch/index and shared object history. The stage directory is outside the main checkout, its test discovery and its Docker build context. Both are real directories, not symlinks.

Current reusable source is in apps/, packages/, services/, tests/, evals/, benchmarks/ and infra/. Stage-only documents and raw results are retained in historical phase branches/worktrees, not in main. The original a88b20a tree and all earlier commits remain intact. `git show a88b20a:<old-path>` reads any removed historical artifact.

`DriveGuard_phase/11-observability` contains residual Docker bind-mount assets only; it is not a registered Git worktree. Historical worktrees retain their historical internal paths for reproducibility. The active Phase 15 worktree stores its own evidence under `artifacts/`.

The Phase 14 local image isolation change is preserved on its own branch. Phase 15 FAIL evidence is committed on its own branch, not merged into main. No Phase 16 is started.

For new stages: create a worktree from main, store stage-specific evidence in artifacts/, retain reusable tests in tests/, execute the gate, and merge only accepted reusable changes. If the branch includes artifacts/, make a source-only integration commit/branch and retain the full phase branch for provenance. Never assume a clean git status implies a passing gate.
