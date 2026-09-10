import { createHash } from "node:crypto";

import { ActionLifecycleError } from "./errors.js";

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ActionLifecycleError("INVALID_COMMAND", "Canonical data must be finite");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new ActionLifecycleError("INVALID_COMMAND", "Canonical data must be JSON-compatible");
  }
  if (seen.has(value)) {
    throw new ActionLifecycleError("INVALID_COMMAND", "Canonical data cannot be cyclic");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
      if (ownKeys.some((key) => typeof key === "symbol")) {
        throw new ActionLifecycleError("INVALID_COMMAND", "Canonical arrays cannot have symbols");
      }
      if (
        ownKeys.length !== expectedKeys.length + 1 ||
        ownKeys.some(
          (key) => typeof key === "string" && key !== "length" && !expectedKeys.includes(key),
        ) ||
        expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
      ) {
        throw new ActionLifecycleError(
          "INVALID_COMMAND",
          "Canonical arrays must be dense and cannot have extra properties",
        );
      }
      return `[${value.map((entry) => canonicalValue(entry, seen)).join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ActionLifecycleError("INVALID_COMMAND", "Canonical data must use plain objects");
    }
    const keys = Object.keys(value).sort();
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new ActionLifecycleError("INVALID_COMMAND", "Canonical objects cannot have symbols");
    }
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(Reflect.get(value, key), seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalSerialize(value: unknown): string {
  return canonicalValue(value, new Set());
}

export interface ActionFingerprintInput {
  readonly toolName: string;
  readonly validatedArguments: unknown;
  readonly sessionId: string;
  readonly userId: string;
  readonly vehicleId: string;
  readonly contextSnapshotId: string;
  readonly contextVersion: number;
}

export function createActionFingerprint(input: ActionFingerprintInput): string {
  const canonical = canonicalSerialize({
    toolName: input.toolName,
    validatedArguments: input.validatedArguments,
    sessionId: input.sessionId,
    userId: input.userId,
    vehicleId: input.vehicleId,
    contextSnapshotId: input.contextSnapshotId,
    contextVersion: input.contextVersion,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
