import type { Clock } from "@driveguard/shared";
import {
  assertVehicleIdentityUnchanged,
  parseDrivingContext,
  toUtcTimestamp,
  type ContextSnapshot,
} from "@driveguard/domain";
import { ContextSnapshotIdAllocator, ContextVersionAllocator } from "./version.js";

export interface ContextSnapshotSource {
  readonly vehicle: unknown;
  readonly trip: unknown;
  readonly weather: unknown;
  readonly user: unknown;
  readonly capabilities: unknown;
}

export interface ContextSnapshotBuilderOptions {
  readonly clock: Clock;
  readonly versionAllocator: ContextVersionAllocator;
  readonly snapshotIdAllocator: ContextSnapshotIdAllocator;
}

/** Creates validated, cloned and deeply frozen in-process snapshots. */
export class ContextSnapshotBuilder {
  readonly #clock: Clock;
  readonly #versionAllocator: ContextVersionAllocator;
  readonly #snapshotIdAllocator: ContextSnapshotIdAllocator;
  #previousSnapshot: ContextSnapshot | undefined;

  constructor(options: ContextSnapshotBuilderOptions) {
    this.#clock = options.clock;
    this.#versionAllocator = options.versionAllocator;
    this.#snapshotIdAllocator = options.snapshotIdAllocator;
  }

  create(source: ContextSnapshotSource): ContextSnapshot {
    const capturedAtMs = this.#clock.nowMs();
    const capturedAt = toUtcTimestamp(capturedAtMs);
    const candidate = {
      vehicle: source.vehicle,
      trip: source.trip,
      weather: source.weather,
      user: source.user,
      capabilities: source.capabilities,
      capturedAt,
      contextVersion: this.#versionAllocator.next(),
      snapshotId: this.#snapshotIdAllocator.next(),
    };
    const snapshot = parseDrivingContext(candidate, { nowMs: capturedAtMs });
    if (this.#previousSnapshot !== undefined) {
      assertVehicleIdentityUnchanged(this.#previousSnapshot.vehicle, snapshot.vehicle);
    }
    this.#previousSnapshot = snapshot;
    return snapshot;
  }
}
