import type { ToolDefinition, ToolRiskLevel } from "@driveguard/tools";
import Schema from "typebox/schema";

import { ToolArgumentBinder } from "./argument-binder.js";
import type { GoalToolPlan } from "./goal-router.js";

export type CriticalPolicyClass = "ALLOW" | "REQUIRE_CONFIRMATION" | "DENY";

export interface FormalCriticalCapabilityEnvelope {
  readonly domain: string;
  readonly action: string;
  readonly capability: string;
  readonly supported: boolean;
  readonly riskClass: ToolRiskLevel | "CRITICAL_UNSUPPORTED";
  readonly policyClass: CriticalPolicyClass;
  readonly critical: true;
  readonly requiredAction: string;
  readonly toolMapping: string;
  readonly knownArguments: Readonly<Record<string, unknown>>;
  readonly missingArguments: readonly string[];
}

export interface PlanCompletenessResult {
  readonly status: "COMPLETE" | "PLAN_INCOMPLETE";
  readonly missingRequiredActions: readonly string[];
}

export interface ConstrainedRepairAction {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface SemanticCapability {
  readonly domain: string;
  readonly action: string;
  readonly capability: string;
}

const FORMAL_CRITICAL_CAPABILITIES: Readonly<Record<string, SemanticCapability>> = Object.freeze({
  set_navigation_destination: Object.freeze({
    domain: "navigation",
    action: "set_destination",
    capability: "navigation.set_destination",
  }),
  reroute_to_charger: Object.freeze({
    domain: "navigation",
    action: "reroute_to_charger",
    capability: "navigation.reroute_to_charger",
  }),
  reserve_charging_slot: Object.freeze({
    domain: "charging",
    action: "reserve",
    capability: "charging.reserve",
  }),
  cancel_charging_reservation: Object.freeze({
    domain: "charging",
    action: "cancel_reservation",
    capability: "charging.cancel_reservation",
  }),
  request_roadside_assistance: Object.freeze({
    domain: "assistance",
    action: "request_roadside",
    capability: "assistance.request_roadside",
  }),
  request_emergency_support: Object.freeze({
    domain: "assistance",
    action: "request_emergency",
    capability: "assistance.request_emergency",
  }),
});

const UNSUPPORTED_CRITICAL_CAPABILITIES = Object.freeze([
  Object.freeze({
    toolName: "apply_brake",
    pattern: /(?:踩下|控制|施加|apply).{0,8}(?:刹车|制动|brake)/iu,
    action: "apply_brake",
  }),
  Object.freeze({
    toolName: "control_steering",
    pattern: /(?:控制|转动|操纵).{0,8}(?:方向盘|转向|steering)/iu,
    action: "control_steering",
  }),
  Object.freeze({
    toolName: "set_throttle",
    pattern: /(?:控制|踩下|设置).{0,8}(?:油门|throttle)/iu,
    action: "set_throttle",
  }),
  Object.freeze({
    toolName: "disable_aeb",
    pattern: /(?:关闭|禁用|disable).{0,6}AEB/iu,
    action: "disable_aeb",
  }),
  Object.freeze({
    toolName: "disable_esc",
    pattern: /(?:关闭|禁用|disable).{0,6}ESC/iu,
    action: "disable_esc",
  }),
]);

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function requiredFields(definition: ToolDefinition): readonly string[] {
  const schema = record(definition.inputSchema);
  const required = schema.required;
  return Array.isArray(required) && required.every((field) => typeof field === "string")
    ? required
    : [];
}

function missingArguments(
  definition: ToolDefinition,
  argumentsValue: Readonly<Record<string, unknown>>,
): readonly string[] {
  const missing = requiredFields(definition).filter((field) => argumentsValue[field] === undefined);
  try {
    if (Schema.Compile(definition.inputSchema).Check(argumentsValue)) return Object.freeze(missing);
  } catch {
    return Object.freeze(["<invalid-schema>"]);
  }
  return Object.freeze(missing.length > 0 ? missing : ["<invalid-or-unknown>"]);
}

function policyClass(risk: ToolRiskLevel): CriticalPolicyClass {
  return risk === "R2" || risk === "R3" ? "REQUIRE_CONFIRMATION" : "ALLOW";
}

export class CriticalPathGuard {
  #repairAttempted = false;
  readonly #binder = new ToolArgumentBinder();

  resolve(
    prompt: string,
    plan: GoalToolPlan,
    available: readonly ToolDefinition[],
  ): readonly FormalCriticalCapabilityEnvelope[] {
    const byName = new Map(available.map((definition) => [definition.name, definition]));
    const formal = (plan.intentClass === "AMBIGUOUS" ? [] : plan.candidateToolNames).flatMap(
      (toolName) => {
        const semantic = FORMAL_CRITICAL_CAPABILITIES[toolName];
        const definition = byName.get(toolName);
        if (semantic === undefined || definition === undefined) return [];
        const knownArguments = record(this.#binder.bind(toolName, prompt, {}));
        return [
          Object.freeze({
            ...semantic,
            supported: true,
            riskClass: definition.riskLevel,
            policyClass: policyClass(definition.riskLevel),
            critical: true as const,
            requiredAction: toolName,
            toolMapping: toolName,
            knownArguments: Object.freeze({ ...knownArguments }),
            missingArguments: missingArguments(definition, knownArguments),
          }),
        ];
      },
    );
    const unsupported = UNSUPPORTED_CRITICAL_CAPABILITIES.flatMap((entry) =>
      entry.pattern.test(prompt)
        ? [
            Object.freeze({
              domain: "vehicle",
              action: entry.action,
              capability: `vehicle.${entry.action}`,
              supported: false,
              riskClass: "CRITICAL_UNSUPPORTED" as const,
              policyClass: "DENY" as const,
              critical: true as const,
              requiredAction: "DENY",
              toolMapping: entry.toolName,
              knownArguments: Object.freeze({}),
              missingArguments: Object.freeze([]),
            }),
          ]
        : [],
    );
    return Object.freeze([...formal, ...unsupported]);
  }

  validate(
    envelopes: readonly FormalCriticalCapabilityEnvelope[],
    plannedToolNames: readonly string[],
  ): PlanCompletenessResult {
    const planned = new Set(plannedToolNames);
    const missingRequiredActions = envelopes
      .filter((envelope) => envelope.supported && !planned.has(envelope.toolMapping))
      .map((envelope) => envelope.toolMapping);
    return Object.freeze({
      status: missingRequiredActions.length === 0 ? "COMPLETE" : "PLAN_INCOMPLETE",
      missingRequiredActions: Object.freeze(missingRequiredActions),
    });
  }

  constrainedRepair(
    envelopes: readonly FormalCriticalCapabilityEnvelope[],
    plannedToolNames: readonly string[],
  ): readonly ConstrainedRepairAction[] {
    if (this.#repairAttempted) throw new Error("Constrained repair was already attempted");
    this.#repairAttempted = true;
    const missing = new Set(this.validate(envelopes, plannedToolNames).missingRequiredActions);
    const actions = envelopes.flatMap((envelope) => {
      if (!envelope.supported || !missing.has(envelope.toolMapping)) return [];
      if (envelope.missingArguments.length > 0) {
        throw new Error(
          `Cannot safely repair ${envelope.toolMapping}: required arguments are missing`,
        );
      }
      return [
        Object.freeze({
          toolName: envelope.toolMapping,
          arguments: Object.freeze({ ...envelope.knownArguments }),
        }),
      ];
    });
    return Object.freeze(actions);
  }
}
