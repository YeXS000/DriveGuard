import type { ToolDefinition } from "@driveguard/tools";

import { canonicalSerialize } from "./canonical.js";

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return canonicalSerialize(value);
}

export function createConfirmationSummary(
  definition: Pick<ToolDefinition, "label" | "riskLevel">,
  validatedArguments: unknown,
): string {
  const argumentText =
    typeof validatedArguments === "object" &&
    validatedArguments !== null &&
    !Array.isArray(validatedArguments)
      ? Object.keys(validatedArguments)
          .sort()
          .map((key) => `${key}=${displayValue(Reflect.get(validatedArguments, key))}`)
          .join(", ")
      : displayValue(validatedArguments);
  const details = argumentText.length === 0 ? "no arguments" : argumentText;
  return `${definition.label}: ${details}. Risk ${definition.riskLevel}.`;
}
