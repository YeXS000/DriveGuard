export const SIMULATOR_ERROR_CODES = [
  "VALIDATION_ERROR",
  "SCENARIO_NOT_FOUND",
  "INVALID_TRANSITION",
  "STATION_NOT_FOUND",
  "NO_AVAILABLE_SLOT",
  "RESERVATION_NOT_FOUND",
  "FAULT_INJECTED",
  "INTERNAL_ERROR",
] as const;

export type SimulatorErrorCode = (typeof SIMULATOR_ERROR_CODES)[number];

export class SimulatorError extends Error {
  readonly code: SimulatorErrorCode;
  readonly statusCode: number;

  constructor(code: SimulatorErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "SimulatorError";
    this.code = code;
    this.statusCode = statusCode;
  }

  toJSON(): { readonly error: { readonly code: SimulatorErrorCode; readonly message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export function validationError(message: string): SimulatorError {
  return new SimulatorError("VALIDATION_ERROR", message, 400);
}
