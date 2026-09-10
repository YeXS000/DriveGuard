import type { ContextSnapshot } from "@driveguard/domain";
import type { FormalToolName } from "@driveguard/tools";

import { URGENT_EVENT_THRESHOLDS } from "./classifier.js";
import type { UrgentEvent, UrgentEventSeverity } from "./model.js";

export interface UrgentActionCandidate {
  readonly toolName: FormalToolName;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly safeSummary: string;
}

export interface UrgentEventPlan {
  readonly disposition: "ACTION" | "RESOLVED" | "REPLAN_REQUIRED";
  readonly safeSummary: string;
  readonly candidate?: UrgentActionCandidate;
}

export class UrgentEventPlanner {
  plan(
    event: UrgentEvent,
    _severity: UrgentEventSeverity,
    context: ContextSnapshot,
  ): UrgentEventPlan {
    switch (event.eventType) {
      case "LOW_SOC":
        if (context.vehicle.soc >= URGENT_EVENT_THRESHOLDS.lowSocRecoveredPercent) {
          return Object.freeze({
            disposition: "RESOLVED",
            safeSummary: "Current vehicle state no longer indicates actionable low SOC.",
          });
        }
        if (context.vehicle.soc > URGENT_EVENT_THRESHOLDS.lowSocActionPercent) {
          return Object.freeze({
            disposition: "RESOLVED",
            safeSummary: "Current SOC is above the urgent charging-action threshold.",
          });
        }
        return this.#action(
          "reroute_to_charger",
          { stationId: "station-pudong-001" },
          "Low SOC requires user-confirmed rerouting to a known available charger.",
        );
      case "CHARGING_INTERRUPTED":
        if (context.vehicle.chargingState !== "fault") {
          return Object.freeze({
            disposition: "RESOLVED",
            safeSummary: "Current charging state no longer reports a charging fault.",
          });
        }
        return this.#action(
          "get_charging_status",
          {},
          "Charging interruption requires a fresh charging-status read.",
        );
      case "VEHICLE_FAULT":
        return this.#action(
          "request_roadside_assistance",
          { reason: `Vehicle fault ${event.payload.faultCode}` },
          "A validated vehicle fault requires user-confirmed roadside assistance.",
        );
      case "ROUTE_BLOCKED":
        if (event.payload.routeId !== undefined && context.trip.routeId !== event.payload.routeId) {
          return Object.freeze({
            disposition: "RESOLVED",
            safeSummary: "The blocked route is no longer the current route.",
          });
        }
        return Object.freeze({
          disposition: "REPLAN_REQUIRED",
          safeSummary: "The current route is blocked and requires a fresh plan.",
        });
      case "ASSISTANCE_REQUIRED":
        return this.#action(
          "request_emergency_support",
          { reason: `Assistance required: ${event.payload.reasonCode}` },
          "Assistance requires explicit user confirmation before support is requested.",
        );
    }
  }

  #action(
    toolName: FormalToolName,
    args: Readonly<Record<string, unknown>>,
    safeSummary: string,
  ): UrgentEventPlan {
    return Object.freeze({
      disposition: "ACTION",
      safeSummary,
      candidate: Object.freeze({
        toolName,
        arguments: Object.freeze(structuredClone(args)),
        safeSummary,
      }),
    });
  }
}
