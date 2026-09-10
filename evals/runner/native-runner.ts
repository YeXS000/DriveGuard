import { randomUUID } from "node:crypto";

import type {
  BenchmarkMode,
  NativeBenchmarkReport,
  NativeCategory,
  NativeEvalCase,
  NativeObservation,
} from "../native/types.js";
import { executeDeterministicCase } from "./deterministic-provider.js";
import { scoreNativeRun } from "../scorers/index.js";

export interface NativeRunFilters {
  readonly category?: NativeCategory;
  readonly caseId?: string;
  readonly limit?: number;
}

export interface NativeRunnerOptions extends NativeRunFilters {
  readonly cases: readonly NativeEvalCase[];
  readonly mode: BenchmarkMode;
  readonly gitCommit: string;
  readonly executeLiveCase?: (item: NativeEvalCase) => Promise<NativeObservation>;
}

export function filterCases(
  cases: readonly NativeEvalCase[],
  filters: NativeRunFilters,
): readonly NativeEvalCase[] {
  let selected = [...cases];
  if (filters.category !== undefined)
    selected = selected.filter((item) => item.category === filters.category);
  if (filters.caseId !== undefined)
    selected = selected.filter((item) => item.caseId === filters.caseId);
  if (filters.limit !== undefined) {
    if (!Number.isSafeInteger(filters.limit) || filters.limit < 1)
      throw new Error("limit must be a positive integer");
    selected = selected.slice(0, filters.limit);
  }
  return Object.freeze(selected);
}

export async function runNativeBenchmark(
  options: NativeRunnerOptions,
): Promise<NativeBenchmarkReport> {
  const selected = filterCases(options.cases, options);
  if (selected.length === 0) throw new Error("No Native cases matched the requested filters");
  if (options.mode === "live" && options.executeLiveCase === undefined) {
    throw new Error("Live mode requires a live case executor backed by deepseekProvider()");
  }
  const startedAt = new Date().toISOString();
  const observations: NativeObservation[] = [];
  for (const item of selected) {
    observations.push(
      options.mode === "deterministic"
        ? executeDeterministicCase(item)
        : await options.executeLiveCase!(item),
    );
  }
  const scored = scoreNativeRun(selected, observations);
  const categoryCounts = Object.fromEntries(
    [...new Set(selected.map((item) => item.category))].map((category) => [
      category,
      selected.filter((item) => item.category === category).length,
    ]),
  ) as Record<NativeCategory, number>;
  return Object.freeze({
    benchmarkRunId: `phase13:${randomUUID()}`,
    gitCommit: options.gitCommit,
    datasetVersion: selected[0]?.datasetVersion ?? "DriveGuard-Eval-v1.0.0",
    mode: options.mode,
    model:
      options.mode === "live"
        ? (process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash")
        : "faux/mock-provider",
    modelConfiguration: Object.freeze({ temperature: 0, trials: 1, fixedSeed: true }),
    startedAt,
    completedAt: new Date().toISOString(),
    caseCount: selected.length,
    categoryCounts: Object.freeze(categoryCounts),
    metrics: scored.metrics,
    failures: scored.failures,
    observations: Object.freeze(observations),
    qualityMetricsAreLive: options.mode === "live",
  });
}
