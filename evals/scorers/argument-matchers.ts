import { isDeepStrictEqual } from "node:util";

import type { ArgumentMatcherV2, ToolArgumentContractV2 } from "../native/v2-types.js";

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function canonicalCategory(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizedText(value);
  if (/(flattire|tireblowout|tyreblowout|爆胎|轮胎.*(?:破|漏气|故障))/u.test(normalized)) {
    return "FLAT_TIRE";
  }
  if (/(vehiclefault|车辆故障|汽车故障)/u.test(normalized)) return "VEHICLE_FAULT";
  if (/(assistancerequired|需要.*救援|请求.*救援|紧急援助)/u.test(normalized)) {
    return "ASSISTANCE_REQUIRED";
  }
  return normalized.toLocaleUpperCase("und");
}

export function matchesArgument(actual: unknown, matcher: ArgumentMatcherV2): boolean {
  switch (matcher.kind) {
    case "exact":
      return isDeepStrictEqual(actual, matcher.expected);
    case "numeric_tolerance":
      return (
        typeof actual === "number" &&
        Number.isFinite(actual) &&
        Math.abs(actual - matcher.expected) <= matcher.tolerance
      );
    case "normalized_text":
      return (
        typeof actual === "string" && normalizedText(actual) === normalizedText(matcher.expected)
      );
    case "canonical_category":
      return canonicalCategory(actual) === canonicalCategory(matcher.expected);
  }
}

export interface ToolArgumentMatchResult {
  readonly passed: boolean;
  readonly mismatchedFields: readonly string[];
  readonly unexpectedFields: readonly string[];
}

export function matchToolArguments(
  actual: Readonly<Record<string, unknown>>,
  contract: ToolArgumentContractV2,
): ToolArgumentMatchResult {
  const mismatchedFields = Object.entries(contract.fields)
    .filter(([field, matcher]) => !matchesArgument(actual[field], matcher))
    .map(([field]) => field);
  const unexpectedFields = contract.allowAdditionalFields
    ? []
    : Object.keys(actual).filter((field) => !(field in contract.fields));
  return Object.freeze({
    passed: mismatchedFields.length === 0 && unexpectedFields.length === 0,
    mismatchedFields: Object.freeze(mismatchedFields),
    unexpectedFields: Object.freeze(unexpectedFields),
  });
}
