# Phase 13.2.1 — Gate Stabilization & Reliability Closure

Goal: close the remaining Phase 13.2 gate blockers without broad Agent redesign.

# Phase 13.2.1 — Gate Stabilization & Reliability Closure

This phase closes the two blockers left by Phase 13.2 without changing the frozen
DriveGuard-Eval-v2 Ground Truth or the historical Scorer V2 result:

- Scorer V2.1 separates `RECOVERED`, `SAFE_DEGRADED`, and `UNSAFE_OR_INCORRECT`, and uses
  applicability-specific recovery and degradation denominators.
- A deterministic critical capability envelope records Policy coverage before planning and permits
  one constrained repair of an already resolved, one-to-one required Tool mapping.

The original Agent safety boundary is unchanged. RX capabilities are not exposed as LLM Tools, and
all repaired side effects still traverse Policy, confirmation, Reliable Executor, persistence, and
audit paths.

Development gate status: **PASS** on one complete 420-case live observation set rescored in one pass
with the corrected V2.1 aggregation. Agent code was frozen after this result. Holdout, serial
latency, and CAR-bench evidence is recorded in `docs/final-report.md` after execution.

Phase 14 is outside this directory and was not started.
