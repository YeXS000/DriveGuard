import {
  CAPABILITY_NAMES,
  CapabilityResolutionError,
  SERVICE_NAMES,
  parseCapabilityResolutionContext,
  requirementsAreAvailable,
} from "@driveguard/capabilities";
import {
  FORBIDDEN_TOOL_NAMES,
  FORMAL_TOOL_NAMES,
  ToolExecutionError,
  DevelopmentEmergencySupportProvider,
  type ToolDefinition,
  ToolRegistry,
  ToolRegistryError,
  resolveAvailableTools,
} from "@driveguard/tools";
import { describe, expect, it } from "vitest";

import {
  FULL_CAPABILITY_CONTEXT,
  contextWith,
  createOfflineRegistry,
} from "../fixtures/phase4-tools.js";

function names(definitions: readonly ToolDefinition[]): string[] {
  return definitions.map((definition) => definition.name);
}

function altered(base: ToolDefinition, overrides: object): ToolDefinition {
  return { ...base, ...overrides };
}

describe("Phase 4 capability context", () => {
  it("rejects an invalid development-provider identifier prefix", () => {
    expect(() => new DevelopmentEmergencySupportProvider("unsafe prefix")).toThrow(TypeError);
  });

  it("validates, clones, and freezes a complete context", () => {
    const source = structuredClone(FULL_CAPABILITY_CONTEXT);
    const parsed = parseCapabilityResolutionContext(source);
    source.capabilities.navigation = false;
    expect(parsed.capabilities.navigation).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);
    expect(Object.isFrozen(parsed.services)).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { capabilities: FULL_CAPABILITY_CONTEXT.capabilities },
    { services: FULL_CAPABILITY_CONTEXT.services },
    { ...FULL_CAPABILITY_CONTEXT, extra: true },
    contextWith({ navigation: "yes" as never }),
    contextWith({}, { weather: 1 as never }),
    {
      ...FULL_CAPABILITY_CONTEXT,
      capabilities: { ...FULL_CAPABILITY_CONTEXT.capabilities, unknown: true },
    },
    {
      ...FULL_CAPABILITY_CONTEXT,
      services: { ...FULL_CAPABILITY_CONTEXT.services, unknown: true },
    },
  ])("rejects invalid capability context %#", (input) => {
    expect(() => parseCapabilityResolutionContext(input)).toThrow(CapabilityResolutionError);
  });

  it("normalizes an otherwise valid but uncloneable capability context", () => {
    const input = new Proxy(structuredClone(FULL_CAPABILITY_CONTEXT), {});
    expect(() => parseCapabilityResolutionContext(input)).toThrow(CapabilityResolutionError);
  });

  it.each(CAPABILITY_NAMES)("requires declared capability %s", (capability) => {
    expect(
      requirementsAreAvailable(
        { requiredCapabilities: [capability], requiredServices: [] },
        FULL_CAPABILITY_CONTEXT,
      ),
    ).toBe(true);
    expect(
      requirementsAreAvailable(
        { requiredCapabilities: [capability], requiredServices: [] },
        contextWith({ [capability]: false }),
      ),
    ).toBe(false);
  });

  it.each(SERVICE_NAMES)("requires available service %s", (service) => {
    expect(
      requirementsAreAvailable(
        { requiredCapabilities: [], requiredServices: [service] },
        FULL_CAPABILITY_CONTEXT,
      ),
    ).toBe(true);
    expect(
      requirementsAreAvailable(
        { requiredCapabilities: [], requiredServices: [service] },
        contextWith({}, { [service]: false }),
      ),
    ).toBe(false);
  });
});

