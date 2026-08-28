import { toUtcTimestamp } from "@driveguard/domain";
import {
  type PolicyDecision,
  type PolicyEngine,
  type PolicyEvaluationInput,
} from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import type { ToolDefinition } from "@driveguard/tools";

export const RUNTIME_POLICY_CONTROL_RESULTS = [
  "POLICY_DENIED",
  "POLICY_REPLAN_REQUIRED",
  "POLICY_CONFIRMATION_REQUIRED",
] as const;
export type RuntimePolicyControlResult = (typeof RUNTIME_POLICY_CONTROL_RESULTS)[number];

export const PHASE_6_POLICY_NOTICE =
  "Phase 6 deterministic Policy is enforced; Phase 7 confirmation can authorize READY_FOR_EXECUTION but never executes the Tool." as const;

export class PolicyControlError extends Error {
  readonly code: RuntimePolicyControlResult;
  readonly decision: PolicyDecision;

  constructor(code: RuntimePolicyControlResult, decision: PolicyDecision) {
    super(code);
    this.name = "PolicyControlError";
    this.code = code;
    this.decision = decision;
  }
}

export class PolicyLifecycleError extends Error {
  constructor() {
    super("Policy lifecycle failed safely");
    this.name = "PolicyLifecycleError";
  }
}

export interface PolicyEvaluationLifecycleObserver {
  evaluationStarted(toolName: string): void | Promise<void>;
  decisionMade(decision: PolicyDecision): void | Promise<void>;
  executionBlocked(decision: PolicyDecision): void | Promise<void>;
}

export interface PolicyGuardedToolHandlerOptions {
  readonly engine: PolicyEngine;
  readonly clock: Clock;
  readonly inputProvider: (
    definition: ToolDefinition,
    validatedArguments: unknown,
  ) => PolicyEvaluationInput | Promise<PolicyEvaluationInput>;
  readonly isTrustedDefinition: (definition: ToolDefinition) => boolean;
  readonly observer?: PolicyEvaluationLifecycleObserver;
  readonly confirmationRequired?: (
    definition: ToolDefinition,
    validatedArguments: unknown,
    decision: PolicyDecision,
    input: PolicyEvaluationInput,
  ) => void | Promise<void>;
}

function controlResult(
  decision: Exclude<PolicyDecision["decision"], "ALLOW">,
): RuntimePolicyControlResult {
  switch (decision) {
    case "DENY":
      return "POLICY_DENIED";
    case "REPLAN":
      return "POLICY_REPLAN_REQUIRED";
    case "REQUIRE_CONFIRMATION":
      return "POLICY_CONFIRMATION_REQUIRED";
  }
}

/** The one formal Runtime interception layer between schema validation and Tool execution. */
export class PolicyGuardedToolHandler {
  readonly #engine: PolicyEngine;
  readonly #clock: Clock;
  readonly #inputProvider: PolicyGuardedToolHandlerOptions["inputProvider"];
  readonly #isTrustedDefinition: PolicyGuardedToolHandlerOptions["isTrustedDefinition"];
  readonly #observer: PolicyEvaluationLifecycleObserver | undefined;
  readonly #confirmationRequired: PolicyGuardedToolHandlerOptions["confirmationRequired"];

  constructor(options: PolicyGuardedToolHandlerOptions) {
    this.#engine = options.engine;
    this.#clock = options.clock;
    this.#inputProvider = options.inputProvider;
    this.#isTrustedDefinition = options.isTrustedDefinition;
    this.#observer = options.observer;
    this.#confirmationRequired = options.confirmationRequired;
  }

  async execute<T>(
    definition: ToolDefinition,
    validatedArguments: unknown,
    handler: () => Promise<T>,
  ): Promise<T> {
    const evaluatedAt = toUtcTimestamp(this.#clock.nowMs());
    try {
      await this.#observer?.evaluationStarted(definition.name);
    } catch {
      throw new PolicyLifecycleError();
    }

    let input: unknown;
    let providedInput: PolicyEvaluationInput | undefined;
    try {
      const provided = await this.#inputProvider(definition, validatedArguments);
      providedInput = provided;
      input =
        provided === undefined
          ? {
              toolDefinition: definition,
              validatedArguments,
              trustedDefinition: false,
            }
          : {
              ...provided,
              toolDefinition: definition,
              validatedArguments,
              trustedDefinition: this.#isTrustedDefinition(definition),
            };
    } catch {
      input = {
        toolDefinition: definition,
        validatedArguments,
        trustedDefinition: false,
      };
    }

    const decision = this.#engine.evaluate(input, evaluatedAt);
    try {
      await this.#observer?.decisionMade(decision);
    } catch {
      throw new PolicyLifecycleError();
    }
    if (decision.decision !== "ALLOW") {
      try {
        await this.#observer?.executionBlocked(decision);
      } catch {
        throw new PolicyLifecycleError();
      }
      if (
        decision.decision === "REQUIRE_CONFIRMATION" &&
        providedInput !== undefined &&
        this.#confirmationRequired !== undefined
      ) {
        try {
          await this.#confirmationRequired(definition, validatedArguments, decision, providedInput);
        } catch {
          throw new PolicyLifecycleError();
        }
      }
      throw new PolicyControlError(controlResult(decision.decision), decision);
    }
    return handler();
  }
}
