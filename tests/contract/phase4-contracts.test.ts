import Schema from "typebox/schema";
import {
  AUDIT_LEVELS,
  CAPABILITY_TOOL_MAPPING,
  FORBIDDEN_TOOL_NAMES,
  FORMAL_TOOL_NAMES,
  IDEMPOTENCY_HINTS,
  TOOL_ERROR_CODES,
  TOOL_RISK_LEVELS,
  ToolExecutionError,
  type FormalToolName,
} from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import { createOfflineRegistry } from "../fixtures/phase4-tools.js";

const expectedMetadata = [
  ["get_vehicle_state", "R0", false, []],
  ["get_trip_state", "R0", false, ["navigation"]],
  ["get_weather", "R0", false, []],
  ["search_charging_stations", "R0", false, ["charging"]],
  ["get_charging_status", "R0", false, ["charging"]],
  ["set_cabin_temperature", "R1", true, ["cabinTemperature"]],
  ["set_seat_heating", "R1", true, ["seatHeating"]],
  ["set_media_volume", "R1", true, ["media"]],
  ["set_navigation_destination", "R2", true, ["navigation"]],
  ["reroute_to_charger", "R2", true, ["navigation", "charging"]],
  ["reserve_charging_slot", "R2", true, ["charging"]],
  ["cancel_charging_reservation", "R2", true, ["charging"]],
  ["request_roadside_assistance", "R3", true, ["roadsideAssistance"]],
  ["request_emergency_support", "R3", true, ["roadsideAssistance"]],
] as const;

const validInputs: Readonly<Record<FormalToolName, object>> = {
  get_vehicle_state: {},
  get_trip_state: {},
  get_weather: {},
  search_charging_stations: {},
  get_charging_status: {},
  set_cabin_temperature: { temperatureC: 22 },
  set_seat_heating: { seat: "driver", level: 2 },
  set_media_volume: { volume: 50 },
  set_navigation_destination: { destination: "The Bund" },
  reroute_to_charger: { stationId: "station-pudong-001" },
  reserve_charging_slot: { stationId: "station-pudong-001" },
  cancel_charging_reservation: { reservationId: "reservation-001" },
  request_roadside_assistance: { reason: "flat tire" },
  request_emergency_support: { reason: "medical support" },
};

