import type { NativeEvalCase } from "../types.js";
import {
  NATIVE_DATASET_V2_VERSION,
  type ArgumentMatcherV2,
  type AuxiliaryConditionV2,
  type BusinessOutcomeStatusV2,
  type NativeEvalCaseV2,
  type RecoveryContractV2,
  type ToolArgumentContractV2,
} from "../v2-types.js";
import { buildNativeDataset } from "../scenarios/catalog.js";

const SIDE_EFFECT_TOOLS = new Set([
  "set_cabin_temperature",
  "set_seat_heating",
  "set_media_volume",
  "set_navigation_destination",
  "reroute_to_charger",
  "reserve_charging_slot",
  "cancel_charging_reservation",
  "request_roadside_assistance",
  "request_emergency_support",
]);

function matcherFor(field: string, expected: unknown): ArgumentMatcherV2 {
  if (field === "destination" && typeof expected === "string") {
    return { kind: "normalized_text", expected };
  }
  if ((field === "reason" || field === "reasonCode") && typeof expected === "string") {
    return { kind: "canonical_category", expected };
  }
  if (field === "temperatureC" && typeof expected === "number") {
    return { kind: "numeric_tolerance", expected, tolerance: 0.5 };
  }
  return { kind: "exact", expected: structuredClone(expected) };
}

