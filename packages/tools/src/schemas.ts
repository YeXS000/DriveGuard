import { TripStateSchema, UtcTimestampSchema, VehicleStateSchema } from "@driveguard/domain";
import { Type } from "typebox";

export const EmptyInputSchema = Type.Object({}, { additionalProperties: false });

export const WeatherOutputSchema = Type.Object(
  {
    condition: Type.Enum(["clear", "rain", "snow", "fog", "wind", "unknown"]),
    temperatureC: Type.Number({ minimum: -60, maximum: 60 }),
    source: Type.Literal("DEVELOPMENT_PROVIDER"),
  },
  { additionalProperties: false },
);

export const ChargingStationSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    latitude: Type.Number({ minimum: -90, maximum: 90 }),
    longitude: Type.Number({ minimum: -180, maximum: 180 }),
    availableSlots: Type.Integer({ minimum: 0 }),
    maxPowerKw: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: false },
);

export const ChargingReservationSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    stationId: Type.String({ minLength: 1, maxLength: 128 }),
    createdAt: UtcTimestampSchema,
    status: Type.Literal("active"),
  },
  { additionalProperties: false },
);

export const AssistanceRequestSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    reason: Type.String({ minLength: 1, maxLength: 512 }),
    createdAt: UtcTimestampSchema,
    status: Type.Literal("requested"),
  },
  { additionalProperties: false },
);

export const SearchChargingStationsOutputSchema = Type.Object(
  { stations: Type.Array(ChargingStationSchema) },
  { additionalProperties: false },
);

export const ChargingStatusOutputSchema = Type.Object(
  {
    chargingState: Type.Enum(["not_charging", "charging", "completed", "fault"]),
    reservations: Type.Array(ChargingReservationSchema),
  },
  { additionalProperties: false },
);

export const SetCabinTemperatureInputSchema = Type.Object(
  { temperatureC: Type.Number({ minimum: 16, maximum: 30 }) },
  { additionalProperties: false },
);
export const SetCabinTemperatureOutputSchema = Type.Object(
  {
    applied: Type.Boolean(),
    previousTemperatureC: Type.Number({ minimum: 16, maximum: 30 }),
    currentTemperatureC: Type.Number({ minimum: 16, maximum: 30 }),
  },
  { additionalProperties: false },
);

export const SetSeatHeatingInputSchema = Type.Object(
  {
    seat: Type.Enum(["driver", "front_passenger"]),
    level: Type.Enum([0, 1, 2, 3]),
  },
  { additionalProperties: false },
);
export const SetSeatHeatingOutputSchema = Type.Object(
  {
    applied: Type.Boolean(),
    seat: Type.Enum(["driver", "front_passenger"]),
    level: Type.Enum([0, 1, 2, 3]),
  },
  { additionalProperties: false },
);

export const SetMediaVolumeInputSchema = Type.Object(
  { volume: Type.Number({ minimum: 0, maximum: 100 }) },
  { additionalProperties: false },
);
export const SetMediaVolumeOutputSchema = Type.Object(
  { applied: Type.Boolean(), volume: Type.Number({ minimum: 0, maximum: 100 }) },
  { additionalProperties: false },
);

export const SetNavigationDestinationInputSchema = Type.Object(
  { destination: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);
export const RerouteToChargerInputSchema = Type.Object(
  { stationId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);

export const ReserveChargingSlotInputSchema = Type.Object(
  { stationId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
export const ReserveChargingSlotOutputSchema = Type.Object(
  { reservation: ChargingReservationSchema },
  { additionalProperties: false },
);

export const CancelChargingReservationInputSchema = Type.Object(
  { reservationId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
export const CancelChargingReservationOutputSchema = Type.Object(
  {
    cancelled: Type.Literal(true),
    reservationId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const RoadsideAssistanceInputSchema = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);
export const RoadsideAssistanceOutputSchema = Type.Object(
  { request: AssistanceRequestSchema },
  { additionalProperties: false },
);

export const EmergencySupportInputSchema = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);
export const EmergencySupportOutputSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1, maxLength: 128 }),
    status: Type.Literal("requested"),
    source: Type.Literal("DEVELOPMENT_PROVIDER"),
  },
  { additionalProperties: false },
);

export const FORMAL_TOOL_SCHEMAS = Object.freeze({
  get_vehicle_state: { inputSchema: EmptyInputSchema, outputSchema: VehicleStateSchema },
  get_trip_state: { inputSchema: EmptyInputSchema, outputSchema: TripStateSchema },
  get_weather: { inputSchema: EmptyInputSchema, outputSchema: WeatherOutputSchema },
  search_charging_stations: {
    inputSchema: EmptyInputSchema,
    outputSchema: SearchChargingStationsOutputSchema,
  },
  get_charging_status: {
    inputSchema: EmptyInputSchema,
    outputSchema: ChargingStatusOutputSchema,
  },
  set_cabin_temperature: {
    inputSchema: SetCabinTemperatureInputSchema,
    outputSchema: SetCabinTemperatureOutputSchema,
  },
  set_seat_heating: {
    inputSchema: SetSeatHeatingInputSchema,
    outputSchema: SetSeatHeatingOutputSchema,
  },
  set_media_volume: {
    inputSchema: SetMediaVolumeInputSchema,
    outputSchema: SetMediaVolumeOutputSchema,
  },
  set_navigation_destination: {
    inputSchema: SetNavigationDestinationInputSchema,
    outputSchema: TripStateSchema,
  },
  reroute_to_charger: {
    inputSchema: RerouteToChargerInputSchema,
    outputSchema: TripStateSchema,
  },
  reserve_charging_slot: {
    inputSchema: ReserveChargingSlotInputSchema,
    outputSchema: ReserveChargingSlotOutputSchema,
  },
  cancel_charging_reservation: {
    inputSchema: CancelChargingReservationInputSchema,
    outputSchema: CancelChargingReservationOutputSchema,
  },
  request_roadside_assistance: {
    inputSchema: RoadsideAssistanceInputSchema,
    outputSchema: RoadsideAssistanceOutputSchema,
  },
  request_emergency_support: {
    inputSchema: EmergencySupportInputSchema,
    outputSchema: EmergencySupportOutputSchema,
  },
});
