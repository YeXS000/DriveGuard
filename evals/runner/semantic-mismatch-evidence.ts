import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Durable, per-case evidence for an accepted semantic mismatch.  This is
 * deliberately an append-only artifact: it is not a replacement for the
 * aggregate benchmark counters.
 */
export interface SemanticMismatchArtifact {
  readonly artifactVersion: 1;
  readonly artifactId: string;
  readonly caseId: string;
  readonly requestId: string | null;
  readonly userId: string;
  readonly sessionId: string;
  readonly vehicleId: string;
  readonly input: unknown;
  readonly expectedContract: unknown;
  readonly actualToolCalls: unknown;
  readonly policyEvents: unknown;
  readonly confirmationEvents: unknown;
  readonly contextRuntimeVersions: unknown;
  readonly executionReceipt: unknown;
  readonly finalSimulatorBusinessState: unknown;
  readonly finalResponse: unknown;
  readonly scorerResult: unknown;
  readonly failureCategory: string;
  readonly timestamps: {
    readonly observedAt: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
  };
}

export interface WriteSemanticMismatchArtifactInput {
  readonly outputDir: string;
  readonly caseId: string;
  readonly requestId?: string | null;
  readonly userId: string;
  readonly sessionId: string;
  readonly vehicleId: string;
  readonly input: unknown;
  readonly expectedContract: unknown;
  readonly actualToolCalls: unknown;
  readonly policyEvents: unknown;
  readonly confirmationEvents: unknown;
  readonly contextRuntimeVersions: unknown;
  readonly executionReceipt: unknown;
  readonly finalSimulatorBusinessState: unknown;
  readonly finalResponse: unknown;
  readonly scorerResult: unknown;
  readonly failureCategory: string;
  readonly timestamps?: Omit<SemanticMismatchArtifact["timestamps"], "observedAt"> & {
    readonly observedAt?: string;
  };
  readonly artifactId?: string;
}

function safeFileComponent(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/-+/gu, "-");
  return normalized.length === 0 ? "mismatch" : normalized.slice(0, 96);
}

/**
 * Writes exactly one independently recoverable JSON document for one mismatch.
 * The exclusive create prevents a later retry from silently overwriting the
 * original observed payload.
 */
export async function writeSemanticMismatchArtifact(
  input: WriteSemanticMismatchArtifactInput,
): Promise<{ readonly artifact: SemanticMismatchArtifact; readonly path: string }> {
  const artifactId = input.artifactId ?? `semantic-mismatch:${randomUUID()}`;
  const observedAt = input.timestamps?.observedAt ?? new Date().toISOString();
  const artifact: SemanticMismatchArtifact = Object.freeze({
    artifactVersion: 1,
    artifactId,
    caseId: input.caseId,
    requestId: input.requestId ?? null,
    userId: input.userId,
    sessionId: input.sessionId,
    vehicleId: input.vehicleId,
    input: structuredClone(input.input),
    expectedContract: structuredClone(input.expectedContract),
    actualToolCalls: structuredClone(input.actualToolCalls),
    policyEvents: structuredClone(input.policyEvents),
    confirmationEvents: structuredClone(input.confirmationEvents),
    contextRuntimeVersions: structuredClone(input.contextRuntimeVersions),
    executionReceipt: structuredClone(input.executionReceipt),
    finalSimulatorBusinessState: structuredClone(input.finalSimulatorBusinessState),
    finalResponse: structuredClone(input.finalResponse),
    scorerResult: structuredClone(input.scorerResult),
    failureCategory: input.failureCategory,
    timestamps: Object.freeze({
      observedAt,
      ...(input.timestamps?.startedAt === undefined
        ? {}
        : { startedAt: input.timestamps.startedAt }),
      ...(input.timestamps?.completedAt === undefined
        ? {}
        : { completedAt: input.timestamps.completedAt }),
    }),
  });
  const directory = resolve(input.outputDir, "mismatches");
  await mkdir(directory, { recursive: true });
  const path = resolve(
    directory,
    `${safeFileComponent(input.caseId)}-${safeFileComponent(artifactId)}.json`,
  );
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return Object.freeze({ artifact, path });
}
