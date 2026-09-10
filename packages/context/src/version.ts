import Schema from "typebox/schema";

import {
  ContextSnapshotIdSchema,
  ContextVersionSchema,
  DomainValidationError,
  type ContextSnapshotId,
  type ContextVersion,
} from "@driveguard/domain";

const contextVersionValidator = Schema.Compile(ContextVersionSchema);
const snapshotIdValidator = Schema.Compile(ContextSnapshotIdSchema);

interface SequenceState {
  current: number;
}

const processContextVersionState: SequenceState = { current: 0 };
const processSnapshotSequenceStates = new Map<string, SequenceState>();

export class ContextVersionAllocator {
  readonly #state: SequenceState;

  /** Omit currentVersion for the process-wide sequence; pass it only for deterministic replay/tests. */
  constructor(currentVersion?: number) {
    if (currentVersion !== undefined && typeof currentVersion !== "number") {
      throw new DomainValidationError([
        {
          code: "INVALID_FIELD",
          path: "currentVersion",
          message: "Initial context version must be numeric when provided",
        },
      ]);
    }
    const initialVersion = currentVersion === undefined ? 0 : currentVersion;
    if (
      !Number.isSafeInteger(initialVersion) ||
      initialVersion < 0 ||
      initialVersion >= Number.MAX_SAFE_INTEGER
    ) {
      throw new DomainValidationError([
        {
          code: typeof initialVersion === "number" ? "OUT_OF_RANGE" : "INVALID_FIELD",
          path: "currentVersion",
          message: "Initial context version must allow a positive next version",
        },
      ]);
    }
    this.#state =
      currentVersion === undefined ? processContextVersionState : { current: initialVersion };
  }

  next(): ContextVersion {
    const candidate = this.#state.current + 1;
    if (!contextVersionValidator.Check(candidate)) {
      throw new DomainValidationError([
        {
          code: "OUT_OF_RANGE",
          path: "contextVersion",
          message: "Context version exhausted the safe integer range",
        },
      ]);
    }
    this.#state.current = candidate;
    return candidate;
  }

  current(): number {
    return this.#state.current;
  }
}

export class ContextSnapshotIdAllocator {
  readonly #prefix: string;
  readonly #state: SequenceState;

  /** Omit currentSequence to share a process-wide sequence for this prefix. */
  constructor(prefix: string, currentSequence?: number) {
    if (typeof prefix !== "string") {
      throw new DomainValidationError([
        {
          code: "INVALID_FIELD",
          path: "snapshotIdPrefix",
          message: "Snapshot ID prefix must be a string",
        },
      ]);
    }
    if (currentSequence !== undefined && typeof currentSequence !== "number") {
      throw new DomainValidationError([
        {
          code: "INVALID_FIELD",
          path: "currentSequence",
          message: "Snapshot sequence must be numeric when provided",
        },
      ]);
    }
    this.#prefix = prefix;
    const initialSequence = currentSequence === undefined ? 0 : currentSequence;
    if (
      !Number.isSafeInteger(initialSequence) ||
      initialSequence < 0 ||
      initialSequence >= Number.MAX_SAFE_INTEGER
    ) {
      throw new DomainValidationError([
        {
          code: typeof initialSequence === "number" ? "OUT_OF_RANGE" : "INVALID_FIELD",
          path: "currentSequence",
          message: "Snapshot sequence must allow a positive next value",
        },
      ]);
    }
    const probe = `${prefix}:1`;
    if (!snapshotIdValidator.Check(probe)) {
      throw new DomainValidationError([
        {
          code: "INVALID_FIELD",
          path: "snapshotIdPrefix",
          message: "Snapshot ID prefix is invalid",
        },
      ]);
    }
    if (currentSequence === undefined) {
      const processState = processSnapshotSequenceStates.get(prefix) ?? { current: 0 };
      processSnapshotSequenceStates.set(prefix, processState);
      this.#state = processState;
    } else {
      this.#state = { current: initialSequence };
    }
  }

  next(): ContextSnapshotId {
    const sequence = this.#state.current + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new DomainValidationError([
        {
          code: "OUT_OF_RANGE",
          path: "snapshotId",
          message: "Snapshot ID sequence exhausted the safe integer range",
        },
      ]);
    }
    const candidate = `${this.#prefix}:${sequence}`;
    if (!snapshotIdValidator.Check(candidate)) {
      throw new DomainValidationError([
        {
          code: "OUT_OF_RANGE",
          path: "snapshotId",
          message: "Snapshot ID sequence exhausted its valid range",
        },
      ]);
    }
    this.#state.current = sequence;
    return candidate;
  }
}
