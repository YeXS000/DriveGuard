import Schema from "typebox/schema";

import {
  CapabilityResolutionContextSchema,
  type AvailabilityRequirements,
  type CapabilityResolutionContext,
} from "./model.js";

const contextValidator = Schema.Compile(CapabilityResolutionContextSchema);

export class CapabilityResolutionError extends Error {
  readonly code = "CAPABILITY_CONTEXT_INVALID" as const;

  constructor() {
    super("Capability resolution context is invalid");
    this.name = "CapabilityResolutionError";
  }
}

export function parseCapabilityResolutionContext(input: unknown): CapabilityResolutionContext {
  try {
    if (!contextValidator.Check(input)) throw new CapabilityResolutionError();
    const cloned = structuredClone(input);
    Object.freeze(cloned.capabilities);
    Object.freeze(cloned.services);
    return Object.freeze(cloned);
  } catch (error) {
    if (error instanceof CapabilityResolutionError) throw error;
    throw new CapabilityResolutionError();
  }
}

export function requirementsAreAvailable(
  requirements: AvailabilityRequirements,
  context: CapabilityResolutionContext,
): boolean {
  return (
    requirements.requiredCapabilities.every((name) => context.capabilities[name]) &&
    requirements.requiredServices.every((name) => context.services[name])
  );
}
