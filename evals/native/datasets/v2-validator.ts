import { NATIVE_CATEGORIES } from "../types.js";
import { NATIVE_DATASET_V2_VERSION, type NativeEvalCaseV2 } from "../v2-types.js";

export interface DatasetV2ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly caseCount: number;
}

export function validateNativeDatasetV2(
  cases: readonly NativeEvalCaseV2[],
): DatasetV2ValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.caseId)) errors.push(`${item.caseId}: duplicate caseId`);
    ids.add(item.caseId);
    if (item.datasetVersion !== NATIVE_DATASET_V2_VERSION) {
      errors.push(`${item.caseId}: datasetVersion mismatch`);
    }
    if (!NATIVE_CATEGORIES.includes(item.category)) errors.push(`${item.caseId}: invalid category`);
    if (item.contract.goal.trim().length === 0) errors.push(`${item.caseId}: empty goal`);
    const tool = item.contract.tool;
    if (!Number.isSafeInteger(tool.maxToolCalls) || tool.maxToolCalls < 0) {
      errors.push(`${item.caseId}: invalid maxToolCalls`);
    }
    if (!Number.isSafeInteger(tool.maxAuxiliaryCalls) || tool.maxAuxiliaryCalls < 0) {
      errors.push(`${item.caseId}: invalid maxAuxiliaryCalls`);
    }
    const required = new Set(tool.required);
    const forbidden = new Set(tool.forbidden);
    if (required.size !== tool.required.length)
      errors.push(`${item.caseId}: duplicate required Tool`);
    for (const name of required) {
      if (forbidden.has(name))
        errors.push(`${item.caseId}: required/forbidden overlap for ${name}`);
      if (!(name in item.contract.arguments)) {
        errors.push(`${item.caseId}: missing argument contract for ${name}`);
      }
    }
    const conditionalKeys = new Set<string>();
    for (const auxiliary of tool.conditionalAuxiliary) {
      const key = `${auxiliary.name}:${auxiliary.when}`;
      if (conditionalKeys.has(key))
        errors.push(`${item.caseId}: duplicate conditional auxiliary ${key}`);
      conditionalKeys.add(key);
      if (required.has(auxiliary.name) || forbidden.has(auxiliary.name)) {
        errors.push(`${item.caseId}: conditional Tool overlap for ${auxiliary.name}`);
      }
      if (!(auxiliary.name in item.contract.arguments)) {
        errors.push(`${item.caseId}: missing argument contract for ${auxiliary.name}`);
      }
    }
    if (
      item.contract.confirmation.required !==
      item.contract.confirmation.requiredLifecycle.length > 0
    ) {
      errors.push(`${item.caseId}: confirmation lifecycle contradiction`);
    }
    if (item.contract.recovery.kind === "NONE" && item.category === "executor_fault_recovery") {
      errors.push(`${item.caseId}: fault case has no recovery contract`);
    }
    if (item.contract.recovery.kind !== "NONE" && item.category !== "executor_fault_recovery") {
      errors.push(`${item.caseId}: recovery contract outside fault category`);
    }
  }
  if (cases.length !== 600) errors.push(`expected 600 cases, got ${cases.length}`);
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    caseCount: cases.length,
  });
}
