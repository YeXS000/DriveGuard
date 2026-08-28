import {
  ConfirmationService,
  ContextRevalidator,
  InMemoryActionLifecycleEventSink,
  type CreatePendingActionCommand,
} from "@driveguard/action-lifecycle";
import type { CapabilityResolutionContext } from "@driveguard/capabilities";
import { ContextFreshnessEvaluator } from "@driveguard/context";
import type { ContextSnapshot } from "@driveguard/domain";
import { PolicyEngine, createDefaultToolPolicyProfileRegistry } from "@driveguard/policy";
import type { Clock } from "@driveguard/shared";
import type { FormalToolName } from "@driveguard/tools";

import { createValidSnapshot, PHASE_2_NOW } from "./phase2-domain.js";
import { createOfflineRegistry, FULL_CAPABILITY_CONTEXT } from "./phase4-tools.js";
import { PHASE6_VALID_ARGUMENTS, policyInput } from "./phase6-policy.js";

export const PHASE7_NOW_MS = Date.parse(PHASE_2_NOW);

export class MutableClock implements Clock {
  valueMs: number;

  constructor(valueMs = PHASE7_NOW_MS) {
    this.valueMs = valueMs;
  }

  nowMs(): number {
    return this.valueMs;
  }

  advance(ms: number): void {
    this.valueMs += ms;
  }
}

export interface Phase7Harness {
  readonly clock: MutableClock;
  readonly service: ConfirmationService;
  readonly events: InMemoryActionLifecycleEventSink;
  readonly revalidator: ContextRevalidator;
  readonly command: (toolName?: FormalToolName) => CreatePendingActionCommand;
  setCurrent(snapshot: ContextSnapshot): void;
  setAvailability(availability: CapabilityResolutionContext): void;
  setLatest(version: unknown): void;
}

export function createPhase7Harness(
  options: {
    readonly withEvents?: boolean;
  } = {},
): Phase7Harness {
  const clock = new MutableClock();
  const registry = createOfflineRegistry();
  const profiles = createDefaultToolPolicyProfileRegistry();
  const events = new InMemoryActionLifecycleEventSink();
  let current = createValidSnapshot();
  let latest: unknown = current.contextVersion;
  let availability: CapabilityResolutionContext = FULL_CAPABILITY_CONTEXT;
  let sequence = 0;
  const next = (prefix: string): string => `${prefix}:${++sequence}`;
  const revalidator = new ContextRevalidator({
    freshnessEvaluator: new ContextFreshnessEvaluator(clock),
    profiles,
    definitionProvider: (toolName) => registry.get(toolName),
    currentContextProvider: () =>
      Promise.resolve({ snapshot: current, latestContextVersion: latest, availability }),
  });
  const service = new ConfirmationService({
    clock,
    revalidator,
    isTrustedDefinition: (definition) => registry.get(definition.name) === definition,
    ...(options.withEvents === false ? {} : { eventSink: events }),
    actionIdFactory: () => next("action"),
    confirmationIdFactory: () => next("confirmation"),
    authorizationIdFactory: () => next("authorization"),
    eventIdFactory: () => next("event"),
    tokenGenerator: () => `deterministic-token-${next("token")}`,
  });
  return {
    clock,
    service,
    events,
    revalidator,
    command: (toolName = "reserve_charging_slot") => {
      const definition = registry.get(toolName);
      if (definition === undefined) throw new Error(`Missing definition ${toolName}`);
      if (definition.riskLevel !== "R2" && definition.riskLevel !== "R3") {
        throw new Error(`Phase 7 fixture requires R2/R3, received ${definition.riskLevel}`);
      }
      const input = policyInput(toolName, { contextSnapshot: current });
      const decision = new PolicyEngine({ profiles }).evaluate(input, PHASE_2_NOW);
      return {
        definition,
        validatedArguments: PHASE6_VALID_ARGUMENTS[toolName],
        runId: "run:phase7",
        sessionId: "session:phase7",
        traceId: "trace:phase7",
        userId: current.user.userId,
        vehicleId: current.vehicle.vehicleId,
        policyDecision: decision,
        contextSnapshot: current,
      };
    },
    setCurrent(snapshot) {
      current = snapshot;
      latest = snapshot.contextVersion;
    },
    setAvailability(value) {
      availability = value;
    },
    setLatest(value) {
      latest = value;
    },
  };
}
