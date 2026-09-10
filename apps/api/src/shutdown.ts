import type { FastifyInstance } from "fastify";

import type { RequestAdmissionController } from "./admission-control.js";

export class GracefulShutdownTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Graceful shutdown exceeded ${timeoutMs}ms`);
    this.name = "GracefulShutdownTimeoutError";
  }
}

export async function gracefulShutdown(input: {
  readonly app: FastifyInstance;
  readonly admissionController: RequestAdmissionController;
  readonly timeoutMs: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new TypeError("shutdown timeout must be a positive integer");
  }
  input.admissionController.beginShutdown();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      input.app.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new GracefulShutdownTimeoutError(input.timeoutMs)),
          input.timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
