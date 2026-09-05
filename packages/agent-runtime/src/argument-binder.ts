import type { FormalToolName } from "@driveguard/tools";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function firstNumber(prompt: string, pattern: RegExp): number | undefined {
  const matched = prompt.match(pattern)?.[1];
  if (matched === undefined) return undefined;
  const value = Number(matched);
  return Number.isFinite(value) ? value : undefined;
}

function stationId(prompt: string): string | undefined {
  if (/(?:浦东|pudong).*0*01/iu.test(prompt)) return "station-pudong-001";
  if (/(?:虹桥|hongqiao).*0*02/iu.test(prompt)) return "station-hongqiao-002";
  return prompt.match(/\bstation-[a-z0-9-]+\b/iu)?.[0]?.toLowerCase();
}

function destination(prompt: string): string | undefined {
  const known = ["苏州工业园", "浦东机场", "上海科技馆", "虹桥枢纽", "人民广场"];
  return known.find((candidate) => prompt.includes(candidate));
}

export class ToolArgumentBinder {
  bind(toolName: FormalToolName, prompt: string, proposed: unknown): unknown {
    const fallback = structuredClone(record(proposed));
    switch (toolName) {
      case "get_vehicle_state":
      case "get_trip_state":
      case "get_weather":
      case "search_charging_stations":
      case "get_charging_status":
        return Object.freeze({});
      case "set_cabin_temperature": {
        const value = firstNumber(prompt, /(?:温度|temperature)[^\d-]*(-?\d+(?:\.\d+)?)/iu);
        return value === undefined ? fallback : Object.freeze({ temperatureC: value });
      }
      case "set_seat_heating": {
        const level = firstNumber(prompt, /(?:加热|heat)[^\d]*([0-3])/iu);
        const seat = /(?:副驾驶|front passenger)/iu.test(prompt)
          ? "front_passenger"
          : /(?:驾驶席|主驾驶|driver)/iu.test(prompt)
            ? "driver"
            : undefined;
        return level === undefined || seat === undefined
          ? fallback
          : Object.freeze({ seat, level });
      }
      case "set_media_volume": {
        const volume = firstNumber(prompt, /(?:音量|volume)[^\d]*([0-9]{1,3})/iu);
        return volume === undefined ? fallback : Object.freeze({ volume });
      }
      case "set_navigation_destination": {
        const value = destination(prompt);
        return value === undefined ? fallback : Object.freeze({ destination: value });
      }
      case "reroute_to_charger":
      case "reserve_charging_slot": {
        const value = stationId(prompt);
        return value === undefined ? fallback : Object.freeze({ stationId: value });
      }
      case "cancel_charging_reservation": {
        const reservationId = prompt.match(/\breservation[-:][A-Za-z0-9_-]+\b/u)?.[0];
        return reservationId === undefined ? fallback : Object.freeze({ reservationId });
      }
      case "request_roadside_assistance":
        return /(?:轮胎.*(?:爆|瘪)|flat tire)/iu.test(prompt)
          ? Object.freeze({ reason: "flat tire" })
          : fallback;
      case "request_emergency_support":
        return fallback;
    }
  }
}
