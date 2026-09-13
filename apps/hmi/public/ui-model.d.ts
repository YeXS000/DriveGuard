export interface ErrorPresentation {
  readonly title: string;
  readonly message: string;
  readonly tone: "danger" | "info" | "warning";
  readonly retryable: boolean;
}

export interface ExecutionPresentation {
  readonly status: string;
  readonly label: string;
  readonly cssClass: "completed" | "failed";
  readonly successful: boolean;
}

export interface VehiclePresentation {
  readonly speed: string;
  readonly soc: number | null;
  readonly range: string;
  readonly gear: string;
  readonly mode: string;
  readonly cabin: string;
  readonly outside: string;
  readonly chargingState: string;
  readonly chargingActive: boolean;
  readonly chargingFault: boolean;
  readonly destination: string;
  readonly distance: string;
  readonly eta: string;
  readonly snapshot: string;
  readonly vehicleVersion: string | number;
  readonly tripVersion: string | number;
  readonly updatedAt: string | null;
}

export function errorPresentation(code: string): ErrorPresentation;
export function humanizeIdentifier(value: unknown): string;
export function actionTarget(parameters: unknown): string;
export function executionPresentation(execution: unknown): ExecutionPresentation;
export function vehiclePresentation(context: unknown): VehiclePresentation;
