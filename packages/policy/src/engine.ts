import {
  CAPABILITY_NAMES,
  CapabilityResolutionContextSchema,
  SERVICE_NAMES,
} from "@driveguard/capabilities";
import type { ContextConflictResult, ContextFreshnessResult } from "@driveguard/context";
import { CONTEXT_RELEVANT_PATHS } from "@driveguard/context";
import {
  parseDrivingContext,
  timestampToEpochMs,
  UtcTimestampSchema,
  type ContextSnapshot,
  type UtcTimestamp,
} from "@driveguard/domain";
import {
  FORMAL_TOOL_NAMES,
  TOOL_RISK_LEVELS,
  type ToolDefinition,
  type ToolRiskLevel,
} from "@driveguard/tools";
import Schema from "typebox/schema";

import {
  createDefaultToolPolicyProfileRegistry,
  type ToolPolicyProfile,
  type ToolPolicyProfileRegistry,
} from "./profiles.js";
import { type PolicyRuleRegistry } from "./registry.js";
import { createDefaultPolicyRuleRegistry } from "./rules.js";
import type {
  PolicyConflictEvidence,
  PolicyDecision,
  PolicyEvidence,
  PolicyFreshnessEvidence,
  PolicyReasonCode,
  PolicyRiskLevel,
  PolicyRule,
  PolicyRuleInput,
} from "./types.js";

const timestampValidator = Schema.Compile(UtcTimestampSchema);
const availabilityValidator = Schema.Compile(CapabilityResolutionContextSchema);
const formalNames = new Set<string>(FORMAL_TOOL_NAMES);
const capabilityNames = new Set<string>(CAPABILITY_NAMES);
const serviceNames = new Set<string>(SERVICE_NAMES);
const contextRelevantPaths = new Set<string>(CONTEXT_RELEVANT_PATHS);
const freshnessStatuses = new Set<string>([
  "FRESH",
  "STALE",
  "INVALID_FUTURE_TIMESTAMP",
  "NOT_LATEST",
]);
const conflictStatuses = new Set<string>([
  "NO_CONFLICT",
  "VERSION_CHANGED_BUT_IRRELEVANT",
  "RELEVANT_STATE_CHANGED",
  "UNKNOWN_RELEVANT_PATH",
]);

interface NormalizedPolicyInput extends PolicyRuleInput {
  readonly contextSnapshotId: string | null;
  readonly contextVersion: number | null;
  readonly evaluatedAt: UtcTimestamp | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function read(value: Record<string, unknown> | undefined, key: string): unknown {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function knownUniqueArray(value: unknown, known: ReadonlySet<string>): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && known.has(entry)) &&
    new Set(value).size === value.length
  );
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validFreshness(
  value: unknown,
  contextVersion: number | null,
  profile: ToolPolicyProfile | undefined,
): value is ContextFreshnessResult {
  const candidate = record(value);
  const status = read(candidate, "status");
  const ageMs = read(candidate, "ageMs");
  const maxAgeMs = read(candidate, "maxAgeMs");
  const snapshotVersion = read(candidate, "snapshotVersion");
  const latestVersion = read(candidate, "latestVersion");
  const structurallyValid =
    typeof status === "string" &&
    freshnessStatuses.has(status) &&
    typeof ageMs === "number" &&
    Number.isFinite(ageMs) &&
    typeof maxAgeMs === "number" &&
    Number.isSafeInteger(maxAgeMs) &&
    maxAgeMs >= 0 &&
    maxAgeMs === profile?.freshnessRequirement.maxAgeMs &&
    typeof snapshotVersion === "number" &&
    Number.isSafeInteger(snapshotVersion) &&
    snapshotVersion === contextVersion &&
    (latestVersion === undefined ||
      (typeof latestVersion === "number" &&
        Number.isSafeInteger(latestVersion) &&
        latestVersion > 0));
  if (!structurallyValid || profile === undefined) return false;
  if (profile.freshnessRequirement.requiresLatest && latestVersion === undefined) return false;
  const expectedStatus =
    ageMs < 0
      ? "INVALID_FUTURE_TIMESTAMP"
      : latestVersion !== undefined && latestVersion !== contextVersion
        ? "NOT_LATEST"
        : ageMs <= maxAgeMs
          ? "FRESH"
          : "STALE";
  return status === expectedStatus;
}

