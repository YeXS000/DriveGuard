import type { TrustedConfirmationChallenge } from "@driveguard/action-lifecycle";
import { timestampToEpochMs } from "@driveguard/domain";
import { SystemClock, type Clock } from "@driveguard/shared";

export interface TrustedConfirmationChallengeChannel {
  publish(challenge: TrustedConfirmationChallenge): void | Promise<void>;
  take(actionId: string): TrustedConfirmationChallenge | undefined;
  discard(actionId: string): void;
}

export class InMemoryTrustedConfirmationChallengeChannel implements TrustedConfirmationChallengeChannel {
  readonly #challenges = new Map<string, TrustedConfirmationChallenge>();
  readonly #clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  publish(challenge: TrustedConfirmationChallenge): void {
    const nowMs = this.#clock.nowMs();
    this.#purgeExpired(nowMs);
    if (timestampToEpochMs(challenge.expiresAt, "expiresAt") <= nowMs) {
      throw new Error("Trusted confirmation challenge has expired");
    }
    if (this.#challenges.has(challenge.actionId)) {
      throw new Error("Trusted confirmation challenge already exists");
    }
    this.#challenges.set(challenge.actionId, Object.freeze(structuredClone(challenge)));
  }

  take(actionId: string): TrustedConfirmationChallenge | undefined {
    const challenge = this.#challenges.get(actionId);
    if (challenge === undefined) return undefined;
    this.#challenges.delete(actionId);
    if (timestampToEpochMs(challenge.expiresAt, "expiresAt") <= this.#clock.nowMs()) {
      return undefined;
    }
    return challenge;
  }

  discard(actionId: string): void {
    this.#challenges.delete(actionId);
  }

  #purgeExpired(nowMs: number): void {
    for (const [actionId, challenge] of this.#challenges) {
      if (timestampToEpochMs(challenge.expiresAt, "expiresAt") <= nowMs) {
        this.#challenges.delete(actionId);
      }
    }
  }
}
