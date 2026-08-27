import type { CapabilityName } from "@driveguard/capabilities";
import type { Static, TSchema } from "typebox";
import Schema from "typebox/schema";

import {
  type AuditLevel,
  type FormalToolName,
  type IdempotencyHint,
  ToolExecutionError,
  type ToolDefinition,
  type ToolRiskLevel,
} from "./contracts.js";
import type { EmergencySupportProvider, WeatherProvider } from "./providers.js";
import { FORMAL_TOOL_SCHEMAS } from "./schemas.js";
import type { SimulatorClient } from "./simulator-client.js";

export const CAPABILITY_TOOL_MAPPING = Object.freeze({
  navigation: Object.freeze([
    "get_trip_state",
    "set_navigation_destination",
    "reroute_to_charger",
  ] as const),
  charging: Object.freeze([
    "search_charging_stations",
    "get_charging_status",
    "reroute_to_charger",
    "reserve_charging_slot",
    "cancel_charging_reservation",
  ] as const),
  cabinTemperature: Object.freeze(["set_cabin_temperature"] as const),
  seatHeating: Object.freeze(["set_seat_heating"] as const),
  media: Object.freeze(["set_media_volume"] as const),
  roadsideAssistance: Object.freeze([
    "request_roadside_assistance",
    "request_emergency_support",
  ] as const),
} satisfies Record<CapabilityName, readonly FormalToolName[]>);

export interface DriveGuardToolDependencies {
  readonly simulator: SimulatorClient;
  readonly weatherProvider: WeatherProvider;
  readonly emergencySupportProvider: EmergencySupportProvider;
}

interface DefinitionOptions<I extends TSchema, O extends TSchema> {
  readonly name: FormalToolName;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: I;
  readonly outputSchema: O;
  readonly riskLevel: ToolRiskLevel;
  readonly requiredCapabilities: readonly CapabilityName[];
  readonly requiredServices: ToolDefinition["requiredServices"];
  readonly sideEffect: boolean;
  readonly timeoutHintMs: number;
  readonly idempotencyHint: IdempotencyHint;
  readonly auditLevel: AuditLevel;
  readonly handler: (input: Static<I>) => Promise<unknown>;
}

function defineTool<I extends TSchema, O extends TSchema>(
  options: DefinitionOptions<I, O>,
): ToolDefinition<I, O> {
  const inputValidator = Schema.Compile(options.inputSchema);
  const outputValidator = Schema.Compile(options.outputSchema);
  return Object.freeze({
    name: options.name,
    label: options.label,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    riskLevel: options.riskLevel,
    requiredCapabilities: Object.freeze([...options.requiredCapabilities]),
    requiredServices: Object.freeze([...options.requiredServices]),
    sideEffect: options.sideEffect,
    timeoutHintMs: options.timeoutHintMs,
    idempotencyHint: options.idempotencyHint,
    auditLevel: options.auditLevel,
    execute: async (input: Static<I>): Promise<Static<O>> => {
      if (!inputValidator.Check(input)) {
        throw new ToolExecutionError(
          "TOOL_VALIDATION_ERROR",
          options.name,
          "Tool arguments failed validation",
        );
      }
      let clonedInput: Static<I>;
      try {
        clonedInput = structuredClone(input);
      } catch {
        throw new ToolExecutionError(
          "TOOL_VALIDATION_ERROR",
          options.name,
          "Tool arguments must be cloneable data",
        );
      }
      let output: unknown;
      try {
        output = await options.handler(clonedInput);
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        throw new ToolExecutionError(
          "DEPENDENCY_UNAVAILABLE",
          options.name,
          "Tool dependency failed",
        );
      }
      if (!outputValidator.Check(output)) {
        throw new ToolExecutionError(
          "DEPENDENCY_RESPONSE_INVALID",
          options.name,
          "Tool output failed validation",
        );
      }
      try {
        return structuredClone(output);
      } catch {
        throw new ToolExecutionError(
          "DEPENDENCY_RESPONSE_INVALID",
          options.name,
          "Tool output must be cloneable data",
        );
      }
    },
  });
}

