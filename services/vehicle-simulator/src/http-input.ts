import { validationError } from "./errors.js";
import { FAULT_MODES, FAULT_TARGETS, type FaultConfig } from "./types.js";

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationError("Request body must be an object");
  }
  return input as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw validationError("Request body contains unsupported fields");
  }
}

function finiteNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw validationError(`${key} must be a finite number`);
  }
  return value;
}

function stringValue(input: Record<string, unknown>, key: string, maxLength = 512): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw validationError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

export function parseTemperatureBody(input: unknown): number {
  const body = record(input);
  exactKeys(body, ["temperatureC"]);
  return finiteNumber(body, "temperatureC");
}

export function parseSeatHeatingBody(input: unknown): {
  readonly seat: "driver" | "front_passenger";
  readonly level: 0 | 1 | 2 | 3;
} {
  const body = record(input);
  exactKeys(body, ["seat", "level"]);
  const seat = stringValue(body, "seat");
  const level = finiteNumber(body, "level");
  if (seat !== "driver" && seat !== "front_passenger") {
    throw validationError("seat must be driver or front_passenger");
  }
  if (![0, 1, 2, 3].includes(level)) throw validationError("level must be 0, 1, 2, or 3");
  return { seat, level: level as 0 | 1 | 2 | 3 };
}

export function parseVolumeBody(input: unknown): number {
  const body = record(input);
  exactKeys(body, ["volume"]);
  return finiteNumber(body, "volume");
}

export function parseDestinationBody(input: unknown): string {
  const body = record(input);
  exactKeys(body, ["destination"]);
  return stringValue(body, "destination");
}

export function parseStationBody(input: unknown): string {
  const body = record(input);
  exactKeys(body, ["stationId"]);
  return stringValue(body, "stationId", 128);
}

export function parseAssistanceBody(input: unknown): string {
  const body = record(input);
  exactKeys(body, ["reason"]);
  return stringValue(body, "reason", 512);
}

export function parseResetBody(input: unknown): {
  readonly scenario: string;
  readonly seed: number;
} {
  const body = record(input);
  exactKeys(body, ["scenario", "seed"]);
  const scenario = stringValue(body, "scenario");
  const seed = finiteNumber(body, "seed");
  return { scenario, seed };
}

export function parseFaultBody(input: unknown): FaultConfig {
  const body = record(input);
  exactKeys(body, ["target", "mode", "probability", "delayMs"]);
  const target = stringValue(body, "target");
  const mode = stringValue(body, "mode");
  const probability = finiteNumber(body, "probability");
  const delayMs = finiteNumber(body, "delayMs");
  return {
    target: target as (typeof FAULT_TARGETS)[number],
    mode: mode as (typeof FAULT_MODES)[number],
    probability,
    delayMs,
  };
}

export function parseSpeedBody(input: unknown): number {
  const body = record(input);
  exactKeys(body, ["speedKph"]);
  return finiteNumber(body, "speedKph");
}

export function parseSocBody(input: unknown): number {
  const body = record(input);
  exactKeys(body, ["soc"]);
  return finiteNumber(body, "soc");
}

export function parseIdParameter(input: unknown): string {
  if (typeof input !== "object" || input === null) throw validationError("id is required");
  return stringValue(input as Record<string, unknown>, "id", 128);
}