function validConflict(
  value: unknown,
  contextVersion: number | null,
): value is ContextConflictResult {
  if (value === undefined) return false;
  const candidate = record(value);
  const status = read(candidate, "status");
  const planningVersion = read(candidate, "planningVersion");
  const executionVersion = read(candidate, "executionVersion");
  const changedPaths = read(candidate, "changedPaths");
  const unknownPaths = read(candidate, "unknownPaths");
  const versions = record(read(candidate, "versions"));
  const snapshotIdChanged = read(versions, "snapshotIdChanged");
  const contextVersionChanged = read(versions, "contextVersionChanged");
  const vehicleVersionChanged = read(versions, "vehicleVersionChanged");
  const tripVersionChanged = read(versions, "tripVersionChanged");
  const hasVersionChanged = read(versions, "hasVersionChanged");
  const structurallyValid =
    typeof status === "string" &&
    conflictStatuses.has(status) &&
    typeof planningVersion === "number" &&
    Number.isSafeInteger(planningVersion) &&
    planningVersion > 0 &&
    typeof executionVersion === "number" &&
    Number.isSafeInteger(executionVersion) &&
    executionVersion > 0 &&
    executionVersion === contextVersion &&
    Array.isArray(changedPaths) &&
    changedPaths.every((path) => typeof path === "string" && contextRelevantPaths.has(path)) &&
    new Set(changedPaths).size === changedPaths.length &&
    Array.isArray(unknownPaths) &&
    unknownPaths.every((path) => typeof path === "string" && !contextRelevantPaths.has(path)) &&
    new Set(unknownPaths).size === unknownPaths.length &&
    typeof snapshotIdChanged === "boolean" &&
    typeof contextVersionChanged === "boolean" &&
    typeof vehicleVersionChanged === "boolean" &&
    typeof tripVersionChanged === "boolean" &&
    typeof hasVersionChanged === "boolean";
  if (!structurallyValid) return false;
  if (contextVersionChanged !== (planningVersion !== executionVersion)) return false;
  if (
    hasVersionChanged !==
    (snapshotIdChanged || contextVersionChanged || vehicleVersionChanged || tripVersionChanged)
  ) {
    return false;
  }
  const expectedStatus =
    unknownPaths.length > 0
      ? "UNKNOWN_RELEVANT_PATH"
      : changedPaths.length > 0
        ? "RELEVANT_STATE_CHANGED"
        : hasVersionChanged
          ? "VERSION_CHANGED_BUT_IRRELEVANT"
          : "NO_CONFLICT";
  return status === expectedStatus;
}

function validateContext(value: unknown): ContextSnapshot | undefined {
  const candidate = record(value);
  const capturedAt = read(candidate, "capturedAt");
  if (typeof capturedAt !== "string") return undefined;
  try {
    return parseDrivingContext(value, { nowMs: Date.parse(capturedAt) });
  } catch {
    return undefined;
  }
}

function validateDefinition(
  value: unknown,
  profile: ToolPolicyProfile | undefined,
  argumentsValue: unknown,
): { readonly valid: boolean; readonly riskLevel: PolicyRiskLevel } {
  const candidate = record(value);
  const risk = read(candidate, "riskLevel");
  const riskLevel: PolicyRiskLevel =
    typeof risk === "string" && TOOL_RISK_LEVELS.includes(risk as ToolRiskLevel)
      ? (risk as ToolRiskLevel)
      : "UNKNOWN";
  if (candidate === undefined || profile === undefined || riskLevel === "UNKNOWN") {
    return { valid: false, riskLevel };
  }
  const name = read(candidate, "name");
  const sideEffect = read(candidate, "sideEffect");
  const requiredCapabilities = read(candidate, "requiredCapabilities");
  const requiredServices = read(candidate, "requiredServices");
  const inputSchema = read(candidate, "inputSchema");
  const execute = read(candidate, "execute");
  if (
    typeof name !== "string" ||
    !formalNames.has(name) ||
    name !== profile.toolName ||
    riskLevel !== profile.riskLevel ||
    sideEffect !== profile.sideEffect ||
    !knownUniqueArray(requiredCapabilities, capabilityNames) ||
    !knownUniqueArray(requiredServices, serviceNames) ||
    !sameArray(requiredCapabilities, profile.requiredCapabilities) ||
    !sameArray(requiredServices, profile.requiredServices) ||
    typeof execute !== "function" ||
    typeof inputSchema !== "object" ||
    inputSchema === null
  ) {
    return { valid: false, riskLevel };
  }
  try {
    const validator = Schema.Compile((value as ToolDefinition).inputSchema);
    return { valid: validator.Check(argumentsValue), riskLevel };
  } catch {
    return { valid: false, riskLevel };
  }
}