describe("Phase 4 formal Tool Contract", () => {
  const registry = createOfflineRegistry();

  it("defines exactly the 14 required formal names", () => {
    expect(new Set(registry.list().map((tool) => tool.name))).toEqual(new Set(FORMAL_TOOL_NAMES));
    expect(registry.list()).toHaveLength(14);
  });

  it.each(expectedMetadata)(
    "%s has exact risk, side-effect, and capability metadata",
    (name, riskLevel, sideEffect, requiredCapabilities) => {
      expect(registry.get(name)).toMatchObject({ riskLevel, sideEffect, requiredCapabilities });
    },
  );

  it.each(FORMAL_TOOL_NAMES)("%s has complete immutable metadata", (name) => {
    const definition = registry.get(name);
    expect(definition).toBeDefined();
    expect(definition?.label.length).toBeGreaterThan(0);
    expect(definition?.description.length).toBeGreaterThan(0);
    expect(TOOL_RISK_LEVELS).toContain(definition?.riskLevel);
    expect(IDEMPOTENCY_HINTS).toContain(definition?.idempotencyHint);
    expect(AUDIT_LEVELS).toContain(definition?.auditLevel);
    expect(definition?.timeoutHintMs).toBeGreaterThan(0);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition?.requiredCapabilities)).toBe(true);
    expect(Object.isFrozen(definition?.inputSchema)).toBe(true);
    expect(Object.isFrozen(definition?.outputSchema)).toBe(true);
  });

  it.each(FORMAL_TOOL_NAMES)("%s accepts its valid closed input schema", (name) => {
    const definition = registry.get(name);
    expect(Schema.Compile(definition!.inputSchema).Check(validInputs[name])).toBe(true);
  });

  it.each(FORMAL_TOOL_NAMES)("%s rejects an extra input property", (name) => {
    const definition = registry.get(name);
    expect(
      Schema.Compile(definition!.inputSchema).Check({ ...validInputs[name], unexpected: true }),
    ).toBe(false);
  });

  it.each(FORMAL_TOOL_NAMES)("%s exposes a compilable rejecting output schema", (name) => {
    const definition = registry.get(name);
    expect(() => Schema.Compile(definition!.outputSchema)).not.toThrow();
    expect(Schema.Compile(definition!.outputSchema).Check(undefined)).toBe(false);
  });

  it("uses an explicit, auditable capability mapping", () => {
    expect(CAPABILITY_TOOL_MAPPING).toEqual({
      navigation: ["get_trip_state", "set_navigation_destination", "reroute_to_charger"],
      charging: [
        "search_charging_stations",
        "get_charging_status",
        "reroute_to_charger",
        "reserve_charging_slot",
        "cancel_charging_reservation",
      ],
      cabinTemperature: ["set_cabin_temperature"],
      seatHeating: ["set_seat_heating"],
      media: ["set_media_volume"],
      roadsideAssistance: ["request_roadside_assistance", "request_emergency_support"],
    });
  });

  it("keeps RX and POLICY_DENIED outside the formal tool space", () => {
    expect(FORMAL_TOOL_NAMES.some((name) => FORBIDDEN_TOOL_NAMES.includes(name as never))).toBe(
      false,
    );
    expect(TOOL_ERROR_CODES).not.toContain("POLICY_DENIED");
  });

  it("serializes deterministic tool errors without stack data", () => {
    const error = new ToolExecutionError("CONFLICT", "reserve_charging_slot", "conflict");
    expect(error.toJSON()).toEqual({
      error: { code: "CONFLICT", toolName: "reserve_charging_slot", message: "conflict" },
    });
    expect(JSON.stringify(error.toJSON())).not.toMatch(/stack|\/home\//u);
  });
});

describe("Phase 4 schema boundaries", () => {
  const registry = createOfflineRegistry();
  const invalidCases = [
    ["set_cabin_temperature", { temperatureC: 15.99 }],
    ["set_cabin_temperature", { temperatureC: 30.01 }],
    ["set_cabin_temperature", { temperatureC: Number.NaN }],
    ["set_cabin_temperature", { temperatureC: "22" }],
    ["set_seat_heating", { seat: "rear", level: 1 }],
    ["set_seat_heating", { seat: "driver", level: -1 }],
    ["set_seat_heating", { seat: "driver", level: 4 }],
    ["set_seat_heating", { seat: "driver", level: 1.5 }],
    ["set_media_volume", { volume: -0.1 }],
    ["set_media_volume", { volume: 100.1 }],
    ["set_media_volume", { volume: Number.POSITIVE_INFINITY }],
    ["set_navigation_destination", { destination: "" }],
    ["set_navigation_destination", { destination: "x".repeat(513) }],
    ["reroute_to_charger", { stationId: "" }],
    ["reserve_charging_slot", { stationId: "" }],
    ["reserve_charging_slot", { stationId: "x".repeat(129) }],
    ["cancel_charging_reservation", { reservationId: "" }],
    ["cancel_charging_reservation", { reservationId: "x".repeat(129) }],
    ["request_roadside_assistance", { reason: "" }],
    ["request_roadside_assistance", { reason: "x".repeat(513) }],
    ["request_emergency_support", { reason: "" }],
    ["request_emergency_support", { reason: "x".repeat(513) }],
    ["get_vehicle_state", []],
    ["get_weather", null],
  ] as const;

  it.each(invalidCases)("%s rejects boundary input %#", (name, input) => {
    expect(Schema.Compile(registry.get(name)!.inputSchema).Check(input)).toBe(false);
  });
});
