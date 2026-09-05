import { NATIVE_CATEGORIES, NATIVE_DATASET_VERSION, type NativeEvalCase } from "../types.js";
import { CATEGORY_TARGETS } from "../scenarios/catalog.js";

export interface DatasetValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly caseCount: number;
  readonly categoryCounts: Readonly<Record<string, number>>;
}

const policies = new Set(["ALLOW", "DENY", "REPLAN", "REQUIRE_CONFIRMATION"]);

export function validateNativeDataset(cases: readonly NativeEvalCase[]): DatasetValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  const counts: Record<string, number> = Object.fromEntries(
    NATIVE_CATEGORIES.map((category) => [category, 0]),
  );

  for (const item of cases) {
    if (ids.has(item.caseId)) errors.push(`duplicate caseId: ${item.caseId}`);
    ids.add(item.caseId);
    if (item.datasetVersion !== NATIVE_DATASET_VERSION) {
      errors.push(`${item.caseId}: datasetVersion mismatch`);
    }
    if (!NATIVE_CATEGORIES.includes(item.category)) {
      errors.push(`${item.caseId}: unknown category`);
    } else {
      counts[item.category] = (counts[item.category] ?? 0) + 1;
    }
    if (!Number.isSafeInteger(item.seed) || item.seed < 0)
      errors.push(`${item.caseId}: invalid seed`);
    if (item.scenario.length === 0) errors.push(`${item.caseId}: scenario is empty`);
    if (item.userPrompt.trim().length === 0) errors.push(`${item.caseId}: prompt is empty`);
    if (!policies.has(item.expectedPolicy)) errors.push(`${item.caseId}: invalid policy`);
    if (item.confirmationExpected !== (item.expectedPolicy === "REQUIRE_CONFIRMATION")) {
      errors.push(`${item.caseId}: confirmationExpected contradicts policy`);
    }
    const required = new Set(item.expectedTools.required);
    const allowed = new Set(item.expectedTools.allowedAuxiliary);
    const forbidden = new Set(item.expectedTools.forbidden);
    if (required.size !== item.expectedTools.required.length) {
      errors.push(`${item.caseId}: duplicate required Tool`);
    }
    for (const tool of required) {
      if (allowed.has(tool) || forbidden.has(tool)) {
        errors.push(`${item.caseId}: Tool set overlap for ${tool}`);
      }
      if (!(tool in item.expectedArguments)) {
        errors.push(`${item.caseId}: missing expected arguments for ${tool}`);
      }
    }
    for (const tool of allowed) {
      if (forbidden.has(tool)) errors.push(`${item.caseId}: allowed/forbidden overlap for ${tool}`);
    }
    if (
      item.contextMutation !== undefined &&
      item.contextMutation.before === item.contextMutation.after
    ) {
      errors.push(`${item.caseId}: context mutation is not a mutation`);
    }
    if (item.faultInjection !== undefined && item.category !== "executor_fault_recovery") {
      errors.push(`${item.caseId}: fault injection outside fault category`);
    }
    if (item.urgentEvent !== undefined && item.category !== "urgent_event") {
      errors.push(`${item.caseId}: urgent event outside urgent category`);
    }
  }

  for (const category of NATIVE_CATEGORIES) {
    if (counts[category] !== CATEGORY_TARGETS[category]) {
      errors.push(
        `${category}: expected ${CATEGORY_TARGETS[category]}, got ${counts[category] ?? 0}`,
      );
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    caseCount: cases.length,
    categoryCounts: Object.freeze(counts),
  });
}
