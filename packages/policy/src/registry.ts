import type { PolicyRule } from "./types.js";

const RESERVED_PRECEDENCE = new Map<number, string>([
  [0, "DG-POL-001"],
  [1, "DG-POL-002"],
  [2, "DG-POL-003"],
  [3, "DG-POL-004"],
  [4, "DG-POL-005"],
  [5, "DG-POL-006"],
  [6, "DG-POL-007"],
  [7, "DG-POL-008"],
  [8, "DG-POL-009"],
  [9, "DG-POL-010"],
  [10, "DG-POL-011"],
]);

export class PolicyRuleRegistryError extends Error {
  readonly code: "DUPLICATE_RULE_ID" | "INVALID_RULE";

  constructor(code: PolicyRuleRegistryError["code"], message: string) {
    super(message);
    this.name = "PolicyRuleRegistryError";
    this.code = code;
  }
}

function validateRule(rule: PolicyRule): void {
  if (typeof rule.ruleId !== "string" || !/^DG-POL-[0-9]{3}$/u.test(rule.ruleId)) {
    throw new PolicyRuleRegistryError("INVALID_RULE", "Policy rule ID is invalid");
  }
  if (!Number.isSafeInteger(rule.priority) || rule.priority < 0) {
    throw new PolicyRuleRegistryError("INVALID_RULE", "Policy rule priority is invalid");
  }
  const reservedRuleId = RESERVED_PRECEDENCE.get(rule.priority);
  if (reservedRuleId !== undefined && rule.ruleId !== reservedRuleId) {
    throw new PolicyRuleRegistryError(
      "INVALID_RULE",
      "Reserved Policy precedence cannot be replaced",
    );
  }
  if (typeof rule.appliesTo !== "function" || typeof rule.evaluate !== "function") {
    throw new PolicyRuleRegistryError("INVALID_RULE", "Policy rule functions are required");
  }
}

export class PolicyRuleRegistry {
  readonly #rules = new Map<string, PolicyRule>();

  constructor(rules: readonly PolicyRule[] = []) {
    for (const rule of rules) this.register(rule);
  }

  register(rule: PolicyRule): this {
    validateRule(rule);
    if (this.#rules.has(rule.ruleId)) {
      throw new PolicyRuleRegistryError("DUPLICATE_RULE_ID", "Duplicate Policy rule ID");
    }
    this.#rules.set(rule.ruleId, Object.freeze(rule));
    return this;
  }

  list(): readonly PolicyRule[] {
    return Object.freeze(
      [...this.#rules.values()].sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        // Duplicate IDs are rejected at registration, so equality is impossible here.
        return left.ruleId < right.ruleId ? -1 : 1;
      }),
    );
  }
}
