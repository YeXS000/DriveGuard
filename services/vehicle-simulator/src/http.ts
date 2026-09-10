import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { SimulatorError } from "./errors.js";
import {
  parseAssistanceBody,
  parseDestinationBody,
  parseFaultBody,
  parseIdParameter,
  parseResetBody,
  parseSeatHeatingBody,
  parseSocBody,
  parseSpeedBody,
  parseStationBody,
  parseTemperatureBody,
  parseVolumeBody,
} from "./http-input.js";
import { VehicleSimulator } from "./simulator.js";
import { VehicleSimulatorFleet } from "./fleet.js";
import type { FaultTarget, TriggeredFault } from "./types.js";

export interface BuildVehicleSimulatorOptions {
  readonly simulator?: VehicleSimulator;
  readonly fleet?: VehicleSimulatorFleet;
  readonly logger?: boolean;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withFault<T>(
  simulator: VehicleSimulator,
  target: FaultTarget,
  reply: FastifyReply,
  operation: (fault: TriggeredFault | undefined, resetEpoch: number) => T | Promise<T>,
  applyBeforeTimeout = false,
): Promise<T | FastifyReply> {
  const resetEpoch = simulator.resetEpoch();
  const fault = simulator.consumeFault(target);
  if (fault === undefined) return operation(undefined, resetEpoch);
  if (fault.mode === "delay") {
    await delay(fault.delayMs);
    return operation(fault, resetEpoch);
  }
  if (fault.mode === "timeout") {
    if (applyBeforeTimeout) await operation(fault, resetEpoch);
    await delay(fault.delayMs);
    throw new SimulatorError("FAULT_INJECTED", "Injected dependency timeout", 504);
  }
  if (fault.mode === "http_500") {
    throw new SimulatorError("FAULT_INJECTED", "Injected HTTP 500 failure", 500);
  }
  if (fault.mode === "http_503") {
    throw new SimulatorError("FAULT_INJECTED", "Injected HTTP 503 failure", 503);
  }
  if (fault.mode === "connection_abort") {
    reply.hijack();
    reply.raw.destroy();
    return reply;
  }
  return operation(fault, resetEpoch);
}

export function buildVehicleSimulator(options: BuildVehicleSimulatorOptions = {}): FastifyInstance {
  if (options.simulator !== undefined && options.fleet !== undefined) {
    throw new TypeError("Provide simulator or fleet, not both");
  }
  const fleet =
    options.fleet ??
    new VehicleSimulatorFleet({
      ...(options.simulator === undefined ? {} : { defaultSimulator: options.simulator }),
    });
  const app = Fastify({ logger: options.logger ?? false });
  const reservationIdempotency = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<unknown> }
  >();

  const routed = (request: FastifyRequest) =>
    fleet.resolve(request.headers["x-driveguard-vehicle-id"]);

