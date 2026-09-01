# Phase 13 V1 -> V2 Offline Rescore

- Source run: `phase13:d6acfddd-0179-41b2-956e-ec950b34ca2d`
- V1 observations: 600
- V2 observations supplied: 600
- Fully V2-scorable: 600
- Must rerun: 0

| Transition                   | Cases |
| ---------------------------- | ----: |
| OLD PASS -> NEW PASS         |   220 |
| OLD PASS -> NEW FAIL         |    84 |
| OLD FAIL -> NEW PASS         |    32 |
| OLD FAIL -> NEW FAIL         |   264 |
| OLD PASS -> NEW NOT_SCORABLE |     0 |
| OLD FAIL -> NEW NOT_SCORABLE |     0 |

| Missing trace dimension | Cases |
| ----------------------- | ----: |
| none                    |     0 |

| Transition reason                                      | Occurrences |
| ------------------------------------------------------ | ----------: |
| OLD PASS -> NEW FAIL: V2/FINAL_RESPONSE_ERROR          |          22 |
| OLD FAIL -> NEW FAIL: V2/UNNECESSARY_TOOL              |         209 |
| OLD FAIL -> NEW FAIL: V2/FINAL_RESPONSE_ERROR          |          96 |
| OLD PASS -> NEW FAIL: V2/UNNECESSARY_TOOL              |          73 |
| OLD FAIL -> NEW PASS: V1/WRONG_TOOL                    |          24 |
| OLD FAIL -> NEW FAIL: V2/POST_EXECUTION_RESPONSE_STALE |          12 |
| OLD FAIL -> NEW FAIL: V2/CONFIRMATION_ERROR            |         120 |
| OLD PASS -> NEW FAIL: V2/CONFIRMATION_ERROR            |          11 |
| OLD FAIL -> NEW FAIL: V2/MISSING_TOOL                  |          61 |
| OLD FAIL -> NEW FAIL: V2/WRONG_POLICY                  |          66 |
| OLD FAIL -> NEW FAIL: V2/EXECUTION_ERROR               |         103 |
| OLD PASS -> NEW FAIL: V2/WRONG_ARGUMENT                |           7 |
| OLD FAIL -> NEW FAIL: V2/INVALID_SCHEMA                |           7 |
| OLD PASS -> NEW FAIL: V2/POST_EXECUTION_RESPONSE_STALE |           4 |
| OLD FAIL -> NEW FAIL: V2/WRONG_ARGUMENT                |          20 |
| OLD PASS -> NEW FAIL: V2/WRONG_POLICY                  |           7 |
| OLD PASS -> NEW FAIL: V2/EXECUTION_ERROR               |           8 |
| OLD FAIL -> NEW PASS: V1/WRONG_ARGUMENT                |           2 |
| OLD FAIL -> NEW PASS: V1/WRONG_POLICY                  |           5 |
| OLD FAIL -> NEW PASS: V1/EXECUTION_ERROR               |           9 |
| OLD FAIL -> NEW PASS: V1/WRONG_FINAL_RESPONSE          |           5 |
| OLD PASS -> NEW FAIL: V2/MISSING_TOOL                  |           1 |
| OLD FAIL -> NEW FAIL: V2/RECOVERY_ERROR                |          42 |

| Audit population    | Audited | Total |
| ------------------- | ------: | ----: |
| criticalPolicy      |     199 |   199 |
| confirmation        |     151 |   151 |
| faultRecovery       |      45 |    45 |
| urgentEvent         |      35 |    35 |
| oldPassToNewFail    |      84 |    84 |
| scorerBugFailToPass |      32 |    32 |

The four PASS/FAIL deltas are reported only when the saved trace contains V2 action-level Policy,
confirmation lifecycle, recovery reconciliation, execution-channel, and final-response evidence.
Historical cases remain NOT_SCORABLE instead of being guessed.