describe("Phase 4 ToolRegistry semantics", () => {
  it("registers, gets, lists, and seals definitions", () => {
    const source = createOfflineRegistry().get("get_weather")!;
    const registry = new ToolRegistry().register(source);
    expect(registry.get("get_weather")).toBe(source);
    expect(names(registry.list())).toEqual(["get_weather"]);
    expect(registry.isSealed).toBe(false);
    expect(registry.seal().isSealed).toBe(true);
  });

  it("rejects duplicate names", () => {
    const source = createOfflineRegistry().get("get_weather")!;
    const registry = new ToolRegistry().register(source);
    expect(() => registry.register(source)).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_TOOL" }),
    );
  });

  it("rejects registration after seal", () => {
    const source = createOfflineRegistry().get("get_weather")!;
    const registry = new ToolRegistry().seal();
    expect(() => registry.register(source)).toThrowError(
      expect.objectContaining({ code: "REGISTRY_SEALED" }),
    );
  });

  it("lists tools in deterministic name order", () => {
    const source = createOfflineRegistry();
    const registry = new ToolRegistry();
    registry.register(source.get("set_media_volume")!);
    registry.register(source.get("get_vehicle_state")!);
    registry.register(source.get("reserve_charging_slot")!);
    expect(names(registry.list())).toEqual([
      "get_vehicle_state",
      "reserve_charging_slot",
      "set_media_volume",
    ]);
  });

  it("returns immutable list and snapshot containers", () => {
    const registry = createOfflineRegistry();
    const list = registry.list();
    const snapshot = registry.snapshot();
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(() => (list as ToolDefinition[]).pop()).toThrow();
  });

  it("snapshot contains no execute handler, schema, or provider", () => {
    const serialized = JSON.stringify(createOfflineRegistry().snapshot());
    expect(serialized).not.toMatch(/execute|inputSchema|outputSchema|provider|baseUrl/iu);
    expect(createOfflineRegistry().snapshot().tools).toHaveLength(14);
  });

  it("get returns undefined for an unknown name", () => {
    expect(createOfflineRegistry().get("unknown_tool")).toBeUndefined();
  });

  it("requireAvailable returns an exposed definition", () => {
    expect(
      createOfflineRegistry().requireAvailable("reserve_charging_slot", FULL_CAPABILITY_CONTEXT)
        .name,
    ).toBe("reserve_charging_slot");
  });

  it.each([
    ["reserve_charging_slot", contextWith({ charging: false })],
    ["request_emergency_support", contextWith({}, { emergencySupport: false })],
    ["unknown_tool", FULL_CAPABILITY_CONTEXT],
  ] as const)("requireAvailable rejects unavailable %s", (name, context) => {
    expect(() => createOfflineRegistry().requireAvailable(name, context)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it.each(FORBIDDEN_TOOL_NAMES)("cannot register RX name %s", (name) => {
    const base = createOfflineRegistry().get("get_weather")!;
    expect(() => new ToolRegistry().register(altered(base, { name }))).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN_TOOL" }),
    );
  });

  it.each([
    { name: "Bad-Name" },
    { label: "" },
    { description: "" },
    { riskLevel: "RX" },
    { sideEffect: "yes" },
    { timeoutHintMs: 0 },
    { timeoutHintMs: 60_001 },
    { idempotencyHint: "RETRY_FOREVER" },
    { auditLevel: "SECRET" },
    { requiredCapabilities: ["braking"] },
    { requiredCapabilities: ["navigation", "navigation"] },
    { requiredServices: ["untrusted"] },
    { requiredServices: ["weather", "weather"] },
    { execute: undefined },
    { inputSchema: null },
    { outputSchema: null },
  ])("rejects invalid definition metadata %#", (override) => {
    const base = createOfflineRegistry().get("get_weather")!;
    expect(() => new ToolRegistry().register(altered(base, override))).toThrow(ToolRegistryError);
  });

  it("ToolExecutionError is the capability-unavailable boundary", () => {
    try {
      createOfflineRegistry().requireAvailable(
        "set_seat_heating",
        contextWith({ seatHeating: false }),
      );
      throw new Error("expected capability failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect(error).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    }
  });
});

describe("Phase 4 dynamic resolution", () => {
  const registry = createOfflineRegistry();

  it("resolves all 14 for the full-capability vehicle", () => {
    expect(new Set(names(resolveAvailableTools(registry, FULL_CAPABILITY_CONTEXT)))).toEqual(
      new Set(FORMAL_TOOL_NAMES),
    );
  });

  it.each([
    [
      "no charging",
      contextWith({ charging: false }),
      [
        "search_charging_stations",
        "get_charging_status",
        "reroute_to_charger",
        "reserve_charging_slot",
        "cancel_charging_reservation",
      ],
    ],
    [
      "no navigation",
      contextWith({ navigation: false }),
      ["get_trip_state", "set_navigation_destination", "reroute_to_charger"],
    ],
    ["no seat heating", contextWith({ seatHeating: false }), ["set_seat_heating"]],
    ["no cabin temperature", contextWith({ cabinTemperature: false }), ["set_cabin_temperature"]],
    ["no media", contextWith({ media: false }), ["set_media_volume"]],
    [
      "no roadside support",
      contextWith({ roadsideAssistance: false }),
      ["request_roadside_assistance", "request_emergency_support"],
    ],
  ] as const)("filters exact tools for %s", (_label, context, excluded) => {
    const resolved = names(registry.resolve(context));
    for (const name of excluded) expect(resolved).not.toContain(name);
    expect(resolved).toHaveLength(14 - excluded.length);
  });

  it("filters the union for multiple missing capabilities", () => {
    const resolved = names(registry.resolve(contextWith({ navigation: false, charging: false })));
    expect(resolved).toHaveLength(7);
    expect(resolved).toEqual([
      "get_vehicle_state",
      "get_weather",
      "request_emergency_support",
      "request_roadside_assistance",
      "set_cabin_temperature",
      "set_media_volume",
      "set_seat_heating",
    ]);
  });

  it("keeps only capability-independent reads for zero optional capabilities", () => {
    const resolved = names(
      registry.resolve(
        contextWith({
          navigation: false,
          charging: false,
          cabinTemperature: false,
          seatHeating: false,
          media: false,
          roadsideAssistance: false,
        }),
      ),
    );
    expect(resolved).toEqual(["get_vehicle_state", "get_weather"]);
  });

  it.each([
    ["vehicleSimulator", contextWith({}, { vehicleSimulator: false }), 2],
    ["weather", contextWith({}, { weather: false }), 13],
    ["emergencySupport", contextWith({}, { emergencySupport: false }), 13],
  ] as const)("filters unavailable %s service deterministically", (_service, context, count) => {
    expect(registry.resolve(context)).toHaveLength(count);
  });

  it("resolves zero tools when every service is unavailable", () => {
    expect(
      registry.resolve(
        contextWith({}, { vehicleSimulator: false, weather: false, emergencySupport: false }),
      ),
    ).toEqual([]);
  });

  it.each(FORBIDDEN_TOOL_NAMES)("never dynamically resolves RX name %s", (name) => {
    expect(names(registry.resolve(FULL_CAPABILITY_CONTEXT))).not.toContain(name);
  });
});
