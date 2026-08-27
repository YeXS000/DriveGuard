import {
  AUDIT_LEVELS,
  FORBIDDEN_TOOL_NAMES,
  IDEMPOTENCY_HINTS,
  TOOL_RISK_LEVELS,
  ToolExecutionError,
  type ToolDefinition,
  ToolRegistryError,
  type ToolRegistrySnapshot,
} from "./contracts.js";
import {
  CAPABILITY_NAMES,
  SERVICE_NAMES,
  parseCapabilityResolutionContext,
  requirementsAreAvailable,
  type CapabilityResolutionContext,
} from "@driveguard/capabilities";
import Schema from "typebox/schema";

function invalid(message: string): never {
  throw new ToolRegistryError("INVALID_TOOL_DEFINITION", message);
}

function freezeDeep<T>(value: T, visited = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  if (visited.has(value)) return value;
  visited.add(value);
  for (const key of Reflect.ownKeys(value)) freezeDeep(Reflect.get(value, key), visited);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function validateNames(values: readonly string[], valid: ReadonlySet<string>, label: string): void {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || !valid.has(value)) ||
    new Set(values).size !== values.length
  ) {
    invalid(`${label} contains an unsupported or duplicate value`);
  }
}

const capabilityNames = new Set<string>(CAPABILITY_NAMES);
const serviceNames = new Set<string>(SERVICE_NAMES);
const forbiddenNames = new Set<string>(FORBIDDEN_TOOL_NAMES);

function validateDefinition(definition: ToolDefinition): void {
  if (
    typeof definition.name !== "string" ||
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(definition.name)
  ) {
    invalid("Tool name must be lower snake case");
  }
  if (forbiddenNames.has(definition.name)) {
    throw new ToolRegistryError("FORBIDDEN_TOOL", "RX tools cannot be registered");
  }
  if (
    typeof definition.label !== "string" ||
    definition.label.trim().length === 0 ||
    typeof definition.description !== "string" ||
    definition.description.trim().length === 0
  ) {
    invalid("Tool label and description are required");
  }
  if (!TOOL_RISK_LEVELS.includes(definition.riskLevel)) invalid("Tool risk level is invalid");
  if (typeof definition.sideEffect !== "boolean") invalid("Tool sideEffect must be boolean");
  if (
    !Number.isSafeInteger(definition.timeoutHintMs) ||
    definition.timeoutHintMs < 1 ||
    definition.timeoutHintMs > 60_000
  ) {
    invalid("Tool timeout hint is invalid");
  }
  if (!IDEMPOTENCY_HINTS.includes(definition.idempotencyHint)) {
    invalid("Tool idempotency hint is invalid");
  }
  if (!AUDIT_LEVELS.includes(definition.auditLevel)) invalid("Tool audit level is invalid");
  validateNames(definition.requiredCapabilities, capabilityNames, "requiredCapabilities");
  validateNames(definition.requiredServices, serviceNames, "requiredServices");
  if (typeof definition.execute !== "function") invalid("Tool execute handler is required");
  try {
    Schema.Compile(definition.inputSchema);
    Schema.Compile(definition.outputSchema);
  } catch {
    invalid("Tool schema cannot be compiled");
  }
}

export class ToolRegistry {
  readonly #definitions = new Map<string, ToolDefinition>();
  #sealed = false;

  register(definition: ToolDefinition): this {
    if (this.#sealed) throw new ToolRegistryError("REGISTRY_SEALED", "Tool registry is sealed");
    validateDefinition(definition);
    if (this.#definitions.has(definition.name)) {
      throw new ToolRegistryError("DUPLICATE_TOOL", "Duplicate tool name is not allowed");
    }
    this.#definitions.set(definition.name, freezeDeep(definition));
    return this;
  }

  seal(): this {
    this.#sealed = true;
    return this;
  }

  get isSealed(): boolean {
    return this.#sealed;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#definitions.get(name);
  }

  list(): readonly ToolDefinition[] {
    return Object.freeze(
      [...this.#definitions.values()].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  resolve(contextInput: unknown): readonly ToolDefinition[] {
    const context = parseCapabilityResolutionContext(contextInput);
    return Object.freeze(
      this.list().filter((definition) => requirementsAreAvailable(definition, context)),
    );
  }

  requireAvailable(name: string, contextInput: unknown): ToolDefinition {
    const definition = this.#definitions.get(name);
    if (definition === undefined) {
      throw new ToolExecutionError("CAPABILITY_UNAVAILABLE", name, "Tool is not registered");
    }
    const context = parseCapabilityResolutionContext(contextInput);
    if (!requirementsAreAvailable(definition, context)) {
      throw new ToolExecutionError(
        "CAPABILITY_UNAVAILABLE",
        name,
        "Tool capability is unavailable",
      );
    }
    return definition;
  }

  snapshot(): ToolRegistrySnapshot {
    return freezeDeep({
      tools: this.list().map((definition) => ({
        name: definition.name,
        riskLevel: definition.riskLevel,
        requiredCapabilities: [...definition.requiredCapabilities],
        requiredServices: [...definition.requiredServices],
        sideEffect: definition.sideEffect,
      })),
    });
  }
}

export function resolveAvailableTools(
  registry: ToolRegistry,
  context: CapabilityResolutionContext,
): readonly ToolDefinition[] {
  return registry.resolve(context);
}
