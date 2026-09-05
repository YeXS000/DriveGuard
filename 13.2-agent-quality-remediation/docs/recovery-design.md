# Recovery Manager Design

Status: **Stage A PASS**

The Recovery Manager classifies operation type, failure type, retry safety, idempotency,
execution receipt, and external state. Ambiguous writes are never blindly retried.

## Decision matrix

| Operation | Failure                        | External state  | Decision                               |
| --------- | ------------------------------ | --------------- | -------------------------------------- |
| Read      | timeout, 503, connection abort | n/a             | bounded same-operation retry           |
| Read      | retry budget exhausted         | n/a             | explicit safe degradation              |
| Write     | definite 503/duplicate request | n/a             | retry only when idempotent and bounded |
| Write     | timeout/connection abort       | not yet checked | reconcile before any retry             |
| Write     | ambiguous                      | `EXECUTED`      | complete from reconciliation receipt   |
| Write     | ambiguous                      | `NOT_EXECUTED`  | retry only when idempotent and bounded |
| Write     | ambiguous                      | `UNKNOWN`       | stop and report unknown outcome        |

Vehicle and trip context reads use the same bounded manager. The reservation reconciler reads the
Simulator's charging state and matches the requested station. Recovery receipts record operation,
failure, attempts, retry count, idempotency-key reuse, action, and reconciliation state without
including credentials or raw dependency errors.

## Measured Stage A gate

Command:

```text
npm exec vitest -- run tests/unit/phase13.2-recovery-manager.test.ts \
  tests/unit/phase13.2-recovery-gate.test.ts \
  tests/integration/phase8-simulator-faults.test.ts \
  tests/unit/phase8-reliability-performance.test.ts
```

Results:

- Phase 13.2 generated fault cases: 1,000
- Recovery-eligible resolved: 840/840 (100%)
- Degradation-eligible safely degraded: 160/160 (100%)
- Duplicate side effects: 0
- Blind write retries: 0
- Empty failure responses: 0
- Regression suite: 18/18 tests passed
- Existing Phase 8 safety/adversarial gate: 10,000 runs, zero unsafe outcomes

Gate result: **PASS**.
