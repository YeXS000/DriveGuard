import { createHash } from "node:crypto";

import { UtcTimestampSchema, VehicleIdSchema, timestampToEpochMs } from "@driveguard/domain";
import { Type, type Static, type TSchema } from "typebox";
import Schema from "typebox/schema";

import { UrgentEventValidationError } from "./errors.js";

export const URGENT_EVENT_SCHEMA_VERSION = 1 as const;
export const URGENT_EVENT_TYPES = [
  "LOW_SOC",
  "CHARGING_INTERRUPTED",
  "VEHICLE_FAULT",
  "ROUTE_BLOCKED",
  "ASSISTANCE_REQUIRED",
] as const;
export type UrgentEventType = (typeof URGENT_EVENT_TYPES)[number];

export const URGENT_EVENT_SEVERITIES = ["INFO", "WARNING", "HIGH", "CRITICAL"] as const;
export type UrgentEventSeverity = (typeof URGENT_EVENT_SEVERITIES)[number];

export const URGENT_EVENT_SOURCES = ["VEHICLE", "SIMULATOR", "SERVICE"] as const;
export type UrgentEventSource = (typeof URGENT_EVENT_SOURCES)[number];

const SafeEventIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});

const common = {
  eventId: SafeEventIdSchema,
  schemaVersion: Type.Literal(URGENT_EVENT_SCHEMA_VERSION),
  source: Type.Enum(URGENT_EVENT_SOURCES),
  vehicleId: VehicleIdSchema,
  occurredAt: UtcTimestampSchema,
  receivedAt: UtcTimestampSchema,
  severity: Type.Enum(URGENT_EVENT_SEVERITIES),
  correlationId: SafeEventIdSchema,
};

function variant<T extends UrgentEventType, P extends TSchema>(eventType: T, payload: P) {
  return Type.Readonly(
    Type.Object(
      {
        ...common,
        eventType: Type.Literal(eventType),
        payload: Type.Readonly(payload),
      },
      { additionalProperties: false },
    ),
  );
}

export const LowSocPayloadSchema = Type.Object(
  { reportedSoc: Type.Number({ minimum: 0, maximum: 100 }) },
  { additionalProperties: false },
);
export const ChargingInterruptedPayloadSchema = Type.Object(
  { reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z0-9_]+$" }) },
  { additionalProperties: false },
);
export const VehicleFaultPayloadSchema = Type.Object(
  {
    faultCode: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z0-9_]+$" }),
    critical: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const RouteBlockedPayloadSchema = Type.Object(
  {
    routeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z0-9_]+$" }),
  },
  { additionalProperties: false },
);
export const AssistanceRequiredPayloadSchema = Type.Object(
  {
    reasonCode: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Z0-9_]+$" }),
    immediateDanger: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const UrgentEventSchema = Type.Union([
  variant("LOW_SOC", LowSocPayloadSchema),
  variant("CHARGING_INTERRUPTED", ChargingInterruptedPayloadSchema),
  variant("VEHICLE_FAULT", VehicleFaultPayloadSchema),
  variant("ROUTE_BLOCKED", RouteBlockedPayloadSchema),
  variant("ASSISTANCE_REQUIRED", AssistanceRequiredPayloadSchema),
]);
export type UrgentEvent = Static<typeof UrgentEventSchema>;

const validator = Schema.Compile(UrgentEventSchema);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}

export function parseUrgentEvent(input: unknown): UrgentEvent {
  let cloned: unknown;
  try {
    cloned = structuredClone(input);
  } catch {
    throw new UrgentEventValidationError("Urgent event must be cloneable data");
  }
  if (!validator.Check(cloned)) {
    throw new UrgentEventValidationError();
  }
  const event = cloned;
  if (
    timestampToEpochMs(event.occurredAt, "urgentEvent.occurredAt") >
    timestampToEpochMs(event.receivedAt, "urgentEvent.receivedAt")
  ) {
    throw new UrgentEventValidationError("occurredAt cannot be after receivedAt");
  }
  return deepFreeze(event);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
  return `{${entries.join(",")}}`;
}

/** A safe equality binding for durable deduplication; the validated payload itself is not stored. */
export function urgentEventFingerprint(event: UrgentEvent): string {
  return createHash("sha256").update(canonicalJson(event), "utf8").digest("hex");
}

export function readRejectableEventIdentity(input: unknown):
  | Readonly<{
      eventId: string;
      eventType: string;
      vehicleId: string;
      receivedAt: string;
      correlationId: string;
    }>
  | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const candidate = input as Record<string, unknown>;
  const values = [
    candidate.eventId,
    candidate.eventType,
    candidate.vehicleId,
    candidate.receivedAt,
    candidate.correlationId,
  ];
  if (values.some((value) => typeof value !== "string")) return undefined;
  const eventId = candidate.eventId as string;
  const eventType = candidate.eventType as string;
  const vehicleId = candidate.vehicleId as string;
  const receivedAt = candidate.receivedAt as string;
  const correlationId = candidate.correlationId as string;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(eventId ?? "")) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(correlationId ?? "")) return undefined;
  if ((eventType?.length ?? 0) < 1 || (eventType?.length ?? 0) > 64) return undefined;
  if ((vehicleId?.length ?? 0) < 1 || (vehicleId?.length ?? 0) > 128) return undefined;
  if (!Number.isFinite(Date.parse(receivedAt ?? ""))) return undefined;
  return Object.freeze({ eventId, eventType, vehicleId, receivedAt, correlationId });
}
