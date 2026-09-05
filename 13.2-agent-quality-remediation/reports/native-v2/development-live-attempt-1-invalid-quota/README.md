# Invalid development attempt: provider quota exhausted

This 420-case artifact is retained for audit evidence only and is not a valid Agent-quality run.
The supplied endpoint initially succeeded, then returned `insufficient_user_quota` with balance zero
and HTTP 429. The pre-correction live adapter marked those provider failures as `VALID`, so its
quality metrics must not be used for the Phase 13.2 gate.

The proven attribution defect and the runner-only correction are documented in
`../../../docs/evaluation-change-review.md`. Scorer V2 and Ground Truth V2 were not changed.
