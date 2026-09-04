import { randomUUID } from "node:crypto";

import type { NativeEvalCase } from "../native/types.js";
import type {
  NativeCaseIdentityV2,
  NativeEvalCaseV2,
  NativeObservationV2,
} from "../native/v2-types.js";
import {
  NATIVE_SCORER_V2_VERSION,
  scoreNativeRunV2,
  type NativeRunMetricsV2,
} from "../scorers/v2.js";
import { createPerfectV2Observation } from "./v2-observation.js";

export type BenchmarkProfileV2 = "quality" | "latency";

export interface NativeBenchmarkReportV2 {
  readonly benchmarkRunId: string;
  readonly datasetVersion: "DriveGuard-Eval-v2.0.0";
  readonly scorerVersion: typeof NATIVE_SCORER_V2_VERSION;
  readonly gitCommit: string;
  readonly worktreeDirty?: boolean;
  readonly mode: "deterministic" | "live";
  readonly profile: BenchmarkProfileV2;
  readonly concurrency: number;
  readonly latencyComparableToPhase13Serial: boolean;
  readonly model: string;
  readonly provider: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly caseCount: number;
  readonly benchmarkRequestRetryCount: number;
  readonly providerRetryCount: number | null;
  readonly metrics: NativeRunMetricsV2;
  readonly failures: ReturnType<typeof scoreNativeRunV2>["failures"];
  readonly observations: readonly NativeObservationV2[];
  readonly rescoredAt?: string;
}

export class BenchmarkInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BenchmarkInfrastructureError";
  }
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error("concurrency must be an integer between 1 and 32");
  }
  return value;
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  validateConcurrency(concurrency);
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await worker(values[index]!, index);
      }
    }),
  );
  return Object.freeze(results);
}

function identityFor(runId: string, caseId: string): NativeCaseIdentityV2 {
  const token = randomUUID();
  return Object.freeze({
    runId: `${runId}:case:${caseId}`,
    caseId,
    trialId: `${runId}:trial:${caseId}:1`,
    traceId: `trace:${token}`,
    idempotencyKey: `eval:${runId}:${caseId}:${token}`,
  });
}

function infrastructureFailure(error: unknown): boolean {
  if (error instanceof BenchmarkInfrastructureError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b429\b|rate.?limit|ECONNRESET|ENOTFOUND|EAI_AGAIN|provider.*timeout|network.*unavailable)/iu.test(
    message,
  );
}

function failedObservation(
  item: NativeEvalCaseV2,
  identity: NativeCaseIdentityV2,
  validity: NativeObservationV2["validity"],
  error: unknown,
  retries: number,
): NativeObservationV2 {
  const faultCase = item.contract.recovery.kind !== "NONE";
  return Object.freeze({
    identity,
    validity,
    infrastructureError: error instanceof Error ? error.message : String(error),
    toolCalls: Object.freeze([]),
    policyEvaluations: Object.freeze([]),
    confirmationLifecycle: Object.freeze([]),
    execution: Object.freeze({
      agentToolExecution: "FAILED",
      urgentProcessorExecution:
        item.contract.taskClass === "urgent_event" ? "FAILED" : "NOT_APPLICABLE",
      simulatorSideEffectCount: 0,
      finalBusinessOutcome: faultCase ? "FAILED" : "UNKNOWN",
      forbiddenActionExecuted: false,
      duplicateSideEffectCount: 0,
    }),
    recovery: Object.freeze({
      attempted: faultCase,
      succeeded: false,
      safeDegradation: false,
      outcomeReconciled: false,
      blindWriteRetry: false,
      duplicateRequestCount: 0,
    }),
    finalResponse: "",
    latencyMs: 0,
    benchmarkRetryCount: retries,
    providerRetryCount: null,
  });
}

