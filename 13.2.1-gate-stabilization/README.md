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

Final Stage Gate: **PASS**. Development 420/420, Holdout 180/180, serial Holdout latency 180/180,
Critical stability 3/3, Fault V2.1 stability 3/3, and external CAR-bench 125/125 all completed.
Agent code remained frozen after `9a62b7df9a114c0dcb5965977b034ad2b90f64da`. The complete evidence
and limitations are recorded in `docs/final-report.md`.

Phase 14 is outside this directory and was not started.