  const reservationKey = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
      throw new SimulatorError("VALIDATION_ERROR", "Idempotency-Key is invalid", 400);
    }
    return value;
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SimulatorError) {
      void reply.status(error.statusCode).send(error.toJSON());
      return;
    }
    const statusCode: unknown =
      typeof error === "object" && error !== null ? Reflect.get(error, "statusCode") : undefined;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      void reply.status(statusCode).send({
        error: { code: "VALIDATION_ERROR", message: "Request failed validation" },
      });
      return;
    }
    void reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal simulator error" },
    });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({
      error: { code: "VALIDATION_ERROR", message: "Route was not found" },
    }),
  );

  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/health/ready", (_request, reply) => {
    const ready = fleet.resolve(undefined).simulator.isReady();
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
  });

  app.get("/vehicle/state", (request, reply) => {
    const { simulator } = routed(request);
    return withFault(simulator, "vehicle.get_state", reply, (fault) =>
      simulator.vehicleState(fault?.mode === "stale_response"),
    );
  });
  app.get("/trip/state", (request, reply) => {
    const { simulator } = routed(request);
    return withFault(simulator, "trip.get_state", reply, (fault) =>
      simulator.tripState(fault?.mode === "stale_response"),
    );
  });
  app.get("/context/state", (request) => {
    const state = routed(request).simulator.state();
    return {
      vehicle: state.vehicle,
      trip: state.trip,
      simulationVersion: state.simulationVersion,
    };
  });

  app.post("/cabin/temperature", (request, reply) =>
    withFault(
      routed(request).simulator,
      "cabin.set_temperature",
      reply,
      async (_fault, resetEpoch) => {
        const { simulator } = routed(request);
        const state = await simulator.setCabinTemperature(
          parseTemperatureBody(request.body),
          resetEpoch,
        );
        return { cabinTemperature: state.vehicle.cabinTemperature };
      },
    ),
  );
  app.post("/cabin/seat-heating", (request, reply) =>
    withFault(
      routed(request).simulator,
      "cabin.set_seat_heating",
      reply,
      async (_fault, resetEpoch) => {
        const { simulator } = routed(request);
        const body = parseSeatHeatingBody(request.body);
        const state = await simulator.setSeatHeating(body.seat, body.level, resetEpoch);
        return { seatHeating: state.cabin.seatHeating };
      },
    ),
  );
  app.post("/media/volume", (request, reply) =>
    withFault(routed(request).simulator, "media.set_volume", reply, async (_fault, resetEpoch) => {
      const { simulator } = routed(request);
      const state = await simulator.setMediaVolume(parseVolumeBody(request.body), resetEpoch);
      return { volume: state.cabin.mediaVolume };
    }),
  );

  app.post("/navigation/destination", (request, reply) =>
    withFault(
      routed(request).simulator,
      "navigation.set_destination",
      reply,
      async (_fault, resetEpoch) => {
        const { simulator } = routed(request);
        const state = await simulator.setDestination(
          parseDestinationBody(request.body),
          resetEpoch,
        );
        return state.trip;
      },
    ),
  );
  app.post("/navigation/reroute", (request, reply) => {
    const { simulator } = routed(request);
    return withFault(simulator, "navigation.reroute", reply, async (_fault, resetEpoch) => {
      const state = await simulator.reroute(resetEpoch);
      return state.trip;
    });
  });

  app.get("/charging/stations", (request, reply) => {
    const { simulator } = routed(request);
    return withFault(simulator, "charging.list_stations", reply, () => ({
      stations: simulator.chargingStations(),
    }));
  });
  app.get("/charging/status", (request, reply) => {
    const { simulator } = routed(request);
    return withFault(simulator, "charging.get_status", reply, () => simulator.chargingStatus());
  });
  app.post("/charging/reservations", (request, reply) => {
    const { vehicleId, simulator } = routed(request);
    const key = reservationKey(request.headers["idempotency-key"]);
    const scopedKey = key === undefined ? undefined : `${vehicleId}\u0000${key}`;
    const stationId = parseStationBody(request.body);
    const fingerprint = JSON.stringify({ stationId });
    const operation = async (_fault: TriggeredFault | undefined, resetEpoch: number) => {
      if (scopedKey === undefined) {
        const state = await simulator.createReservation(stationId, resetEpoch);
        reply.status(201);
        return { reservation: state.charging.reservations.at(-1) };
      }
      const existing = reservationIdempotency.get(scopedKey);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new SimulatorError("VALIDATION_ERROR", "Idempotency-Key conflicts", 409);
        }
        reply.status(201);
        return existing.result;
      }
      const result = simulator
        .createReservation(stationId, resetEpoch)
        .then((state) => Object.freeze({ reservation: state.charging.reservations.at(-1) }));
      reservationIdempotency.set(scopedKey, { fingerprint, result });
      try {
        reply.status(201);
        return await result;
      } catch (error) {
        reservationIdempotency.delete(scopedKey);
        throw error;
      }
    };
    return withFault(
      simulator,
      "charging.create_reservation",
      reply,
      operation,
      scopedKey !== undefined,
    );
  });
  app.delete("/charging/reservations/:id", (request, reply) => {
    const { simulator } = routed(request);
    return withFault(
      simulator,
      "charging.cancel_reservation",
      reply,
      async (_fault, resetEpoch) => {
        await simulator.cancelReservation(parseIdParameter(request.params), resetEpoch);
        return reply.status(204).send();
      },
    );
  });

  app.post("/assistance/roadside", (request, reply) =>
    withFault(
      routed(request).simulator,
      "assistance.roadside",
      reply,
      async (_fault, resetEpoch) => {
        const { simulator } = routed(request);
        const state = await simulator.requestRoadsideAssistance(
          parseAssistanceBody(request.body),
          resetEpoch,
        );
        return reply.status(201).send({ request: state.assistance.requests.at(-1) });
      },
    ),
  );

  // TEST / CONTROL PLANE. These routes must not be exposed by a production gateway.
  app.get("/simulator/state", (request) => routed(request).simulator.state());
  app.post("/simulator/reset", async (request) => {
    const { vehicleId, simulator } = routed(request);
    const body = parseResetBody(request.body);
    for (const key of reservationIdempotency.keys()) {
      if (key.startsWith(`${vehicleId}\u0000`)) reservationIdempotency.delete(key);
    }
    return simulator.reset(body.scenario, body.seed);
  });
  app.post("/simulator/faults", (request, reply) =>
    reply.status(201).send({
      fault: routed(request).simulator.configureFault(parseFaultBody(request.body)),
    }),
  );
  app.get("/simulator/faults", (request) => ({ faults: routed(request).simulator.listFaults() }));
  app.delete("/simulator/faults", (request, reply) => {
    routed(request).simulator.clearFaults();
    return reply.status(204).send();
  });
  app.post("/simulator/vehicle/speed", async (request) => {
    const { simulator } = routed(request);
    const resetEpoch = simulator.resetEpoch();
    return simulator.setVehicleSpeed(parseSpeedBody(request.body), resetEpoch);
  });
  app.post("/simulator/vehicle/soc", async (request) => {
    const { simulator } = routed(request);
    const resetEpoch = simulator.resetEpoch();
    return simulator.setSoc(parseSocBody(request.body), resetEpoch);
  });

  return app;
}
