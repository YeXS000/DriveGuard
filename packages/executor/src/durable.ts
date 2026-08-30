import type { ExecutionRecord, ExecutionRequest, ExecutionResult } from "./types.js";

export interface DurableExecutionOwnerResult {
  readonly result: ExecutionResult;
  readonly record: ExecutionRecord;
}

export interface DurableExecutionCoordinator {
  execute(
    request: ExecutionRequest,
    requestBinding: string,
    owner: () => Promise<DurableExecutionOwnerResult>,
  ): Promise<ExecutionResult>;
}
