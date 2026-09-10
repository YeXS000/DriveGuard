import {
  DomainValidationError,
  type ContextSnapshot,
  type ContextVersion,
} from "@driveguard/domain";

export const CONTEXT_RELEVANT_PATHS = [
  "snapshotId",
  "contextVersion",
  "capturedAt",
  "vehicle.vehicleId",
  "vehicle.timestamp",
  "vehicle.version",
  "vehicle.speedKph",
  "vehicle.gear",
  "vehicle.driveMode",
  "vehicle.soc",
  "vehicle.chargingState",
  "vehicle.estimatedRangeKm",
  "vehicle.latitude",
  "vehicle.longitude",
  "vehicle.doors.frontLeft",
  "vehicle.doors.frontRight",
  "vehicle.doors.rearLeft",
  "vehicle.doors.rearRight",
  "vehicle.doors.trunk",
  "vehicle.windows.frontLeft",
  "vehicle.windows.frontRight",
  "vehicle.windows.rearLeft",
  "vehicle.windows.rearRight",
  "vehicle.cabinTemperature",
  "vehicle.outsideTemperature",
  "vehicle.occupants",
  "trip.timestamp",
  "trip.version",
  "trip.destination",
  "trip.routeId",
  "trip.remainingDistanceKm",
  "trip.etaMinutes",
  "trip.navigationActive",
  "weather.condition",
  "weather.temperatureC",
  "user.userId",
  "user.role",
  "capabilities.navigation",
  "capabilities.charging",
  "capabilities.cabinTemperature",
  "capabilities.seatHeating",
  "capabilities.media",
  "capabilities.roadsideAssistance",
] as const;

export type ContextRelevantPath = (typeof CONTEXT_RELEVANT_PATHS)[number];

const knownPaths = new Set<string>(CONTEXT_RELEVANT_PATHS);

export interface ContextVersionChanges {
  readonly snapshotIdChanged: boolean;
  readonly contextVersionChanged: boolean;
  readonly vehicleVersionChanged: boolean;
  readonly tripVersionChanged: boolean;
  readonly hasVersionChanged: boolean;
}

export type ContextConflictStatus =
  | "NO_CONFLICT"
  | "VERSION_CHANGED_BUT_IRRELEVANT"
  | "RELEVANT_STATE_CHANGED"
  | "UNKNOWN_RELEVANT_PATH";

export interface ContextConflictResult {
  readonly status: ContextConflictStatus;
  readonly planningVersion: ContextVersion;
  readonly executionVersion: ContextVersion;
  readonly changedPaths: readonly ContextRelevantPath[];
  readonly unknownPaths: readonly string[];
  readonly versions: ContextVersionChanges;
}

function valueAt(snapshot: ContextSnapshot, path: ContextRelevantPath): unknown {
  let value: unknown = snapshot;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = Reflect.get(value, segment);
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftKeys = Reflect.ownKeys(left).sort((a, b) => String(a).localeCompare(String(b)));
  const rightKeys = Reflect.ownKeys(right).sort((a, b) => String(a).localeCompare(String(b)));
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] && deepEqual(Reflect.get(left, key), Reflect.get(right, key)),
  );
}

export class ContextConflictDetector {
  detectVersionChanges(
    planningSnapshot: ContextSnapshot,
    executionSnapshot: ContextSnapshot,
  ): ContextVersionChanges {
    const snapshotIdChanged = planningSnapshot.snapshotId !== executionSnapshot.snapshotId;
    const contextVersionChanged =
      planningSnapshot.contextVersion !== executionSnapshot.contextVersion;
    const vehicleVersionChanged =
      planningSnapshot.vehicle.version !== executionSnapshot.vehicle.version;
    const tripVersionChanged = planningSnapshot.trip.version !== executionSnapshot.trip.version;
    return {
      snapshotIdChanged,
      contextVersionChanged,
      vehicleVersionChanged,
      tripVersionChanged,
      hasVersionChanged:
        snapshotIdChanged || contextVersionChanged || vehicleVersionChanged || tripVersionChanged,
    };
  }

  detect(
    planningSnapshot: ContextSnapshot,
    executionSnapshot: ContextSnapshot,
    relevantPaths: unknown,
  ): ContextConflictResult {
    if (!Array.isArray(relevantPaths)) {
      throw new DomainValidationError([
        {
          code: "INVALID_FIELD",
          path: "relevantPaths",
          message: "relevantPaths must be an array of strings",
        },
      ]);
    }
    const candidates: readonly unknown[] = relevantPaths;
    if (candidates.some((path) => typeof path !== "string")) {
      throw new DomainValidationError([
        {
          code: "INVALID_FIELD",
          path: "relevantPaths",
          message: "relevantPaths must be an array of strings",
        },
      ]);
    }
    const validatedPaths = candidates.filter((path): path is string => typeof path === "string");
    const versions = this.detectVersionChanges(planningSnapshot, executionSnapshot);
    const unknownPaths = [
      ...new Set(validatedPaths.filter((path) => !knownPaths.has(path))),
    ].sort();
    const paths = [
      ...new Set(
        validatedPaths.filter((path): path is ContextRelevantPath => knownPaths.has(path)),
      ),
    ].sort();
    const changedPaths = paths.filter(
      (path) => !deepEqual(valueAt(planningSnapshot, path), valueAt(executionSnapshot, path)),
    );
    const status: ContextConflictStatus =
      unknownPaths.length > 0
        ? "UNKNOWN_RELEVANT_PATH"
        : changedPaths.length > 0
          ? "RELEVANT_STATE_CHANGED"
          : versions.hasVersionChanged
            ? "VERSION_CHANGED_BUT_IRRELEVANT"
            : "NO_CONFLICT";
    return {
      status,
      planningVersion: planningSnapshot.contextVersion,
      executionVersion: executionSnapshot.contextVersion,
      changedPaths,
      unknownPaths,
      versions,
    };
  }
}
