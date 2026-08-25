import { Type, type Static } from "typebox";

import {
  ContextSnapshotIdSchema,
  ContextVersionSchema,
  RouteIdSchema,
  StateVersionSchema,
  UserIdSchema,
  UtcTimestampSchema,
  VehicleIdSchema,
} from "./identifiers.js";

export const GearSchema = Type.Enum(["P", "R", "N", "D"]);
export type Gear = Static<typeof GearSchema>;

export const DriveModeSchema = Type.Enum(["parked", "driving", "charging"]);
export type DriveMode = Static<typeof DriveModeSchema>;

export const ChargingStateSchema = Type.Enum(["not_charging", "charging", "completed", "fault"]);
export type ChargingState = Static<typeof ChargingStateSchema>;

export const DoorStateSchema = Type.Enum(["open", "closed", "locked"]);
export type DoorState = Static<typeof DoorStateSchema>;

export const WindowStateSchema = Type.Enum(["open", "closed", "partially_open"]);
export type WindowState = Static<typeof WindowStateSchema>;

export const OccupantSeatSchema = Type.Enum([
  "driver",
  "front_passenger",
  "rear_left",
  "rear_center",
  "rear_right",
]);
export type OccupantSeat = Static<typeof OccupantSeatSchema>;

export const OccupantStateSchema = Type.Readonly(
  Type.Object(
    {
      seat: OccupantSeatSchema,
      presence: Type.Enum(["vacant", "occupied"]),
    },
    { additionalProperties: false },
  ),
);
export type OccupantState = Static<typeof OccupantStateSchema>;

export const DoorStatesSchema = Type.Readonly(
  Type.Object(
    {
      frontLeft: DoorStateSchema,
      frontRight: DoorStateSchema,
      rearLeft: DoorStateSchema,
      rearRight: DoorStateSchema,
      trunk: DoorStateSchema,
    },
    { additionalProperties: false },
  ),
);
export type DoorStates = Static<typeof DoorStatesSchema>;

export const WindowStatesSchema = Type.Readonly(
  Type.Object(
    {
      frontLeft: WindowStateSchema,
      frontRight: WindowStateSchema,
      rearLeft: WindowStateSchema,
      rearRight: WindowStateSchema,
    },
    { additionalProperties: false },
  ),
);
export type WindowStates = Static<typeof WindowStatesSchema>;

/** Demo engineering bounds, not claimed as real-vehicle industry limits. */
export const VEHICLE_DEMO_LIMITS = Object.freeze({
  maxSpeedKph: 500,
  maxEstimatedRangeKm: 5_000,
  minCabinTemperatureC: 16,
  maxCabinTemperatureC: 30,
  minOutsideTemperatureC: -60,
  maxOutsideTemperatureC: 60,
});

export const VehicleStateSchema = Type.Readonly(
  Type.Object(
    {
      vehicleId: VehicleIdSchema,
      timestamp: UtcTimestampSchema,
      version: StateVersionSchema,
      speedKph: Type.Number({ minimum: 0, maximum: VEHICLE_DEMO_LIMITS.maxSpeedKph }),
      gear: GearSchema,
      driveMode: DriveModeSchema,
      soc: Type.Number({ minimum: 0, maximum: 100 }),
      chargingState: ChargingStateSchema,
      estimatedRangeKm: Type.Number({
        minimum: 0,
        maximum: VEHICLE_DEMO_LIMITS.maxEstimatedRangeKm,
      }),
      latitude: Type.Number({ minimum: -90, maximum: 90 }),
      longitude: Type.Number({ minimum: -180, maximum: 180 }),
      doors: DoorStatesSchema,
      windows: WindowStatesSchema,
      cabinTemperature: Type.Number({
        minimum: VEHICLE_DEMO_LIMITS.minCabinTemperatureC,
        maximum: VEHICLE_DEMO_LIMITS.maxCabinTemperatureC,
      }),
      outsideTemperature: Type.Number({
        minimum: VEHICLE_DEMO_LIMITS.minOutsideTemperatureC,
        maximum: VEHICLE_DEMO_LIMITS.maxOutsideTemperatureC,
      }),
      occupants: Type.Readonly(Type.Array(OccupantStateSchema, { maxItems: 5 })),
    },
    { additionalProperties: false },
  ),
);
export type VehicleState = Static<typeof VehicleStateSchema>;

export const TRIP_DEMO_LIMITS = Object.freeze({
  maxRemainingDistanceKm: 100_000,
  maxEtaMinutes: 525_600,
});

export const TripStateSchema = Type.Readonly(
  Type.Object(
    {
      timestamp: UtcTimestampSchema,
      version: StateVersionSchema,
      destination: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
      routeId: Type.Union([RouteIdSchema, Type.Null()]),
      remainingDistanceKm: Type.Number({
        minimum: 0,
        maximum: TRIP_DEMO_LIMITS.maxRemainingDistanceKm,
      }),
      etaMinutes: Type.Number({ minimum: 0, maximum: TRIP_DEMO_LIMITS.maxEtaMinutes }),
      navigationActive: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);
export type TripState = Static<typeof TripStateSchema>;

export const WeatherStateSchema = Type.Readonly(
  Type.Object(
    {
      condition: Type.Enum(["clear", "rain", "snow", "fog", "wind", "unknown"]),
      temperatureC: Type.Number({
        minimum: VEHICLE_DEMO_LIMITS.minOutsideTemperatureC,
        maximum: VEHICLE_DEMO_LIMITS.maxOutsideTemperatureC,
      }),
    },
    { additionalProperties: false },
  ),
);
export type WeatherState = Static<typeof WeatherStateSchema>;

export const DrivingUserSchema = Type.Readonly(
  Type.Object(
    {
      userId: UserIdSchema,
      role: Type.Enum(["driver", "passenger", "guest"]),
    },
    { additionalProperties: false },
  ),
);
export type DrivingUser = Static<typeof DrivingUserSchema>;

export const VehicleCapabilitiesSchema = Type.Readonly(
  Type.Object(
    {
      navigation: Type.Boolean(),
      charging: Type.Boolean(),
      cabinTemperature: Type.Boolean(),
      seatHeating: Type.Boolean(),
      media: Type.Boolean(),
      roadsideAssistance: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);
export type VehicleCapabilities = Static<typeof VehicleCapabilitiesSchema>;

export const DrivingContextSchema = Type.Readonly(
  Type.Object(
    {
      vehicle: VehicleStateSchema,
      trip: TripStateSchema,
      weather: WeatherStateSchema,
      user: DrivingUserSchema,
      capabilities: VehicleCapabilitiesSchema,
      capturedAt: UtcTimestampSchema,
      contextVersion: ContextVersionSchema,
      snapshotId: ContextSnapshotIdSchema,
    },
    { additionalProperties: false },
  ),
);
export type DrivingContext = Static<typeof DrivingContextSchema>;
export type ContextSnapshot = DrivingContext;
