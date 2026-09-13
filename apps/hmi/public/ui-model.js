const ERROR_PRESENTATIONS = Object.freeze({
  AUTHENTICATION_REQUIRED: Object.freeze({
    title: "Sign-in required",
    message: "Add a valid Bearer token in connection settings and try again.",
    tone: "warning",
    retryable: false,
  }),
  AUTHENTICATION_INVALID: Object.freeze({
    title: "Session authentication failed",
    message: "The current credential is invalid or expired. Update it before continuing.",
    tone: "warning",
    retryable: false,
  }),
  VEHICLE_FORBIDDEN: Object.freeze({
    title: "Vehicle access unavailable",
    message: "This identity is not authorized for the selected vehicle.",
    tone: "warning",
    retryable: false,
  }),
  SESSION_NOT_FOUND: Object.freeze({
    title: "Session unavailable",
    message: "The saved session cannot be restored for this identity. Start a new session.",
    tone: "warning",
    retryable: false,
  }),
  SERVICE_BUSY: Object.freeze({
    title: "DriveGuard is busy",
    message:
      "The service is handling another request. No action was reported as complete; retry shortly.",
    tone: "info",
    retryable: true,
  }),
  DEPENDENCY_UNAVAILABLE: Object.freeze({
    title: "A required service is unavailable",
    message: "DriveGuard stopped safely before reporting success. Check system health and retry.",
    tone: "warning",
    retryable: true,
  }),
  REPLAN_REQUIRED: Object.freeze({
    title: "Replan required",
    message:
      "Vehicle context changed before execution. Review the current state and make the request again.",
    tone: "warning",
    retryable: true,
  }),
  POLICY_REPLAN_REQUIRED: Object.freeze({
    title: "Replan required",
    message:
      "Vehicle context changed before execution. Review the current state and make the request again.",
    tone: "warning",
    retryable: true,
  }),
  ACTION_EXPIRED: Object.freeze({
    title: "Confirmation expired",
    message:
      "The protected action was not executed. Submit the request again to create a fresh confirmation.",
    tone: "warning",
    retryable: true,
  }),
  CONFIRMATION_INVALID: Object.freeze({
    title: "Confirmation rejected",
    message: "The protected action did not pass confirmation validation and was not executed.",
    tone: "warning",
    retryable: false,
  }),
  POLICY_DENIED: Object.freeze({
    title: "Request blocked by policy",
    message:
      "DriveGuard denied this request at the policy boundary. No protected action was executed.",
    tone: "warning",
    retryable: false,
  }),
});

export function errorPresentation(code) {
  return (
    ERROR_PRESENTATIONS[code] ??
    Object.freeze({
      title: "Backend unavailable",
      message:
        "DriveGuard could not complete the request and did not report success. Check the connection and retry.",
      tone: "danger",
      retryable: true,
    })
  );
}

export function humanizeIdentifier(value) {
  if (typeof value !== "string" || value.length === 0) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

export function actionTarget(parameters) {
  if (typeof parameters !== "object" || parameters === null) return "Current vehicle";
  const entries = Object.entries(parameters);
  const preferred = ["destination", "stationId", "reservationId", "seat", "temperatureC", "volume"];
  for (const key of preferred) {
    const match = entries.find(([candidate]) => candidate === key);
    if (match !== undefined) return `${humanizeIdentifier(match[0])}: ${String(match[1])}`;
  }
  if (entries.length === 0) return "Current vehicle";
  return entries
    .slice(0, 2)
    .map(([key, value]) => `${humanizeIdentifier(key)}: ${String(value)}`)
    .join(" · ");
}

export function executionPresentation(execution) {
  const status = String(execution?.status ?? execution?.state ?? "UNKNOWN").toUpperCase();
  const successful = status === "SUCCEEDED" || status === "COMPLETED";
  return Object.freeze({
    status,
    label: successful
      ? "Completed"
      : status === "UNKNOWN"
        ? "Unavailable"
        : humanizeIdentifier(status),
    cssClass: successful ? "completed" : "failed",
    successful,
  });
}

export function vehiclePresentation(context) {
  const vehicle = context?.vehicle ?? {};
  const trip = context?.trip ?? {};
  const soc = Number.isFinite(vehicle.soc) ? Math.max(0, Math.min(100, vehicle.soc)) : null;
  const chargingState = humanizeIdentifier(vehicle.chargingState ?? "not_charging");
  return Object.freeze({
    speed: Number.isFinite(vehicle.speedKph) ? String(Math.round(vehicle.speedKph)) : "—",
    soc,
    range: Number.isFinite(vehicle.estimatedRangeKm)
      ? String(Math.round(vehicle.estimatedRangeKm))
      : "—",
    gear: vehicle.gear ?? "—",
    mode: humanizeIdentifier(vehicle.driveMode ?? "unknown"),
    cabin: Number.isFinite(vehicle.cabinTemperature)
      ? `${vehicle.cabinTemperature.toFixed(1)}°`
      : "—",
    outside: Number.isFinite(vehicle.outsideTemperature)
      ? `${vehicle.outsideTemperature.toFixed(1)}°`
      : "—",
    chargingState,
    chargingActive: vehicle.chargingState === "charging",
    chargingFault: vehicle.chargingState === "fault",
    destination: trip.navigationActive && trip.destination ? trip.destination : "No active route",
    distance:
      trip.navigationActive && Number.isFinite(trip.remainingDistanceKm)
        ? `${trip.remainingDistanceKm.toFixed(1)} km`
        : "—",
    eta:
      trip.navigationActive && Number.isFinite(trip.etaMinutes)
        ? `${Math.round(trip.etaMinutes)} min`
        : "—",
    snapshot: `sim:${context?.simulationVersion ?? "—"}`,
    vehicleVersion: vehicle.version ?? "—",
    tripVersion: trip.version ?? "—",
    updatedAt: vehicle.timestamp ?? trip.timestamp ?? null,
  });
}
