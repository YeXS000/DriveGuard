import {
  URGENT_EVENT_THRESHOLDS,
  UrgentEventClassifier,
  UrgentEventPlanner,
  UrgentEventValidationError,
  parseUrgentEvent,
  urgentEventFingerprint,
} from "@driveguard/urgent-events";
import { describe, expect, it } from "vitest";

import {
  createCapabilitiesInput,
  createSnapshotBuilder,
  createUserInput,
  createValidTripInput,
  createValidVehicleInput,
  createWeatherInput,
} from "../fixtures/phase2-domain.js";

const occurredAt = "2026-08-25T09:59:59.000Z";
const receivedAt = "2026-08-25T10:00:00.000Z";

function event(eventType: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    eventId: `urgent-${eventType.toLowerCase()}`,
    schemaVersion: 1,
    eventType,
    source: "SIMULATOR",
    vehicleId: "vehicle-001",
    occurredAt,
    receivedAt,
    severity: "INFO",
    payload,
    correlationId: `correlation-${eventType.toLowerCase()}`,
    ...overrides,
  };
}

const validCases = [
  ["LOW_SOC", { reportedSoc: 10 }],
  ["CHARGING_INTERRUPTED", { reasonCode: "POWER_LOSS" }],
  ["VEHICLE_FAULT", { faultCode: "HVAC_FAULT", critical: false }],
  ["ROUTE_BLOCKED", { routeId: "route-001", reasonCode: "ROAD_CLOSED" }],
  ["ASSISTANCE_REQUIRED", { reasonCode: "DRIVER_REQUEST", immediateDanger: false }],
] as const;

describe("Phase 12 UrgentEvent model", () => {
  it.each(validCases)("accepts and deeply freezes %s", (eventType, payload) => {
    const parsed = parseUrgentEvent(event(eventType, payload));
    expect(parsed.eventType).toBe(eventType);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payload)).toBe(true);
  });

  it.each([
    ["unknown schema", { schemaVersion: 2 }],
    ["unknown event type", { eventType: "APPLY_BRAKE" }],
    ["unknown severity", { severity: "EMERGENCY" }],
    ["unknown source", { source: "LLM" }],
    ["additional event field", { toolToExecute: "apply_brake" }],
    ["invalid event ID", { eventId: "bad id" }],
    ["invalid vehicle ID", { vehicleId: "" }],
    ["invalid occurredAt", { occurredAt: "today" }],
    ["future occurrence", { occurredAt: "2026-08-25T10:00:01.000Z" }],
    ["invalid correlation ID", { correlationId: "bad id" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseUrgentEvent(event("LOW_SOC", { reportedSoc: 10 }, overrides))).toThrow(
      UrgentEventValidationError,
    );
  });

  it.each([
    ["LOW_SOC", { reportedSoc: -1 }],
    ["LOW_SOC", { reportedSoc: 101 }],
    ["LOW_SOC", { reportedSoc: 10, confirmed: true }],
    ["CHARGING_INTERRUPTED", { reasonCode: "lowercase" }],
    ["VEHICLE_FAULT", { faultCode: "FAULT" }],
    ["ROUTE_BLOCKED", { reasonCode: "" }],
    ["ASSISTANCE_REQUIRED", { reasonCode: "NEED_HELP", immediateDanger: "yes" }],
  ])("rejects invalid %s payload %#", (eventType, payload) => {
    expect(() => parseUrgentEvent(event(eventType, payload))).toThrow(UrgentEventValidationError);
  });

  it("clones input before freezing it", () => {
    const input = event("LOW_SOC", { reportedSoc: 10 });
    const parsed = parseUrgentEvent(input);
    (input.payload as { reportedSoc: number }).reportedSoc = 80;
    expect(parsed.eventType === "LOW_SOC" && parsed.payload.reportedSoc).toBe(10);
  });

  it("computes the same durable fingerprint regardless of object key order", () => {
    const original = event("VEHICLE_FAULT", { faultCode: "HV_FAULT", critical: true });
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    reordered.payload = { critical: true, faultCode: "HV_FAULT" };
    expect(urgentEventFingerprint(parseUrgentEvent(reordered))).toBe(
      urgentEventFingerprint(parseUrgentEvent(original)),
    );
  });

  it("binds the durable fingerprint to validated payload content", () => {
    const first = parseUrgentEvent(event("LOW_SOC", { reportedSoc: 5 }));
    const second = parseUrgentEvent(event("LOW_SOC", { reportedSoc: 6 }));
    expect(urgentEventFingerprint(first)).not.toBe(urgentEventFingerprint(second));
  });
});