export interface RunNativeBenchmarkV2Options {
  readonly sourceCases: readonly NativeEvalCase[];
  readonly cases: readonly NativeEvalCaseV2[];
  readonly mode: "deterministic" | "live";
  readonly profile?: BenchmarkProfileV2;
  readonly concurrency?: number;
  readonly gitCommit: string;
  readonly infrastructureRetries?: number;
  readonly benchmarkRunPrefix?: "phase13.1" | "phase13.2";
  readonly worktreeDirty?: boolean;
  readonly executeLiveCase?: (
    item: NativeEvalCase,
    identity: NativeCaseIdentityV2,
  ) => Promise<import("../native/types.js").NativeObservation>;
}

export async function runNativeBenchmarkV2(
  options: RunNativeBenchmarkV2Options,
): Promise<NativeBenchmarkReportV2> {
  if (options.cases.length === 0 || options.cases.length !== options.sourceCases.length) {
    throw new Error("V2 contracts must pair one-to-one with non-empty source cases");
  }
  const profile = options.profile ?? "quality";
  const concurrency = validateConcurrency(options.concurrency ?? (profile === "latency" ? 1 : 4));
  const infrastructureRetries = options.infrastructureRetries ?? 1;
  if (
    !Number.isSafeInteger(infrastructureRetries) ||
    infrastructureRetries < 0 ||
    infrastructureRetries > 3
  ) {
    throw new Error("infrastructureRetries must be between 0 and 3");
  }
  if (options.mode === "live" && options.executeLiveCase === undefined) {
    throw new Error("Live V2 mode requires a live case executor");
  }
  const benchmarkRunId = `${options.benchmarkRunPrefix ?? "phase13.1"}:${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const observations = await mapWithConcurrency(
    options.cases.map((contract, index) => ({ contract, source: options.sourceCases[index]! })),
    concurrency,
    async ({ contract, source }) => {
      const identity = identityFor(benchmarkRunId, contract.caseId);
      if (options.mode === "deterministic") return createPerfectV2Observation(contract, identity);
      let retryCount = 0;
      for (;;) {
        try {
          const legacy = await options.executeLiveCase!(source, identity);
          if (legacy.v2 === undefined) {
            return failedObservation(
              contract,
              identity,
              "EVALUATOR_FAILURE",
              new Error("Live executor omitted the V2 trace"),
              retryCount,
            );
          }
          return Object.freeze({ ...legacy.v2, benchmarkRetryCount: retryCount });
        } catch (error) {
          const isInjectedFault = source.faultInjection !== undefined;
          const retryableInfrastructure = !isInjectedFault && infrastructureFailure(error);
          if (retryableInfrastructure && retryCount < infrastructureRetries) {
            retryCount += 1;
            continue;
          }
          return failedObservation(
            contract,
            identity,
            isInjectedFault
              ? "VALID"
              : retryableInfrastructure || infrastructureFailure(error)
                ? "INFRA_FAILURE"
                : "EVALUATOR_FAILURE",
            error,
            retryCount,
          );
        }
      }
    },
  );
  const scored = scoreNativeRunV2(options.cases, observations);
  return Object.freeze({
    benchmarkRunId,
    datasetVersion: "DriveGuard-Eval-v2.0.0",
    scorerVersion: NATIVE_SCORER_V2_VERSION,
    gitCommit: options.gitCommit,
    ...(options.worktreeDirty === undefined ? {} : { worktreeDirty: options.worktreeDirty }),
    mode: options.mode,
    profile,
    concurrency,
    latencyComparableToPhase13Serial: profile === "latency" && concurrency === 1,
    model:
      options.mode === "live"
        ? (process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash")
        : "faux/mock-provider",
    provider: options.mode === "live" ? "deepseek" : "deterministic",
    startedAt,
    completedAt: new Date().toISOString(),
    caseCount: options.cases.length,
    benchmarkRequestRetryCount: observations.reduce(
      (sum, observation) => sum + observation.benchmarkRetryCount,
      0,
    ),
    providerRetryCount: null,
    metrics: scored.metrics,
    failures: scored.failures,
    observations,
  });
}
