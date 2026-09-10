import type { CapabilityResolutionContext } from "@driveguard/capabilities";
import {
  ContextConflictDetector,
  ContextFreshnessEvaluator,
  type ContextFreshnessResult,
} from "@driveguard/context";
import type { ContextSnapshot } from "@driveguard/domain";
import type { ToolPolicyProfileRegistry } from "@driveguard/policy";
import type { ToolDefinition } from "@driveguard/tools";

import type { ActionRevalidationResult, CurrentActionContext, PendingAction } from "./types.js";

export interface ContextRevalidatorOptions {
  readonly freshnessEvaluator: ContextFreshnessEvaluator;
  readonly conflictDetector?: ContextConflictDetector;
  readonly profiles: ToolPolicyProfileRegistry;
  readonly currentContextProvider: (action: PendingAction) => Promise<CurrentActionContext>;
  readonly definitionProvider: (toolName: string) => ToolDefinition | undefined;
}

function selectFreshness(results: readonly ContextFreshnessResult[]): ContextFreshnessResult {
  const order: Readonly<Record<ContextFreshnessResult["status"], number>> = {
    FRESH: 0,
    STALE: 1,
    NOT_LATEST: 2,
    INVALID_FUTURE_TIMESTAMP: 3,
  };
  return results.reduce((selected, candidate) =>
    order[candidate.status] > order[selected.status] ? candidate : selected,
  );
}

function result(
  status: ActionRevalidationResult["status"],
  reason: ActionRevalidationResult["reason"],
  currentContext: ContextSnapshot | null,
  freshness: ContextFreshnessResult | null,
  conflict: ActionRevalidationResult["conflict"],
): ActionRevalidationResult {
  return Object.freeze({ status, reason, currentContext, freshness, conflict });
}

function requirementsAvailable(
  definition: ToolDefinition,
  availability: CapabilityResolutionContext,
): "AVAILABLE" | "CAPABILITY_UNAVAILABLE" | "SERVICE_UNAVAILABLE" {
  if (!definition.requiredCapabilities.every((name) => availability.capabilities[name])) {
    return "CAPABILITY_UNAVAILABLE";
  }
  if (!definition.requiredServices.every((name) => availability.services[name])) {
    return "SERVICE_UNAVAILABLE";
  }
  return "AVAILABLE";
}

export class ContextRevalidator {
  readonly #freshnessEvaluator: ContextFreshnessEvaluator;
  readonly #conflictDetector: ContextConflictDetector;
  readonly #profiles: ToolPolicyProfileRegistry;
  readonly #currentContextProvider: ContextRevalidatorOptions["currentContextProvider"];
  readonly #definitionProvider: ContextRevalidatorOptions["definitionProvider"];

  constructor(options: ContextRevalidatorOptions) {
    this.#freshnessEvaluator = options.freshnessEvaluator;
    this.#conflictDetector = options.conflictDetector ?? new ContextConflictDetector();
    this.#profiles = options.profiles;
    this.#currentContextProvider = options.currentContextProvider;
    this.#definitionProvider = options.definitionProvider;
  }

  async revalidate(
    action: PendingAction,
    originalContext: ContextSnapshot,
  ): Promise<ActionRevalidationResult> {
    const profile = this.#profiles.get(action.toolName);
    const definition = this.#definitionProvider(action.toolName);
    if (
      profile === undefined ||
      definition === undefined ||
      definition.name !== action.toolName ||
      definition.riskLevel !== action.riskLevel
    ) {
      return result("REPLAN_REQUIRED", "TOOL_UNAVAILABLE", null, null, null);
    }
    let current: CurrentActionContext;
    try {
      current = await this.#currentContextProvider(action);
    } catch {
      return result("REPLAN_REQUIRED", "CONTEXT_RELOAD_FAILED", null, null, null);
    }
    if (
      current.snapshot.user.userId !== action.userId ||
      current.snapshot.vehicle.vehicleId !== action.vehicleId
    ) {
      return result("REPLAN_REQUIRED", "RELEVANT_STATE_CHANGED", current.snapshot, null, null);
    }
    let freshness: ContextFreshnessResult;
    try {
      const latest = profile.freshnessRequirement.requiresLatest
        ? current.latestContextVersion
        : undefined;
      freshness = selectFreshness([
        this.#freshnessEvaluator.evaluate(current.snapshot, profile.freshnessRequirement, latest),
        this.#freshnessEvaluator.evaluate(
          { ...current.snapshot, capturedAt: current.snapshot.vehicle.timestamp },
          profile.freshnessRequirement,
          latest,
        ),
        this.#freshnessEvaluator.evaluate(
          { ...current.snapshot, capturedAt: current.snapshot.trip.timestamp },
          profile.freshnessRequirement,
          latest,
        ),
      ]);
    } catch {
      return result("REPLAN_REQUIRED", "CONTEXT_RELOAD_FAILED", current.snapshot, null, null);
    }
    if (freshness.status !== "FRESH") {
      const reason =
        freshness.status === "STALE"
          ? "CONTEXT_STALE"
          : freshness.status === "NOT_LATEST"
            ? "CONTEXT_NOT_LATEST"
            : "CONTEXT_FUTURE_TIMESTAMP";
      return result("REPLAN_REQUIRED", reason, current.snapshot, freshness, null);
    }
    const conflict = this.#conflictDetector.detect(
      originalContext,
      current.snapshot,
      profile.relevantContextPaths,
    );
    if (conflict.status === "RELEVANT_STATE_CHANGED") {
      return result(
        "REPLAN_REQUIRED",
        "RELEVANT_STATE_CHANGED",
        current.snapshot,
        freshness,
        conflict,
      );
    }
    if (conflict.status === "UNKNOWN_RELEVANT_PATH") {
      return result(
        "REPLAN_REQUIRED",
        "UNKNOWN_RELEVANT_PATH",
        current.snapshot,
        freshness,
        conflict,
      );
    }
    const availability = requirementsAvailable(definition, current.availability);
    if (availability !== "AVAILABLE") {
      return result("REPLAN_REQUIRED", availability, current.snapshot, freshness, conflict);
    }
    return result(
      "VALID",
      conflict.status === "VERSION_CHANGED_BUT_IRRELEVANT"
        ? "IRRELEVANT_VERSION_CHANGE"
        : "UNCHANGED",
      current.snapshot,
      freshness,
      conflict,
    );
  }
}
