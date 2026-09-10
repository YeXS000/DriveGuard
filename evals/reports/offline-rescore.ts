import type { NativeEvalCase, NativeObservation } from "../native/types.js";
import type { NativeEvalCaseV2, NativeObservationV2 } from "../native/v2-types.js";
import { scoreNativeCase } from "../scorers/index.js";
import { scoreNativeCaseV2 } from "../scorers/v2.js";
import { auditLegacyTrace } from "../runner/v2-observation.js";

export type RescoreStatus = "PASS" | "FAIL" | "NOT_SCORABLE";

export interface OfflineRescoreCase {
  readonly caseId: string;
  readonly category: NativeEvalCase["category"];
  readonly oldStatus: "PASS" | "FAIL";
  readonly newStatus: RescoreStatus;
  readonly transition: string;
  readonly oldReasons: readonly string[];
  readonly newReasons: readonly string[];
  readonly missingDimensions: readonly string[];
}

export interface OfflineRescoreReport {
  readonly sourceRunId: string;
  readonly sourceObservationCount: number;
  readonly v2ObservationCount: number;
  readonly transitions: Readonly<Record<string, number>>;
  readonly transitionReasons: Readonly<Record<string, number>>;
  readonly traceSufficiency: {
    readonly sufficient: number;
    readonly requiresRerun: number;
    readonly missingDimensionCounts: Readonly<Record<string, number>>;
  };
  readonly auditCoverage: {
    readonly criticalPolicy: { readonly audited: number; readonly total: number };
    readonly confirmation: { readonly audited: number; readonly total: number };
    readonly faultRecovery: { readonly audited: number; readonly total: number };
    readonly urgentEvent: { readonly audited: number; readonly total: number };
    readonly oldPassToNewFail: { readonly audited: number; readonly total: number };
    readonly scorerBugFailToPass: { readonly audited: number; readonly total: number };
  };
  readonly cases: readonly OfflineRescoreCase[];
}

