import { timestampToEpochMs } from "@driveguard/domain";

import { ActionLifecycleError } from "./errors.js";
import { createActionFingerprint } from "./canonical.js";
import type { PendingActionRecord } from "./repository.js";
import type { ConsumeExecutionAuthorizationCommand, ExecutionAuthorization } from "./types.js";

export function verifyExecutionAuthorizationForConsumption(
  record: PendingActionRecord,
  command: ConsumeExecutionAuthorizationCommand,
  nowMs: number,
): ExecutionAuthorization {
  const authorization = record.authorization;
  if (record.action.state !== "READY_FOR_EXECUTION" || authorization === null) {
    throw new ActionLifecycleError(
      "AUTHORIZATION_MISMATCH",
      "ExecutionAuthorization is not available for this action",
      command.actionId,
      record.action.state,
    );
  }
  if (record.authorizationConsumedAt != null) {
    throw new ActionLifecycleError(
      "AUTHORIZATION_ALREADY_USED",
      "ExecutionAuthorization was already consumed",
      command.actionId,
      record.action.state,
    );
  }
  if (nowMs >= timestampToEpochMs(authorization.expiresAt, "authorization.expiresAt")) {
    throw new ActionLifecycleError(
      "AUTHORIZATION_EXPIRED",
      "ExecutionAuthorization has expired",
      command.actionId,
      record.action.state,
    );
  }
  let requestedFingerprint: string;
  try {
    requestedFingerprint = createActionFingerprint({
      toolName: command.toolName,
      validatedArguments: command.validatedArguments,
      sessionId: command.sessionId,
      userId: command.userId,
      vehicleId: command.vehicleId,
      contextSnapshotId: record.action.contextSnapshotId,
      contextVersion: record.action.contextVersion,
    });
  } catch {
    throw new ActionLifecycleError(
      "AUTHORIZATION_MISMATCH",
      "Execution arguments do not match the authorized action",
      command.actionId,
      record.action.state,
    );
  }
  if (
    authorization.authorizationId !== command.authorizationId ||
    authorization.actionId !== command.actionId ||
    authorization.actionFingerprint !== command.actionFingerprint ||
    authorization.toolName !== command.toolName ||
    record.action.sessionId !== command.sessionId ||
    record.action.userId !== command.userId ||
    record.action.vehicleId !== command.vehicleId ||
    authorization.contextSnapshotId !== command.contextSnapshotId ||
    authorization.contextVersion !== command.contextVersion ||
    record.action.actionFingerprint !== command.actionFingerprint ||
    requestedFingerprint !== command.actionFingerprint ||
    record.action.toolName !== command.toolName
  ) {
    throw new ActionLifecycleError(
      "AUTHORIZATION_MISMATCH",
      "ExecutionAuthorization does not match the execution request",
      command.actionId,
      record.action.state,
    );
  }
  return authorization;
}
