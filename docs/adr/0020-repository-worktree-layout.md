# ADR 0020: Separate application source from stage worktrees and evidence

Status: Accepted for the user-requested repository organization, 2026-09-08.

## Decision

Keep the stable main checkout at /home/yej/work/Pi/DriveGuard and registered stage worktrees in the sibling /home/yej/work/Pi/DriveGuard_phase directory. Retain shared Git history and independent branch/index state. Keep application source, reusable tests, benchmark tools and infrastructure in conventional directories. Remove numbered stage artifact directories from the current main tree, retaining their original commits and historical worktrees. No history is rewritten.

Stage-specific artifacts stay on stage branches under artifacts/. They must not enter the main integration tree. A phase with such evidence requires a source-only integration branch/commit after its gate passes. `npm run check:layout` checks the staged/tracked integration tree for numbered stage directories, artifacts/ and _phase/. It is an integration check; a phase evidence branch intentionally does not satisfy it.

Moving a worktree is performed with git worktree move. The sibling directory remains a real directory, without a compatibility symlink or duplicate checkout. Historical worktrees remain historical snapshots; their old internal source/artifact paths are retained for reproducibility. The active Phase 15 worktree adopts the new artifact layout while keeping FAIL evidence unmerged.

This change relocates tests/tools and updates their references. It does not alter runtime safety, evaluator semantics, performance thresholds, or the Phase 15 FAIL decision. It does not start Phase 16.