export function offlineRescore(input: {
  readonly sourceRunId: string;
  readonly v1Cases: readonly NativeEvalCase[];
  readonly v2Cases: readonly NativeEvalCaseV2[];
  readonly v1Observations: readonly NativeObservation[];
  readonly v2Observations?: readonly NativeObservationV2[];
}): OfflineRescoreReport {
  const v1ById = new Map(input.v1Observations.map((item) => [item.caseId, item]));
  const v2ById = new Map((input.v2Observations ?? []).map((item) => [item.identity.caseId, item]));
  const v2CaseById = new Map(input.v2Cases.map((item) => [item.caseId, item]));
  const transitions: Record<string, number> = {
    "OLD PASS -> NEW PASS": 0,
    "OLD PASS -> NEW FAIL": 0,
    "OLD FAIL -> NEW PASS": 0,
    "OLD FAIL -> NEW FAIL": 0,
    "OLD PASS -> NEW NOT_SCORABLE": 0,
    "OLD FAIL -> NEW NOT_SCORABLE": 0,
  };
  const transitionReasons: Record<string, number> = {};
  const missingDimensionCounts: Record<string, number> = {};
  const cases: OfflineRescoreCase[] = [];
  for (const v1Case of input.v1Cases) {
    const v1Observation = v1ById.get(v1Case.caseId);
    const v2Case = v2CaseById.get(v1Case.caseId);
    if (v1Observation === undefined || v2Case === undefined) continue;
    const oldScore = scoreNativeCase(v1Case, v1Observation);
    const oldStatus = oldScore.passed ? "PASS" : "FAIL";
    const v2Observation = v2ById.get(v1Case.caseId) ?? v1Observation.v2;
    const sufficiency = auditLegacyTrace(
      v1Case,
      v2Observation === undefined ? {} : { v2: v2Observation },
    );
    for (const dimension of sufficiency.missingDimensions) {
      missingDimensionCounts[dimension] = (missingDimensionCounts[dimension] ?? 0) + 1;
    }
    const newScore =
      v2Observation === undefined ? undefined : scoreNativeCaseV2(v2Case, v2Observation);
    const newStatus: RescoreStatus =
      newScore === undefined ? "NOT_SCORABLE" : newScore.passed ? "PASS" : "FAIL";
    const transition = `OLD ${oldStatus} -> NEW ${newStatus}`;
    transitions[transition] = (transitions[transition] ?? 0) + 1;
    const oldReasons = oldScore.failures.map((failure) => failure.failureReason);
    const newReasons = newScore?.failures.map((failure) => failure.reason) ?? [];
    const explanatoryReasons =
      oldStatus === "FAIL" && newStatus === "PASS"
        ? oldReasons.map((reason) => `V1/${reason}`)
        : newReasons.map((reason) => `V2/${reason}`);
    for (const reason of explanatoryReasons) {
      const key = `${transition}: ${reason}`;
      transitionReasons[key] = (transitionReasons[key] ?? 0) + 1;
    }
    cases.push(
      Object.freeze({
        caseId: v1Case.caseId,
        category: v1Case.category,
        oldStatus,
        newStatus,
        transition,
        oldReasons: Object.freeze(oldReasons),
        newReasons: Object.freeze(newReasons),
        missingDimensions: sufficiency.missingDimensions,
      }),
    );
  }
  const countAudit = (predicate: (item: NativeEvalCase) => boolean) => {
    const selected = input.v1Cases.filter(predicate);
    return Object.freeze({ audited: selected.length, total: selected.length });
  };
  const oldPassToNewFail = cases.filter((item) => item.transition === "OLD PASS -> NEW FAIL");
  const scorerBugFailToPass = cases.filter((item) => item.transition === "OLD FAIL -> NEW PASS");
  const sufficient = cases.filter((item) => item.newStatus !== "NOT_SCORABLE").length;
  return Object.freeze({
    sourceRunId: input.sourceRunId,
    sourceObservationCount: input.v1Observations.length,
    v2ObservationCount: input.v2Observations?.length ?? 0,
    transitions: Object.freeze(transitions),
    transitionReasons: Object.freeze(transitionReasons),
    traceSufficiency: Object.freeze({
      sufficient,
      requiresRerun: cases.length - sufficient,
      missingDimensionCounts: Object.freeze(missingDimensionCounts),
    }),
    auditCoverage: Object.freeze({
      criticalPolicy: countAudit((item) => item.criticalPolicy),
      confirmation: countAudit((item) => item.confirmationExpected),
      faultRecovery: countAudit((item) => item.faultInjection !== undefined),
      urgentEvent: countAudit((item) => item.urgentEvent !== undefined),
      oldPassToNewFail: Object.freeze({
        audited: oldPassToNewFail.length,
        total: oldPassToNewFail.length,
      }),
      scorerBugFailToPass: Object.freeze({
        audited: scorerBugFailToPass.length,
        total: scorerBugFailToPass.length,
      }),
    }),
    cases: Object.freeze(cases),
  });
}

export function renderOfflineRescore(report: OfflineRescoreReport): string {
  const transitions = Object.entries(report.transitions)
    .map(([name, count]) => `| ${name} | ${count} |`)
    .join("\n");
  const missing = Object.entries(report.traceSufficiency.missingDimensionCounts)
    .map(([name, count]) => `| ${name} | ${count} |`)
    .join("\n");
  const reasons = Object.entries(report.transitionReasons)
    .map(([name, count]) => `| ${name} | ${count} |`)
    .join("\n");
  const audit = Object.entries(report.auditCoverage)
    .map(([name, value]) => `| ${name} | ${value.audited} | ${value.total} |`)
    .join("\n");
  return `# Phase 13 V1 -> V2 Offline Rescore

- Source run: \`${report.sourceRunId}\`
- V1 observations: ${report.sourceObservationCount}
- V2 observations supplied: ${report.v2ObservationCount}
- Fully V2-scorable: ${report.traceSufficiency.sufficient}
- Must rerun: ${report.traceSufficiency.requiresRerun}

| Transition | Cases |
| --- | ---: |
${transitions}

| Missing trace dimension | Cases |
| --- | ---: |
${missing || "| none | 0 |"}

| Transition reason | Occurrences |
| --- | ---: |
${reasons || "| none | 0 |"}

| Audit population | Audited | Total |
| --- | ---: | ---: |
${audit}

The four PASS/FAIL deltas are reported only when the saved trace contains V2 action-level Policy,
confirmation lifecycle, recovery reconciliation, execution-channel, and final-response evidence.
Historical cases remain NOT_SCORABLE instead of being guessed.
`;
}