function normalize(
  input: unknown,
  evaluatedAtInput: unknown,
  profiles: ToolPolicyProfileRegistry,
): NormalizedPolicyInput {
  const candidate = record(input);
  const definitionValue = read(candidate, "toolDefinition");
  const definition = record(definitionValue);
  const rawName = read(definition, "name");
  const toolName = typeof rawName === "string" ? rawName : "unknown_tool";
  const profile = profiles.get(toolName);
  const contextValue = read(candidate, "contextSnapshot");
  const contextPresent = contextValue !== undefined && contextValue !== null;
  const context = validateContext(contextValue);
  const contextSnapshotId = context?.snapshotId ?? null;
  const contextVersion = context?.contextVersion ?? null;
  const definitionResult = validateDefinition(
    definitionValue,
    profile,
    read(candidate, "validatedArguments"),
  );
  const availabilityValue = read(candidate, "availability");
  const availabilityValid = availabilityValidator.Check(availabilityValue);
  const availability = availabilityValid ? availabilityValue : undefined;
  const freshnessValue = read(candidate, "freshness");
  const freshnessValid = validFreshness(freshnessValue, contextVersion, profile);
  const conflictValue = read(candidate, "conflict");
  const conflictPresent = conflictValue !== undefined;
  const conflictValid = !conflictPresent || validConflict(conflictValue, contextVersion);
  const evaluatedAt =
    typeof evaluatedAtInput === "string" && timestampValidator.Check(evaluatedAtInput)
      ? evaluatedAtInput
      : null;
  const capabilityAvailable =
    profile !== undefined &&
    availability !== undefined &&
    profile.requiredCapabilities.every((name) => availability.capabilities[name]);
  const serviceAvailable =
    profile !== undefined &&
    availability !== undefined &&
    profile.requiredServices.every((name) => availability.services[name]);
  const freshnessStatus: PolicyFreshnessEvidence = freshnessValid
    ? freshnessValue.status
    : "UNKNOWN";
  const conflictStatus: PolicyConflictEvidence = conflictPresent
    ? conflictValid
      ? conflictValue.status
      : "UNKNOWN"
    : "NOT_EVALUATED";
  const contextChanged =
    conflictPresent && conflictValid ? conflictValue.versions.hasVersionChanged : false;
  const inputValid =
    candidate !== undefined &&
    read(candidate, "trustedDefinition") === true &&
    definitionResult.valid &&
    availabilityValid &&
    (context === undefined || freshnessValid) &&
    conflictValid &&
    evaluatedAt !== null;
  return {
    toolName,
    riskLevel: definitionResult.riskLevel,
    inputValid,
    contextPresent,
    contextValid: context !== undefined,
    capabilityAvailable,
    serviceAvailable,
    freshnessStatus,
    conflictStatus,
    contextChanged,
    contextRequirement: profile?.contextRequirement ?? "UNKNOWN",
    contextSnapshotId,
    contextVersion,
    evaluatedAt,
  };
}

function evidence(input: NormalizedPolicyInput): PolicyEvidence {
  return Object.freeze({
    freshnessStatus: input.freshnessStatus,
    conflictStatus: input.conflictStatus,
    contextChanged: input.contextChanged,
    requiredCapabilityAvailable: input.capabilityAvailable,
    serviceAvailable: input.serviceAvailable,
  });
}

function decision(
  input: NormalizedPolicyInput,
  ruleId: string,
  decisionType: PolicyDecision["decision"],
  reasonCode: PolicyReasonCode,
): PolicyDecision {
  return Object.freeze({
    decision: decisionType,
    ruleId,
    reasonCode,
    toolName: input.toolName,
    riskLevel: input.riskLevel,
    contextSnapshotId: input.contextSnapshotId,
    contextVersion: input.contextVersion,
    evaluatedAt: input.evaluatedAt,
    evidence: evidence(input),
  });
}

export interface PolicyEngineOptions {
  readonly rules?: PolicyRuleRegistry;
  readonly profiles?: ToolPolicyProfileRegistry;
}

/** Pure synchronous rule evaluation: no LLM, prompt, network, database, clock, or random source. */
export class PolicyEngine {
  readonly #rules: readonly PolicyRule[];
  readonly #profiles: ToolPolicyProfileRegistry;

  constructor(options: PolicyEngineOptions = {}) {
    this.#rules = Object.freeze([...(options.rules ?? createDefaultPolicyRuleRegistry()).list()]);
    this.#profiles = options.profiles ?? createDefaultToolPolicyProfileRegistry();
  }

  evaluate(input: unknown, evaluatedAt: unknown): PolicyDecision {
    let normalized: NormalizedPolicyInput;
    try {
      normalized = normalize(input, evaluatedAt, this.#profiles);
    } catch {
      normalized = {
        toolName: "unknown_tool",
        riskLevel: "UNKNOWN",
        inputValid: false,
        contextPresent: false,
        contextValid: false,
        capabilityAvailable: false,
        serviceAvailable: false,
        freshnessStatus: "UNKNOWN",
        conflictStatus: "UNKNOWN",
        contextChanged: false,
        contextRequirement: "UNKNOWN",
        contextSnapshotId: null,
        contextVersion: null,
        evaluatedAt: null,
      };
    }
    try {
      for (const policyRule of this.#rules) {
        if (!policyRule.appliesTo(normalized)) continue;
        const result = policyRule.evaluate(normalized);
        return decision(normalized, policyRule.ruleId, result.decision, result.reasonCode);
      }
      return decision(normalized, "DG-POL-011", "DENY", "DEFAULT_DENY");
    } catch {
      return decision(normalized, "DG-POL-002", "DENY", "POLICY_EXCEPTION");
    }
  }
}

export function policyEvaluationEpoch(decisionValue: PolicyDecision): number | null {
  return decisionValue.evaluatedAt === null
    ? null
    : timestampToEpochMs(decisionValue.evaluatedAt, "evaluatedAt");
}
