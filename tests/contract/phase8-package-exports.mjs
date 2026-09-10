import assert from "node:assert/strict";

const executor = await import("@driveguard/executor");

for (const name of [
  "ReliableToolExecutor",
  "RetryPolicy",
  "AbortTimeoutController",
  "IdempotencyManager",
  "CircuitBreaker",
  "ExecutionRecordStore",
  "InMemoryExecutionEventSink",
]) {
  assert.equal(typeof executor[name], "function", `missing runtime export ${name}`);
}

assert.deepEqual(executor.EXECUTION_STATES, [
  "CREATED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "RETRY_EXHAUSTED",
  "OUTCOME_UNKNOWN",
  "REJECTED",
]);

console.log("PHASE8_PACKAGE_EXPORTS PASS");