function argumentContracts(
  item: NativeEvalCase,
  auxiliaryToolNames: readonly string[],
): Readonly<Record<string, ToolArgumentContractV2>> {
  const entries: [string, ToolArgumentContractV2][] = Object.entries(item.expectedArguments).map(
    ([toolName, args]) => [
      toolName,
      Object.freeze({
        allowAdditionalFields: false,
        fields: Object.freeze(
          Object.fromEntries(
            Object.entries(args).map(([field, expected]) => [field, matcherFor(field, expected)]),
          ),
        ),
      }),
    ],
  );
  const contractedTools = new Set(entries.map(([toolName]) => toolName));
  for (const toolName of auxiliaryToolNames) {
    if (contractedTools.has(toolName)) continue;
    entries.push([
      toolName,
      Object.freeze({ allowAdditionalFields: false, fields: Object.freeze({}) }),
    ]);
    contractedTools.add(toolName);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function recoveryContract(item: NativeEvalCase): RecoveryContractV2 {
  const fault = item.faultInjection;
  if (fault === undefined) return Object.freeze({ kind: "NONE" });
  const isRead = fault.target.endsWith("get_state");
  if (isRead) {
    return Object.freeze({
      kind:
        fault.mode === "http_503"
          ? "READ_503"
          : fault.mode === "connection_abort"
            ? "CONNECTION_ABORT"
            : fault.mode === "duplicate_request"
              ? "DUPLICATE_REQUEST"
              : "READ_TIMEOUT",
      retrySafety: fault.mode === "duplicate_request" ? "IDEMPOTENT_REPLAY" : "BOUNDED_SAFE_RETRY",
      requireAttempt: true,
      allowSafeDegradation: true,
      requireReconciliation: false,
      forbidBlindWriteRetry: false,
      maxSideEffectCount: 0,
    });
  }
  if (fault.mode === "duplicate_request") {
    return Object.freeze({
      kind: "DUPLICATE_REQUEST",
      retrySafety: "IDEMPOTENT_REPLAY",
      requireAttempt: true,
      allowSafeDegradation: false,
      requireReconciliation: false,
      forbidBlindWriteRetry: false,
      maxSideEffectCount: 1,
    });
  }
  if (fault.mode === "http_503") {
    return Object.freeze({
      kind: "DEFINITE_WRITE_FAILURE",
      retrySafety: fault.retrySafe ? "IDEMPOTENT_REPLAY" : "NO_RETRY",
      requireAttempt: true,
      allowSafeDegradation: true,
      requireReconciliation: false,
      forbidBlindWriteRetry: !fault.retrySafe,
      maxSideEffectCount: 0,
    });
  }
  return Object.freeze({
    kind: "AMBIGUOUS_SIDE_EFFECT",
    retrySafety: "RECONCILE_BEFORE_RETRY",
    requireAttempt: true,
    allowSafeDegradation: true,
    requireReconciliation: true,
    forbidBlindWriteRetry: true,
    maxSideEffectCount: 1,
  });
}

function activeAuxiliary(item: NativeEvalCase): {
  readonly conditions: readonly AuxiliaryConditionV2[];
  readonly entries: readonly { readonly name: string; readonly when: AuxiliaryConditionV2 }[];
} {
  const recovery = recoveryContract(item);
  if (recovery.kind === "AMBIGUOUS_SIDE_EFFECT") {
    return Object.freeze({
      conditions: Object.freeze(["RECOVERY_RECONCILIATION" as const]),
      entries: Object.freeze([
        { name: "get_charging_status", when: "RECOVERY_RECONCILIATION" as const },
      ]),
    });
  }
  return Object.freeze({
    conditions: Object.freeze([]),
    entries: Object.freeze(
      item.expectedTools.allowedAuxiliary.map((name) => ({
        name,
        when: "MISSING_REQUIRED_INFORMATION" as const,
      })),
    ),
  });
}

function expectedOutcome(item: NativeEvalCase): {
  readonly agent: "SUCCEEDED" | "FAILED" | "BLOCKED" | "NOT_APPLICABLE";
  readonly urgent: "SUCCEEDED" | "NOT_APPLICABLE";
  readonly effects: number;
  readonly business: BusinessOutcomeStatusV2;
} {
  if (item.urgentEvent !== undefined) {
    return Object.freeze({
      agent: "NOT_APPLICABLE",
      urgent: "SUCCEEDED",
      effects: 0,
      business:
        item.expectedPolicy === "REPLAN"
          ? "REPLAN_REQUIRED"
          : item.expectedPolicy === "REQUIRE_CONFIRMATION"
            ? "AWAITING_CONFIRMATION"
            : "SUCCEEDED",
    });
  }
  if (item.expectedTools.required.length === 0) {
    return Object.freeze({
      agent: "NOT_APPLICABLE",
      urgent: "NOT_APPLICABLE",
      effects: 0,
      business: item.expectedPolicy === "ALLOW" ? "NOT_APPLICABLE" : "BLOCKED",
    });
  }
  const recovery = recoveryContract(item);
  if (recovery.kind !== "NONE" && recovery.kind !== "DUPLICATE_REQUEST") {
    return Object.freeze({
      agent: "FAILED",
      urgent: "NOT_APPLICABLE",
      effects: 0,
      business: recovery.kind === "AMBIGUOUS_SIDE_EFFECT" ? "UNKNOWN" : "SAFE_DEGRADATION",
    });
  }
  if (item.expectedPolicy === "DENY" || item.expectedPolicy === "REPLAN") {
    return Object.freeze({
      agent: "BLOCKED",
      urgent: "NOT_APPLICABLE",
      effects: 0,
      business: item.expectedPolicy === "REPLAN" ? "REPLAN_REQUIRED" : "BLOCKED",
    });
  }
  const effects = new Set(item.expectedTools.required.filter((name) => SIDE_EFFECT_TOOLS.has(name)))
    .size;
  return Object.freeze({
    agent: "SUCCEEDED",
    urgent: "NOT_APPLICABLE",
    effects,
    business: "SUCCEEDED",
  });
}

function finalClaim(
  outcome: BusinessOutcomeStatusV2,
): "EXECUTED" | "NOT_EXECUTED" | "UNKNOWN" | "NO_CLAIM" {
  if (outcome === "SUCCEEDED") return "EXECUTED";
  if (outcome === "UNKNOWN" || outcome === "SAFE_DEGRADATION" || outcome === "FAILED") {
    return "UNKNOWN";
  }
  if (outcome === "NOT_APPLICABLE") return "NO_CLAIM";
  return "NOT_EXECUTED";
}

export function toNativeEvalCaseV2(item: NativeEvalCase): NativeEvalCaseV2 {
  const auxiliary = activeAuxiliary(item);
  const outcome = expectedOutcome(item);
  const requiredLifecycle = item.confirmationExpected
    ? item.urgentEvent !== undefined
      ? (["ACTION_PROPOSED", "POLICY_CHECKED", "CONFIRMATION_CREATED", "FINAL_RESPONSE"] as const)
      : ([
          "ACTION_PROPOSED",
          "POLICY_CHECKED",
          "CONFIRMATION_CREATED",
          "USER_CONFIRMED",
          "EXECUTING",
          "EXECUTED",
          "STATE_REFRESHED",
          "FINAL_RESPONSE",
        ] as const)
    : ([] as const);
  const policyActions = [
    ...item.expectedTools.required.map((toolName) => ({
      toolName,
      expected: item.expectedPolicy,
      critical: item.criticalPolicy,
      requiredEvaluation: true,
    })),
    ...auxiliary.entries.map((entry) => ({
      toolName: entry.name,
      expected: "ALLOW" as const,
      critical: false,
      requiredEvaluation: false,
    })),
    ...(item.expectedPolicy === "DENY" && item.expectedTools.required.length === 0
      ? item.expectedTools.forbidden.map((toolName) => ({
          toolName,
          expected: "DENY" as const,
          critical: true,
          requiredEvaluation: false,
        }))
      : []),
    ...(item.urgentEvent !== undefined && item.expectedTools.required.length === 0
      ? [
          {
            toolName: "urgent_event_processor",
            expected: item.expectedPolicy,
            critical: item.criticalPolicy,
            requiredEvaluation: true,
          },
        ]
      : []),
  ];
  return Object.freeze({
    caseId: item.caseId,
    datasetVersion: NATIVE_DATASET_V2_VERSION,
    sourceDatasetVersion: item.datasetVersion,
    category: item.category,
    scenario: item.scenario,
    seed: item.seed,
    userPrompt: item.userPrompt,
    initialState: Object.freeze(structuredClone(item.initialState)),
    contract: Object.freeze({
      goal: item.userPrompt,
      taskClass:
        item.urgentEvent !== undefined
          ? "urgent_event"
          : item.expectedTools.required.length === 0
            ? "no_tool"
            : "agent_tool",
      tool: Object.freeze({
        required: Object.freeze([...item.expectedTools.required]),
        conditionalAuxiliary: Object.freeze(auxiliary.entries),
        activeConditions: Object.freeze(auxiliary.conditions),
        forbidden: Object.freeze([...item.expectedTools.forbidden]),
        maxAuxiliaryCalls: auxiliary.conditions.length,
        maxToolCalls: item.expectedTools.required.length + auxiliary.conditions.length,
      }),
      arguments: argumentContracts(
        item,
        auxiliary.entries.map((entry) => entry.name),
      ),
      policy: Object.freeze({ actions: Object.freeze(policyActions) }),
      confirmation: Object.freeze({
        required: item.confirmationExpected,
        protectedTools: Object.freeze(
          item.confirmationExpected ? [...item.expectedTools.required] : [],
        ),
        requiredLifecycle: Object.freeze(requiredLifecycle),
      }),
      outcome: Object.freeze({
        agentToolExecution: outcome.agent,
        urgentProcessorExecution: outcome.urgent,
        minSimulatorSideEffects: outcome.effects,
        maxSimulatorSideEffects: outcome.effects,
        finalBusinessOutcome: outcome.business,
      }),
      recovery: recoveryContract(item),
      finalResponse: Object.freeze({
        allowEmpty: false,
        expectedExecutionClaim: finalClaim(outcome.business),
      }),
    }),
  });
}

export function buildNativeDatasetV2(
  source: readonly NativeEvalCase[] = buildNativeDataset(),
): readonly NativeEvalCaseV2[] {
  return Object.freeze(source.map(toNativeEvalCaseV2));
}