export function createFormalToolDefinitions(
  dependencies: DriveGuardToolDependencies,
): readonly ToolDefinition[] {
  const { simulator, weatherProvider, emergencySupportProvider } = dependencies;
  const definitions: ToolDefinition[] = [
    defineTool({
      name: "get_vehicle_state",
      label: "Get vehicle state",
      description: "Read the current validated vehicle state.",
      ...FORMAL_TOOL_SCHEMAS.get_vehicle_state,
      riskLevel: "R0",
      requiredCapabilities: [],
      requiredServices: ["vehicleSimulator"],
      sideEffect: false,
      timeoutHintMs: 1_000,
      idempotencyHint: "READ_ONLY",
      auditLevel: "BASIC",
      handler: () => simulator.getVehicleState(1_000),
    }),
    defineTool({
      name: "get_trip_state",
      label: "Get trip state",
      description: "Read the current validated navigation and trip state.",
      ...FORMAL_TOOL_SCHEMAS.get_trip_state,
      riskLevel: "R0",
      requiredCapabilities: ["navigation"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: false,
      timeoutHintMs: 1_000,
      idempotencyHint: "READ_ONLY",
      auditLevel: "BASIC",
      handler: () => simulator.getTripState(1_000),
    }),
    defineTool({
      name: "get_weather",
      label: "Get weather",
      description: "Read deterministic development weather data.",
      ...FORMAL_TOOL_SCHEMAS.get_weather,
      riskLevel: "R0",
      requiredCapabilities: [],
      requiredServices: ["weather"],
      sideEffect: false,
      timeoutHintMs: 1_000,
      idempotencyHint: "READ_ONLY",
      auditLevel: "BASIC",
      handler: () => weatherProvider.getWeather(),
    }),
    defineTool({
      name: "search_charging_stations",
      label: "Search charging stations",
      description: "List charging stations exposed by the simulator.",
      ...FORMAL_TOOL_SCHEMAS.search_charging_stations,
      riskLevel: "R0",
      requiredCapabilities: ["charging"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: false,
      timeoutHintMs: 1_000,
      idempotencyHint: "READ_ONLY",
      auditLevel: "BASIC",
      handler: () => simulator.listChargingStations(1_000),
    }),
    defineTool({
      name: "get_charging_status",
      label: "Get charging status",
      description: "Read charging state and active reservations.",
      ...FORMAL_TOOL_SCHEMAS.get_charging_status,
      riskLevel: "R0",
      requiredCapabilities: ["charging"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: false,
      timeoutHintMs: 1_000,
      idempotencyHint: "READ_ONLY",
      auditLevel: "BASIC",
      handler: () => simulator.getChargingStatus(1_000),
    }),
    defineTool({
      name: "set_cabin_temperature",
      label: "Set cabin temperature",
      description: "Set the cabin temperature within the validated demo range.",
      ...FORMAL_TOOL_SCHEMAS.set_cabin_temperature,
      riskLevel: "R1",
      requiredCapabilities: ["cabinTemperature"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: true,
      timeoutHintMs: 2_000,
      idempotencyHint: "IDEMPOTENT",
      auditLevel: "STANDARD",
      handler: async ({ temperatureC }) => {
        const previous = await simulator.getVehicleState(2_000);
        const current = await simulator.setCabinTemperature(temperatureC, 2_000);
        return {
          applied: true,
          previousTemperatureC: previous.cabinTemperature,
          currentTemperatureC: current.cabinTemperature,
        };
      },
    }),
    defineTool({
      name: "set_seat_heating",
      label: "Set seat heating",
      description: "Set a supported seat-heating level.",
      ...FORMAL_TOOL_SCHEMAS.set_seat_heating,
      riskLevel: "R1",
      requiredCapabilities: ["seatHeating"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: true,
      timeoutHintMs: 2_000,
      idempotencyHint: "IDEMPOTENT",
      auditLevel: "STANDARD",
      handler: async ({ seat, level }) => {
        const result = await simulator.setSeatHeating(seat, level, 2_000);
        return { applied: true, seat, level: result.seatHeating[seat] };
      },
    }),
    defineTool({
      name: "set_media_volume",
      label: "Set media volume",
      description: "Set the cabin media volume.",
      ...FORMAL_TOOL_SCHEMAS.set_media_volume,
      riskLevel: "R1",
      requiredCapabilities: ["media"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: true,
      timeoutHintMs: 2_000,
      idempotencyHint: "IDEMPOTENT",
      auditLevel: "STANDARD",
      handler: async ({ volume }) => ({
        applied: true,
        volume: (await simulator.setMediaVolume(volume, 2_000)).volume,
      }),
    }),
    defineTool({
      name: "set_navigation_destination",
      label: "Set navigation destination",
      description: "Set a new navigation destination.",
      ...FORMAL_TOOL_SCHEMAS.set_navigation_destination,
      riskLevel: "R2",
      requiredCapabilities: ["navigation"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: true,
      timeoutHintMs: 3_000,
      idempotencyHint: "IDEMPOTENT",
      auditLevel: "HIGH",
      handler: ({ destination }) => simulator.setNavigationDestination(destination, 3_000),
    }),
    defineTool({
      name: "reroute_to_charger",
      label: "Reroute to charger",
      description: "Set navigation to a selected available charging station.",
      ...FORMAL_TOOL_SCHEMAS.reroute_to_charger,
      riskLevel: "R2",
      requiredCapabilities: ["navigation", "charging"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: true,
      timeoutHintMs: 3_000,
      idempotencyHint: "IDEMPOTENT",
      auditLevel: "HIGH",
      handler: async ({ stationId }) => {
        const stations = await simulator.listChargingStations(3_000);
        const station = stations.stations.find((candidate) => candidate.id === stationId);
        if (station === undefined) {
          throw new ToolExecutionError(
            "RESOURCE_NOT_FOUND",
            "reroute_to_charger",
            "Charging station was not found",
          );
        }
        return simulator.setNavigationDestination(station.name, 3_000);
      },
    }),
    defineTool({
      name: "reserve_charging_slot",
      label: "Reserve charging slot",
      description: "Create a charging reservation for a station.",
      ...FORMAL_TOOL_SCHEMAS.reserve_charging_slot,
      riskLevel: "R2",
      requiredCapabilities: ["charging"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: true,
      timeoutHintMs: 3_000,
      idempotencyHint: "NON_IDEMPOTENT",
      auditLevel: "HIGH",
      handler: ({ stationId }) => simulator.createChargingReservation(stationId, 3_000),
    }),
    defineTool({
      name: "cancel_charging_reservation",
      label: "Cancel charging reservation",
      description: "Cancel an existing charging reservation.",
      ...FORMAL_TOOL_SCHEMAS.cancel_charging_reservation,
      riskLevel: "R2",
      requiredCapabilities: ["charging"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: true,
      timeoutHintMs: 3_000,
      idempotencyHint: "IDEMPOTENT",
      auditLevel: "HIGH",
      handler: async ({ reservationId }) => {
        await simulator.cancelChargingReservation(reservationId, 3_000);
        return { cancelled: true as const, reservationId };
      },
    }),
    defineTool({
      name: "request_roadside_assistance",
      label: "Request roadside assistance",
      description: "Request deterministic simulator roadside support.",
      ...FORMAL_TOOL_SCHEMAS.request_roadside_assistance,
      riskLevel: "R3",
      requiredCapabilities: ["roadsideAssistance"],
      requiredServices: ["vehicleSimulator"],
      sideEffect: true,
      timeoutHintMs: 5_000,
      idempotencyHint: "NON_IDEMPOTENT",
      auditLevel: "HIGH",
      handler: ({ reason }) => simulator.requestRoadsideAssistance(reason, 5_000),
    }),
    defineTool({
      name: "request_emergency_support",
      label: "Request emergency support",
      description: "Request deterministic development emergency support; not a live service.",
      ...FORMAL_TOOL_SCHEMAS.request_emergency_support,
      riskLevel: "R3",
      requiredCapabilities: ["roadsideAssistance"],
      requiredServices: ["emergencySupport"],
      sideEffect: true,
      timeoutHintMs: 5_000,
      idempotencyHint: "NON_IDEMPOTENT",
      auditLevel: "HIGH",
      handler: ({ reason }) => emergencySupportProvider.requestEmergencySupport(reason),
    }),
  ];
  return Object.freeze(definitions);
}
