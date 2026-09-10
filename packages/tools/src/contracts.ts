import type {
  AvailabilityRequirements,
  CapabilityName,
  ServiceName,
} from "@driveguard/capabilities";
import type { Static, TSchema } from "typebox";

export const TOOL_RISK_LEVELS = ["R0", "R1", "R2", "R3"] as const;
export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];

export const FORBIDDEN_TOOL_NAMES = [
  "apply_brake",
  "control_steering",
  "set_throttle",
  "disable_aeb",
  "disable_esc",
] as const;
export type ForbiddenToolName = (typeof FORBIDDEN_TOOL_NAMES)[number];

export const FORMAL_TOOL_NAMES = [
  "get_vehicle_state",
  "get_trip_state",
  "get_weather",
  "search_charging_stations",
  "get_charging_status",
  "set_cabin_temperature",
  "set_seat_heating",
  "set_media_volume",
  "set_navigation_destination",
  "reroute_to_charger",
  "reserve_charging_slot",
  "cancel_charging_reservation",
  "request_roadside_assistance",
  "request_emergency_support",
] as const;
export type FormalToolName = (typeof FORMAL_TOOL_NAMES)[number];

export const IDEMPOTENCY_HINTS = ["READ_ONLY", "IDEMPOTENT", "NON_IDEMPOTENT"] as const;
export type IdempotencyHint = (typeof IDEMPOTENCY_HINTS)[number];

export const AUDIT_LEVELS = ["BASIC", "STANDARD", "HIGH"] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly idempotencyKey: string;
}

export interface ToolDefinition<
  TInputSchema extends TSchema = TSchema,
  TOutputSchema extends TSchema = TSchema,
> extends AvailabilityRequirements {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  readonly riskLevel: ToolRiskLevel;
  readonly sideEffect: boolean;
  readonly timeoutHintMs: number;
  readonly idempotencyHint: IdempotencyHint;
  readonly auditLevel: AuditLevel;
  readonly execute: (
    input: Static<TInputSchema>,
    context?: ToolExecutionContext,
  ) => Promise<Static<TOutputSchema>>;
}

export interface ToolRegistrySnapshotEntry {
  readonly name: string;
  readonly riskLevel: ToolRiskLevel;
  readonly requiredCapabilities: readonly CapabilityName[];
  readonly requiredServices: readonly ServiceName[];
  readonly sideEffect: boolean;
}

export interface ToolRegistrySnapshot {
  readonly tools: readonly ToolRegistrySnapshotEntry[];
}

export const TOOL_ERROR_CODES = [
  "TOOL_VALIDATION_ERROR",
  "CAPABILITY_UNAVAILABLE",
  "DEPENDENCY_UNAVAILABLE",
  "DEPENDENCY_TIMEOUT",
  "DEPENDENCY_RESPONSE_INVALID",
  "RESOURCE_NOT_FOUND",
  "CONFLICT",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export type ToolFailureType =
  | "TIMEOUT"
  | "HTTP_503"
  | "CONNECTION_ABORT"
  | "DEFINITE_FAILURE"
  | "AMBIGUOUS_SIDE_EFFECT"
  | "DUPLICATE_REQUEST";

export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;
  readonly toolName: string;
  readonly failureType: ToolFailureType | undefined;

  constructor(
    code: ToolErrorCode,
    toolName: string,
    message: string,
    failureType?: ToolFailureType,
  ) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.toolName = toolName;
    this.failureType = failureType;
  }

  toJSON(): {
    readonly error: {
      readonly code: ToolErrorCode;
      readonly toolName: string;
      readonly message: string;
    };
  } {
    return { error: { code: this.code, toolName: this.toolName, message: this.message } };
  }
}

export class ToolRegistryError extends Error {
  readonly code:
    "DUPLICATE_TOOL" | "FORBIDDEN_TOOL" | "INVALID_TOOL_DEFINITION" | "REGISTRY_SEALED";

  constructor(code: ToolRegistryError["code"], message: string) {
    super(message);
    this.name = "ToolRegistryError";
    this.code = code;
  }
}
