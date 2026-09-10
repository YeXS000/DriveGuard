import type { UrgentEvent, UrgentEventSeverity } from "./model.js";

export const URGENT_EVENT_THRESHOLDS = Object.freeze({
  lowSocCriticalPercent: 5,
  lowSocHighPercent: 15,
  lowSocWarningPercent: 30,
  lowSocActionPercent: 15,
  lowSocRecoveredPercent: 20,
});

/** Severity is recomputed from validated event facts; the source-provided field is not trusted. */
export class UrgentEventClassifier {
  classify(event: UrgentEvent): UrgentEventSeverity {
    switch (event.eventType) {
      case "LOW_SOC":
        if (event.payload.reportedSoc <= URGENT_EVENT_THRESHOLDS.lowSocCriticalPercent) {
          return "CRITICAL";
        }
        if (event.payload.reportedSoc <= URGENT_EVENT_THRESHOLDS.lowSocHighPercent) return "HIGH";
        if (event.payload.reportedSoc <= URGENT_EVENT_THRESHOLDS.lowSocWarningPercent) {
          return "WARNING";
        }
        return "INFO";
      case "CHARGING_INTERRUPTED":
        return "HIGH";
      case "VEHICLE_FAULT":
        return event.payload.critical ? "CRITICAL" : "HIGH";
      case "ROUTE_BLOCKED":
        return "WARNING";
      case "ASSISTANCE_REQUIRED":
        return event.payload.immediateDanger ? "CRITICAL" : "HIGH";
    }
  }
}
