import type { Clock } from "@driveguard/shared";
import {
  ContextVersionSchema,
  DomainValidationError,
  toUtcTimestamp,
  timestampToEpochMs,
  type ContextSnapshot,
  type ContextVersion,
} from "@driveguard/domain";
import Schema from "typebox/schema";

const contextVersionValidator = Schema.Compile(ContextVersionSchema);

export interface FreshnessRequirement {
  readonly maxAgeMs: number;
  readonly requiresLatest: boolean;
}

export const DEFAULT_FRESHNESS_REQUIREMENTS = Object.freeze({
  readOnly: Object.freeze({ maxAgeMs: 5_000, requiresLatest: false }),
  lowRisk: Object.freeze({ maxAgeMs: 2_000, requiresLatest: false }),
});

export type ContextFreshnessStatus = "FRESH" | "STALE" | "INVALID_FUTURE_TIMESTAMP" | "NOT_LATEST";

export interface ContextFreshnessResult {
  readonly status: ContextFreshnessStatus;
  readonly ageMs: number;
  readonly maxAgeMs: number;
  readonly snapshotVersion: ContextVersion;
  readonly latestVersion?: ContextVersion;
}

function validateRequirement(requirement: FreshnessRequirement): void {
  if (!Number.isSafeInteger(requirement.maxAgeMs) || requirement.maxAgeMs < 0) {
    throw new DomainValidationError([
      {
        code: "OUT_OF_RANGE",
        path: "requirement.maxAgeMs",
        message: "Freshness maxAgeMs must be a non-negative safe integer",
      },
    ]);
  }
  if (typeof requirement.requiresLatest !== "boolean") {
    throw new DomainValidationError([
      {
        code: "INVALID_FIELD",
        path: "requirement.requiresLatest",
        message: "Freshness requiresLatest must be boolean",
      },
    ]);
  }
}

export class ContextFreshnessEvaluator {
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  evaluate(
    snapshot: ContextSnapshot,
    requirement: FreshnessRequirement,
    latestVersion?: unknown,
  ): ContextFreshnessResult {
    validateRequirement(requirement);
    const nowMs = this.#clock.nowMs();
    toUtcTimestamp(nowMs);
    if (requirement.requiresLatest && latestVersion === undefined) {
      throw new DomainValidationError([
        {
          code: "INVALID_FIELD",
          path: "latestVersion",
          message: "latestVersion is required when requiresLatest is true",
        },
      ]);
    }
    let validatedLatestVersion: ContextVersion | undefined;
    if (latestVersion !== undefined) {
      if (!contextVersionValidator.Check(latestVersion)) {
        throw new DomainValidationError([
          {
            code: typeof latestVersion === "number" ? "OUT_OF_RANGE" : "INVALID_FIELD",
            path: "latestVersion",
            message: "latestVersion must be a positive safe integer",
          },
        ]);
      }
      validatedLatestVersion = latestVersion;
    }

    const ageMs = nowMs - timestampToEpochMs(snapshot.capturedAt, "capturedAt");
    const base = {
      ageMs,
      maxAgeMs: requirement.maxAgeMs,
      snapshotVersion: snapshot.contextVersion,
      ...(validatedLatestVersion === undefined ? {} : { latestVersion: validatedLatestVersion }),
    };
    if (ageMs < 0) return { status: "INVALID_FUTURE_TIMESTAMP", ...base };
    if (requirement.requiresLatest && validatedLatestVersion !== snapshot.contextVersion) {
      return { status: "NOT_LATEST", ...base };
    }
    return { status: ageMs <= requirement.maxAgeMs ? "FRESH" : "STALE", ...base };
  }
}
