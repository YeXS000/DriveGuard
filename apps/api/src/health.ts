export interface DependencyProbe {
  readonly name: string;
  check(): Promise<void>;
  close?(): Promise<void>;
}

export interface DependencyHealth {
  readonly name: string;
  readonly status: "up" | "down";
}

export interface ReadinessAssessment {
  readonly ready: boolean;
  readonly dependencies: readonly DependencyHealth[];
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Dependency health check timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function assessReadiness(
  probes: readonly DependencyProbe[],
  timeoutMs: number,
): Promise<ReadinessAssessment> {
  const dependencies = await Promise.all(
    probes.map(async (probe): Promise<DependencyHealth> => {
      try {
        await withTimeout(probe.check(), timeoutMs);
        return { name: probe.name, status: "up" };
      } catch {
        return { name: probe.name, status: "down" };
      }
    }),
  );

  return {
    ready: dependencies.every((dependency) => dependency.status === "up"),
    dependencies,
  };
}
