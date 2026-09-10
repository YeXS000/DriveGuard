import { TripStateSchema, VehicleStateSchema } from "@driveguard/domain";
import { Type, type Static, type TSchema } from "typebox";
import Schema from "typebox/schema";

import { ToolExecutionError, type ToolExecutionContext } from "./contracts.js";
import {
  ChargingReservationSchema,
  ChargingStatusOutputSchema,
  RoadsideAssistanceOutputSchema,
  SearchChargingStationsOutputSchema,
} from "./schemas.js";

const CabinTemperatureResponseSchema = Type.Object(
  { cabinTemperature: Type.Number({ minimum: 16, maximum: 30 }) },
  { additionalProperties: false },
);
const SeatHeatingResponseSchema = Type.Object(
  {
    seatHeating: Type.Object(
      {
        driver: Type.Integer({ minimum: 0, maximum: 3 }),
        front_passenger: Type.Integer({ minimum: 0, maximum: 3 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const MediaVolumeResponseSchema = Type.Object(
  { volume: Type.Number({ minimum: 0, maximum: 100 }) },
  { additionalProperties: false },
);
const ReservationResponseSchema = Type.Object(
  { reservation: ChargingReservationSchema },
  { additionalProperties: false },
);
const ContextStateResponseSchema = Type.Object(
  {
    vehicle: VehicleStateSchema,
    trip: TripStateSchema,
    simulationVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export interface SimulatorClientOptions {
  readonly baseUrl: string;
  /** Bound vehicle identity forwarded to the Simulator data plane. */
  readonly vehicleId?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly defaultTimeoutMs?: number;
}

type SimulatorRequestContext = Pick<ToolExecutionContext, "signal" | "idempotencyKey">;

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Simulator baseUrl must be an absolute HTTP URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError("Simulator baseUrl must be a credential-free HTTP URL");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function timeoutValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError("Simulator timeout must be an integer between 1 and 60000 ms");
  }
  return value;
}

export class SimulatorClient {
  readonly #baseUrl: string;
  readonly #vehicleId: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #defaultTimeoutMs: number;

  constructor(options: SimulatorClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    if (
      options.vehicleId !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.vehicleId)
    ) {
      throw new TypeError("Simulator vehicleId must be a valid DriveGuard identity");
    }
    this.#vehicleId = options.vehicleId;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#defaultTimeoutMs = timeoutValue(options.defaultTimeoutMs ?? 2_000);
  }

  getVehicleState(timeoutMs?: number, context?: SimulatorRequestContext) {
    return this.#request("get_vehicle_state", "GET", "/vehicle/state", VehicleStateSchema, {
      timeoutMs,
      ...context,
    });
  }

  getTripState(timeoutMs?: number, context?: SimulatorRequestContext) {
    return this.#request("get_trip_state", "GET", "/trip/state", TripStateSchema, {
      timeoutMs,
      ...context,
    });
  }

  getContextState(timeoutMs?: number, context?: SimulatorRequestContext) {
    return this.#request("get_context_state", "GET", "/context/state", ContextStateResponseSchema, {
      timeoutMs,
      ...context,
    });
  }

  setCabinTemperature(temperatureC: number, timeoutMs?: number, context?: SimulatorRequestContext) {
    return this.#request(
      "set_cabin_temperature",
      "POST",
      "/cabin/temperature",
      CabinTemperatureResponseSchema,
      { body: { temperatureC }, timeoutMs, ...context },
    );
  }

  setSeatHeating(
    seat: "driver" | "front_passenger",
    level: 0 | 1 | 2 | 3,
    timeoutMs?: number,
    context?: SimulatorRequestContext,
  ) {
    return this.#request(
      "set_seat_heating",
      "POST",
      "/cabin/seat-heating",
      SeatHeatingResponseSchema,
      { body: { seat, level }, timeoutMs, ...context },
    );
  }

  setMediaVolume(volume: number, timeoutMs?: number, context?: SimulatorRequestContext) {
    return this.#request("set_media_volume", "POST", "/media/volume", MediaVolumeResponseSchema, {
      body: { volume },
      timeoutMs,
      ...context,
    });
  }

  setNavigationDestination(
    destination: string,
    timeoutMs?: number,
    context?: SimulatorRequestContext,
  ) {
    return this.#request(
      "set_navigation_destination",
      "POST",
      "/navigation/destination",
      TripStateSchema,
      { body: { destination }, timeoutMs, ...context },
    );
  }

  listChargingStations(timeoutMs?: number, context?: SimulatorRequestContext) {
    return this.#request(
      "search_charging_stations",
      "GET",
      "/charging/stations",
      SearchChargingStationsOutputSchema,
      { timeoutMs, ...context },
    );
  }

  getChargingStatus(timeoutMs?: number, context?: SimulatorRequestContext) {
    return this.#request(
      "get_charging_status",
      "GET",
      "/charging/status",
      ChargingStatusOutputSchema,
      { timeoutMs, ...context },
    );
  }

  createChargingReservation(
    stationId: string,
    timeoutMs?: number,
    context?: SimulatorRequestContext,
  ) {
    return this.#request(
      "reserve_charging_slot",
      "POST",
      "/charging/reservations",
      ReservationResponseSchema,
      { body: { stationId }, timeoutMs, ...context },
    );
  }

  async cancelChargingReservation(
    reservationId: string,
    timeoutMs?: number,
    context?: SimulatorRequestContext,
  ): Promise<void> {
    await this.#requestEmpty(
      "cancel_charging_reservation",
      "DELETE",
      `/charging/reservations/${encodeURIComponent(reservationId)}`,
      timeoutMs,
      context,
    );
  }

  requestRoadsideAssistance(reason: string, timeoutMs?: number, context?: SimulatorRequestContext) {
    return this.#request(
      "request_roadside_assistance",
      "POST",
      "/assistance/roadside",
      RoadsideAssistanceOutputSchema,
      { body: { reason }, timeoutMs, ...context },
    );
  }

  async #request<const TSchemaValue extends TSchema>(
    toolName: string,
    method: "GET" | "POST",
    path: string,
    schema: TSchemaValue,
    options: {
      readonly body?: object;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal;
      readonly idempotencyKey?: string;
    },
  ): Promise<Static<TSchemaValue>> {
    const response = await this.#fetchResponse(toolName, method, path, options);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ToolExecutionError(
        "DEPENDENCY_RESPONSE_INVALID",
        toolName,
        "Simulator returned invalid JSON",
      );
    }
    const validator = Schema.Compile(schema);
    if (!validator.Check(value)) {
      throw new ToolExecutionError(
        "DEPENDENCY_RESPONSE_INVALID",
        toolName,
        "Simulator response failed validation",
      );
    }
    return structuredClone(value);
  }

  async #requestEmpty(
    toolName: string,
    method: "DELETE",
    path: string,
    timeoutMs?: number,
    context?: SimulatorRequestContext,
  ): Promise<void> {
    const response = await this.#fetchResponse(toolName, method, path, { timeoutMs, ...context });
    if (response.status !== 204) {
      throw new ToolExecutionError(
        "DEPENDENCY_RESPONSE_INVALID",
        toolName,
        "Simulator returned an unexpected success status",
      );
    }
  }

  async #fetchResponse(
    toolName: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: {
      readonly body?: object;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal;
      readonly idempotencyKey?: string;
    },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = timeoutValue(options.timeoutMs ?? this.#defaultTimeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const signal =
        options.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, options.signal]);
      const headers = {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.#vehicleId === undefined ? {} : { "x-driveguard-vehicle-id": this.#vehicleId }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { "idempotency-key": options.idempotencyKey }),
      };
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(options.body === undefined
          ? {}
          : {
              body: JSON.stringify(options.body),
            }),
      });
      if (!response.ok) this.#throwForStatus(toolName, response.status);
      return response;
    } catch (error) {
      if (error instanceof ToolExecutionError) throw error;
      if (controller.signal.aborted) {
        throw new ToolExecutionError(
          "DEPENDENCY_TIMEOUT",
          toolName,
          "Simulator request timed out",
          "TIMEOUT",
        );
      }
      if (options.signal?.aborted === true) {
        throw new ToolExecutionError(
          "DEPENDENCY_UNAVAILABLE",
          toolName,
          "Simulator request aborted",
          "CONNECTION_ABORT",
        );
      }
      throw new ToolExecutionError(
        "DEPENDENCY_UNAVAILABLE",
        toolName,
        "Simulator request failed",
        "CONNECTION_ABORT",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #throwForStatus(toolName: string, status: number): never {
    if (status === 404) {
      throw new ToolExecutionError("RESOURCE_NOT_FOUND", toolName, "Simulator resource not found");
    }
    if (status === 409) {
      throw new ToolExecutionError("CONFLICT", toolName, "Simulator reported a conflict");
    }
    if (status >= 500) {
      throw new ToolExecutionError(
        "DEPENDENCY_UNAVAILABLE",
        toolName,
        "Simulator dependency is unavailable",
        status === 503 ? "HTTP_503" : "DEFINITE_FAILURE",
      );
    }
    throw new ToolExecutionError(
      "DEPENDENCY_RESPONSE_INVALID",
      toolName,
      "Simulator rejected a validated request",
    );
  }
}
