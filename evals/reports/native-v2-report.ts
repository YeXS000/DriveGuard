import type { NativeBenchmarkReportV2 } from "../runner/native-v2-runner.js";

function percent(value: number | null): string {
  return value === null ? "N/A / NOT_APPLICABLE" : `${(value * 100).toFixed(2)}%`;
}

export function renderNativeV2Report(report: NativeBenchmarkReportV2): string {
  const metrics = report.metrics;
  const v2_1 = "faultHandlingSuccess" in metrics ? metrics : undefined;
  return `# DriveGuard Native Evaluation V2

- Run ID: \`${report.benchmarkRunId}\`
- Dataset: \`${report.datasetVersion}\`
- Scorer: \`${report.scorerVersion}\`${report.rescoredAt === undefined ? "" : ` (rescored ${report.rescoredAt})`}
- Mode/model/provider: \`${report.mode}\` / \`${report.model}\` / \`${report.provider}\`
- Profile/concurrency: \`${report.profile}\` / \`${report.concurrency}\`
- Comparable to Phase 13 serial latency: \`${report.latencyComparableToPhase13Serial}\`
- Benchmark retries: \`${report.benchmarkRequestRetryCount}\`
- Provider retries: \`${report.providerRetryCount ?? "unobserved"}\`
- Git commit / dirty worktree: \`${report.gitCommit}\` / \`${report.worktreeDirty ?? "unrecorded"}\`

| Metric | V2 result |
| --- | ---: |
| Case Pass Rate | ${percent(metrics.casePassRate)} |
| Normal Task Success | ${percent(metrics.normalTaskSuccess)} |
| Required Tool Recall | ${percent(metrics.requiredToolRecall)} |
| Tool Precision | ${percent(metrics.toolPrecision)} |
| Tool Selection Accuracy (V2 exact Tool Contract) | ${percent(metrics.toolSelectionAccuracy)} |
| Exact Plan Success | ${percent(metrics.exactPlanSuccess)} |
| Missing / Unnecessary Tool Count | ${metrics.missingToolCount} / ${metrics.unnecessaryToolCount} |
| Argument Validity | ${percent(metrics.argumentValidity)} |
| Action-level Policy Accuracy | ${percent(metrics.actionLevelPolicyAccuracy)} |
| Critical Policy Recall | ${percent(metrics.criticalPolicyRecall)} |
| Policy Classification Errors | ${metrics.policyClassificationErrorCount} |
| Confirmation Lifecycle Compliance | ${percent(metrics.confirmationLifecycleCompliance)} |
| Safety Enforcement Accuracy | ${percent(metrics.safetyEnforcementAccuracy)} |
| Recovery Success / Safe Degradation | ${percent(metrics.recoverySuccess)} / ${percent(metrics.safeDegradation)} |
${
  v2_1 === undefined
    ? ""
    : `| Fault Handling Success | ${percent(v2_1.faultHandlingSuccess)} (${v2_1.faultHandlingSuccessfulCount}/${v2_1.validFaultCaseCount}) |
| Recoverable subset | ${v2_1.recoverySuccessfulCount}/${v2_1.recoverableCaseCount} |
| Conditional degradation subset | ${v2_1.safeDegradationSuccessfulCount}/${v2_1.degradationRequiredCaseCount} |
| Recovered / Safe Degraded / Unsafe | ${v2_1.recoveredCount} / ${v2_1.safeDegradedCount} / ${v2_1.unsafeOrIncorrectCount} |
| Blind Ambiguous Retry | ${v2_1.blindAmbiguousRetryCount} |
| False Success Claim | ${v2_1.falseSuccessClaimCount} |
| Empty Response | ${v2_1.emptyResponseCount} |
| Post-execution Response Stale | ${v2_1.postExecutionResponseStaleCount} |`
}
| Outcome Reconciliation / Recovery Safety | ${percent(metrics.outcomeReconciliation)} / ${percent(metrics.recoverySafety)} |
| Final Response Accuracy | ${percent(metrics.finalResponseAccuracy)} |
| Confirmation Bypass | ${metrics.confirmationBypass} |
| Duplicate Side Effect | ${metrics.duplicateSideEffect} |
| Forbidden Action Executed | ${metrics.forbiddenActionExecuted} |
| Agent / Evaluation / Infra errors | ${metrics.agentErrorCount} / ${metrics.evaluationErrorCount} / ${metrics.infraErrorCount} |
| Simple P50 / P95 | ${metrics.simpleTaskP50Ms.toFixed(2)} / ${metrics.simpleTaskP95Ms.toFixed(2)} ms |
| Multi-tool P50 / P95 | ${metrics.multiToolTaskP50Ms.toFixed(2)} / ${metrics.multiToolTaskP95Ms.toFixed(2)} ms |

Native and CAR-bench results are intentionally not averaged.
`;
}
