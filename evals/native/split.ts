import { createHash } from "node:crypto";

import type { NativeCategory } from "./types.js";
import type { NativeEvalCaseV2 } from "./v2-types.js";

export const PHASE_13_2_SPLIT_VERSION = "DriveGuard-Phase13.2-Split-v1.0.0" as const;
export const PHASE_13_2_SPLIT_SEED = "driveguard-phase13.2-dev-holdout-v1" as const;

export interface SplitPartition {
  readonly count: number;
  readonly byCategory: Readonly<Record<NativeCategory, number>>;
  readonly caseIds: readonly string[];
}

export interface NativeSplitManifest {
  readonly version: typeof PHASE_13_2_SPLIT_VERSION;
  readonly datasetVersion: string;
  readonly datasetSha256: string;
  readonly strategy: {
    readonly kind: "STRATIFIED_DETERMINISTIC_HASH";
    readonly seed: typeof PHASE_13_2_SPLIT_SEED;
    readonly holdoutFraction: 0.3;
    readonly allocation: "LARGEST_REMAINDER";
  };
  readonly development: SplitPartition;
  readonly holdout: SplitPartition;
}

const categories: readonly NativeCategory[] = Object.freeze([
  "cabin_media",
  "charging",
  "executor_fault_recovery",
  "multi_tool",
  "multi_turn_context_refresh",
  "navigation",
  "normal_no_tool",
  "policy_confirmation",
  "urgent_event",
  "vehicle_trip",
]);

function rank(caseId: string): string {
  return createHash("sha256").update(`${PHASE_13_2_SPLIT_SEED}:${caseId}`, "utf8").digest("hex");
}

function categoryCounts(caseIds: readonly string[], byId: ReadonlyMap<string, NativeEvalCaseV2>) {
  const counts = Object.fromEntries(categories.map((category) => [category, 0])) as Record<
    NativeCategory,
    number
  >;
  for (const caseId of caseIds) {
    const item = byId.get(caseId);
    if (item === undefined) throw new Error(`Split contains unknown case ${caseId}`);
    counts[item.category] += 1;
  }
  return Object.freeze(counts);
}

export function createNativeSplitManifest(
  cases: readonly NativeEvalCaseV2[],
  datasetSha256: string,
): NativeSplitManifest {
  if (!/^[a-f0-9]{64}$/u.test(datasetSha256)) throw new Error("Dataset SHA-256 is invalid");
  const byId = new Map(cases.map((item) => [item.caseId, item]));
  if (byId.size !== cases.length) throw new Error("Dataset case IDs must be unique");
  const datasetVersions = new Set(cases.map((item) => item.datasetVersion));
  if (datasetVersions.size !== 1) throw new Error("Dataset version must be uniform");

  const grouped = new Map<NativeCategory, NativeEvalCaseV2[]>(
    categories.map((category) => [category, []]),
  );
  for (const item of cases) grouped.get(item.category)?.push(item);

  const exactHoldout = new Map(
    categories.map((category) => [category, (grouped.get(category)?.length ?? 0) * 0.3]),
  );
  const allocations = new Map(
    categories.map((category) => [category, Math.floor(exactHoldout.get(category) ?? 0)]),
  );
  let remaining =
    Math.round(cases.length * 0.3) - [...allocations.values()].reduce((a, b) => a + b, 0);
  const remainderOrder = [...categories].sort((left, right) => {
    const difference = ((exactHoldout.get(right) ?? 0) % 1) - ((exactHoldout.get(left) ?? 0) % 1);
    return difference === 0 ? left.localeCompare(right) : difference;
  });
  for (const category of remainderOrder) {
    if (remaining === 0) break;
    allocations.set(category, (allocations.get(category) ?? 0) + 1);
    remaining -= 1;
  }

  const holdout: string[] = [];
  const development: string[] = [];
  for (const category of categories) {
    const sorted = [...(grouped.get(category) ?? [])].sort((left, right) => {
      const difference = rank(left.caseId).localeCompare(rank(right.caseId));
      return difference === 0 ? left.caseId.localeCompare(right.caseId) : difference;
    });
    const holdoutCount = allocations.get(category) ?? 0;
    holdout.push(...sorted.slice(0, holdoutCount).map((item) => item.caseId));
    development.push(...sorted.slice(holdoutCount).map((item) => item.caseId));
  }

  return Object.freeze({
    version: PHASE_13_2_SPLIT_VERSION,
    datasetVersion: [...datasetVersions][0] ?? "UNKNOWN",
    datasetSha256,
    strategy: Object.freeze({
      kind: "STRATIFIED_DETERMINISTIC_HASH" as const,
      seed: PHASE_13_2_SPLIT_SEED,
      holdoutFraction: 0.3 as const,
      allocation: "LARGEST_REMAINDER" as const,
    }),
    development: Object.freeze({
      count: development.length,
      byCategory: categoryCounts(development, byId),
      caseIds: Object.freeze(development),
    }),
    holdout: Object.freeze({
      count: holdout.length,
      byCategory: categoryCounts(holdout, byId),
      caseIds: Object.freeze(holdout),
    }),
  });
}
