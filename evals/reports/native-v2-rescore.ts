import type { NativeEvalCaseV2, NativeObservationV2 } from "../native/v2-types.js";
import type { NativeBenchmarkReportV2 } from "../runner/native-v2-runner.js";
import { NATIVE_SCORER_V2_VERSION, scoreNativeRunV2 } from "../scorers/v2.js";
import { NATIVE_SCORER_V2_1_VERSION, scoreNativeRunV2_1 } from "../scorers/v2-1.js";

export function normalizeEvaluationDerivedObservationV2(
  item: NativeEvalCaseV2,
  observation: NativeObservationV2,
): NativeObservationV2 {
  if (
    item.contract.recovery.kind !== "AMBIGUOUS_SIDE_EFFECT" ||
    observation.recovery.outcomeReconciled ||
    observation.execution.agentToolExecution === "SUCCEEDED" ||
    observation.execution.finalBusinessOutcome !== "SAFE_DEGRADATION"
  ) {
    return observation;
  }
  return Object.freeze({
    ...observation,
    execution: Object.freeze({
      ...observation.execution,
      finalBusinessOutcome: "UNKNOWN" as const,
    }),
  });
}

export function rescoreNativeBenchmarkReportV2(
  report: NativeBenchmarkReportV2,
  allCases: readonly NativeEvalCaseV2[],
  rescoredAt = new Date().toISOString(),
): NativeBenchmarkReportV2 {
  const contractById = new Map(allCases.map((item) => [item.caseId, item]));
  const selectedCases = report.observations.map((observation) => {
    const item = contractById.get(observation.identity.caseId);
    if (item === undefined) {
      throw new Error(`Missing V2 Task Contract for ${observation.identity.caseId}`);
    }
    return item;
  });
  if (
    selectedCases.length !== report.caseCount ||
    new Set(selectedCases.map((item) => item.caseId)).size !== selectedCases.length
  ) {
    throw new Error("Report observations must contain one unique identity per declared case");
  }
  const observations = report.observations.map((observation, index) =>
    normalizeEvaluationDerivedObservationV2(selectedCases[index]!, observation),
  );
  const scored = scoreNativeRunV2(selectedCases, observations);
  return Object.freeze({
    ...report,
    scorerVersion: NATIVE_SCORER_V2_VERSION,
    rescoredAt,
    metrics: scored.metrics,
    failures: scored.failures,
    observations: Object.freeze(observations),
  });
}

export function rescoreNativeBenchmarkReportV2_1(
  report: NativeBenchmarkReportV2,
  allCases: readonly NativeEvalCaseV2[],
  rescoredAt = new Date().toISOString(),
): NativeBenchmarkReportV2 {
  const contractById = new Map(allCases.map((item) => [item.caseId, item]));
  const selectedCases = report.observations.map((observation) => {
    const item = contractById.get(observation.identity.caseId);
    if (item === undefined)
      throw new Error(`Missing V2 Task Contract for ${observation.identity.caseId}`);
    return item;
  });
  if (
    selectedCases.length !== report.caseCount ||
    new Set(selectedCases.map((item) => item.caseId)).size !== selectedCases.length
  ) {
    throw new Error("Report observations must contain one unique identity per declared case");
  }
  const observations = report.observations.map((observation, index) =>
    normalizeEvaluationDerivedObservationV2(selectedCases[index]!, observation),
  );
  const scored = scoreNativeRunV2_1(selectedCases, observations);
  return Object.freeze({
    ...report,
    scorerVersion: NATIVE_SCORER_V2_1_VERSION,
    rescoredAt,
    metrics: scored.metrics,
    failures: scored.failures,
    observations: Object.freeze(observations),
  });
}
