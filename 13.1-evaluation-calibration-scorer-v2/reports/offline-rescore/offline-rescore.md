# Phase 13 V1 -> V2 Offline Rescore

- Source run: `phase13:d6acfddd-0179-41b2-956e-ec950b34ca2d`
- V1 observations: 600
- V2 observations supplied: 0
- Fully V2-scorable: 0
- Must rerun: 600

| Transition                   | Cases |
| ---------------------------- | ----: |
| OLD PASS -> NEW PASS         |     0 |
| OLD PASS -> NEW FAIL         |     0 |
| OLD FAIL -> NEW PASS         |     0 |
| OLD FAIL -> NEW FAIL         |     0 |
| OLD PASS -> NEW NOT_SCORABLE |   304 |
| OLD FAIL -> NEW NOT_SCORABLE |   296 |

| Missing trace dimension   | Cases |
| ------------------------- | ----: |
| action_level_policy       |   600 |
| final_response            |   600 |
| confirmation_lifecycle    |   151 |
| recovery_reconciliation   |    45 |
| urgent_execution_channels |    35 |

The four PASS/FAIL deltas are reported only when the saved trace contains V2 action-level Policy,
confirmation lifecycle, recovery reconciliation, execution-channel, and final-response evidence.
Historical cases remain NOT_SCORABLE instead of being guessed.
