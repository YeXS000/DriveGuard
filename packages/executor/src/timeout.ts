import { ExecutorFault } from "./errors.js";

export interface TimeoutController {
  run<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export class AbortTimeoutController implements TimeoutController {
  async run<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ExecutorFault("DEPENDENCY_TIMEOUT", "Attempt timeout"));
      }, timeoutMs);
    });
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    void operationPromise.catch(() => undefined);
    try {
      return await Promise.race([operationPromise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
