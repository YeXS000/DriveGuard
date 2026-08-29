import { createActionFingerprint } from "./canonical.js";
import { ActionLifecycleError } from "./errors.js";
import type { PendingAction } from "./types.js";

export function assertPendingActionIntegrity(action: PendingAction): void {
  const fingerprint = createActionFingerprint({
    toolName: action.toolName,
    validatedArguments: action.validatedArguments,
    sessionId: action.sessionId,
    userId: action.userId,
    vehicleId: action.vehicleId,
    contextSnapshotId: action.contextSnapshotId,
    contextVersion: action.contextVersion,
  });
  if (
    fingerprint !== action.actionFingerprint ||
    action.policyDecision.decision !== "REQUIRE_CONFIRMATION" ||
    action.policyDecision.ruleId !== action.policyRuleId ||
    action.policyDecision.toolName !== action.toolName ||
    action.policyDecision.riskLevel !== action.riskLevel ||
    action.policyDecision.contextSnapshotId !== action.contextSnapshotId ||
    action.policyDecision.contextVersion !== action.contextVersion
  ) {
    throw new ActionLifecycleError(
      "ACTION_INTEGRITY_FAILED",
      "PendingAction integrity validation failed",
      action.actionId,
      action.state,
    );
  }
}