describe("Phase 12 deterministic priority classification", () => {
  const classifier = new UrgentEventClassifier();

  it.each([
    [0, "CRITICAL"],
    [URGENT_EVENT_THRESHOLDS.lowSocCriticalPercent, "CRITICAL"],
    [URGENT_EVENT_THRESHOLDS.lowSocCriticalPercent + 1, "HIGH"],
    [URGENT_EVENT_THRESHOLDS.lowSocHighPercent, "HIGH"],
    [URGENT_EVENT_THRESHOLDS.lowSocHighPercent + 1, "WARNING"],
    [URGENT_EVENT_THRESHOLDS.lowSocWarningPercent, "WARNING"],
    [URGENT_EVENT_THRESHOLDS.lowSocWarningPercent + 1, "INFO"],
  ])("classifies LOW_SOC %d as %s", (reportedSoc, expected) => {
    const parsed = parseUrgentEvent(event("LOW_SOC", { reportedSoc }, { severity: "CRITICAL" }));
    expect(classifier.classify(parsed)).toBe(expected);
  });

  it.each([
    ["CHARGING_INTERRUPTED", { reasonCode: "POWER_LOSS" }, "HIGH"],
    ["VEHICLE_FAULT", { faultCode: "BRAKE_SENSOR", critical: false }, "HIGH"],
    ["VEHICLE_FAULT", { faultCode: "BRAKE_SENSOR", critical: true }, "CRITICAL"],
    ["ROUTE_BLOCKED", { reasonCode: "ROAD_CLOSED" }, "WARNING"],
    ["ASSISTANCE_REQUIRED", { reasonCode: "DRIVER_REQUEST", immediateDanger: false }, "HIGH"],
    ["ASSISTANCE_REQUIRED", { reasonCode: "COLLISION", immediateDanger: true }, "CRITICAL"],
  ])("classifies %s deterministically", (eventType, payload, expected) => {
    expect(classifier.classify(parseUrgentEvent(event(eventType, payload)))).toBe(expected);
  });
});

describe("Phase 12 deterministic urgent planning", () => {
  const planner = new UrgentEventPlanner();
  const classifier = new UrgentEventClassifier();

  function snapshot(vehicle: Record<string, unknown> = {}, trip: Record<string, unknown> = {}) {
    return createSnapshotBuilder().create({
      vehicle: { ...createValidVehicleInput(), ...vehicle },
      trip: { ...createValidTripInput(), ...trip },
      weather: createWeatherInput(),
      user: createUserInput(),
      capabilities: createCapabilitiesInput(),
    });
  }

  it("uses refreshed SOC rather than the event payload", () => {
    const input = parseUrgentEvent(event("LOW_SOC", { reportedSoc: 5 }));
    expect(planner.plan(input, classifier.classify(input), snapshot({ soc: 20 })).disposition).toBe(
      "RESOLVED",
    );
  });

  it("plans an R2 charger reroute for currently actionable low SOC", () => {
    const input = parseUrgentEvent(event("LOW_SOC", { reportedSoc: 5 }));
    const plan = planner.plan(input, classifier.classify(input), snapshot({ soc: 5 }));
    expect(plan.candidate).toMatchObject({
      toolName: "reroute_to_charger",
      arguments: { stationId: "station-pudong-001" },
    });
  });

  it.each([
    ["VEHICLE_FAULT", { faultCode: "HV_FAULT", critical: true }, "request_roadside_assistance"],
    [
      "ASSISTANCE_REQUIRED",
      { reasonCode: "DRIVER_REQUEST", immediateDanger: false },
      "request_emergency_support",
    ],
    ["CHARGING_INTERRUPTED", { reasonCode: "POWER_LOSS" }, "get_charging_status"],
  ])("maps %s to a formal Tool", (eventType, payload, toolName) => {
    const input = parseUrgentEvent(event(eventType, payload));
    const vehicle = eventType === "CHARGING_INTERRUPTED" ? { chargingState: "fault" } : {};
    expect(
      planner.plan(input, classifier.classify(input), snapshot(vehicle)).candidate?.toolName,
    ).toBe(toolName);
  });

  it("resolves a stale route-blocked event after the current route changed", () => {
    const input = parseUrgentEvent(
      event("ROUTE_BLOCKED", { routeId: "route-old", reasonCode: "ROAD_CLOSED" }),
    );
    expect(planner.plan(input, classifier.classify(input), snapshot()).disposition).toBe(
      "RESOLVED",
    );
  });

  it("requires replanning when the current route remains blocked", () => {
    const input = parseUrgentEvent(
      event("ROUTE_BLOCKED", { routeId: "route-001", reasonCode: "ROAD_CLOSED" }),
    );
    expect(planner.plan(input, classifier.classify(input), snapshot()).disposition).toBe(
      "REPLAN_REQUIRED",
    );
  });
});
