import { Type } from "typebox";

declare const vehicleIdBrand: unique symbol;
declare const contextSnapshotIdBrand: unique symbol;
declare const contextVersionBrand: unique symbol;
declare const stateVersionBrand: unique symbol;
declare const routeIdBrand: unique symbol;
declare const userIdBrand: unique symbol;
declare const utcTimestampBrand: unique symbol;

export type VehicleId = string & { readonly [vehicleIdBrand]: "VehicleId" };
export type ContextSnapshotId = string & {
  readonly [contextSnapshotIdBrand]: "ContextSnapshotId";
};
export type ContextVersion = number & { readonly [contextVersionBrand]: "ContextVersion" };
export type StateVersion = number & { readonly [stateVersionBrand]: "StateVersion" };
export type RouteId = string & { readonly [routeIdBrand]: "RouteId" };
export type UserId = string & { readonly [userIdBrand]: "UserId" };
export type UtcTimestamp = string & { readonly [utcTimestampBrand]: "UtcTimestamp" };

const identifierOptions = {
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;

export const VehicleIdSchema = Type.Unsafe<VehicleId>(Type.String(identifierOptions));
export const ContextSnapshotIdSchema = Type.Unsafe<ContextSnapshotId>(
  Type.String(identifierOptions),
);
export const RouteIdSchema = Type.Unsafe<RouteId>(Type.String(identifierOptions));
export const UserIdSchema = Type.Unsafe<UserId>(Type.String(identifierOptions));

const versionSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export const ContextVersionSchema = Type.Unsafe<ContextVersion>(versionSchema);
export const StateVersionSchema = Type.Unsafe<StateVersion>(versionSchema);

export const UTC_TIMESTAMP_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

export const UtcTimestampSchema = Type.Unsafe<UtcTimestamp>(
  Type.String({ pattern: UTC_TIMESTAMP_PATTERN }),
);
