import { VehicleCapabilitiesSchema } from "@driveguard/domain";
import { Type, type Static } from "typebox";

export const CAPABILITY_NAMES = [
  "navigation",
  "charging",
  "cabinTemperature",
  "seatHeating",
  "media",
  "roadsideAssistance",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export const SERVICE_NAMES = ["vehicleSimulator", "weather", "emergencySupport"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export const ServiceAvailabilitySchema = Type.Readonly(
  Type.Object(
    {
      vehicleSimulator: Type.Boolean(),
      weather: Type.Boolean(),
      emergencySupport: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);
export type ServiceAvailability = Static<typeof ServiceAvailabilitySchema>;

export const CapabilityResolutionContextSchema = Type.Readonly(
  Type.Object(
    {
      capabilities: VehicleCapabilitiesSchema,
      services: ServiceAvailabilitySchema,
    },
    { additionalProperties: false },
  ),
);
export type CapabilityResolutionContext = Static<typeof CapabilityResolutionContextSchema>;

export interface AvailabilityRequirements {
  readonly requiredCapabilities: readonly CapabilityName[];
  readonly requiredServices: readonly ServiceName[];
}
