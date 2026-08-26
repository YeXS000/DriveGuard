import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

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
import type { FaultTarget, TriggeredFault } from "./types.js";

export interface BuildVehicleSimulatorOptions {
  readonly simulator?: VehicleSimulator;
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
): Promise<T | FastifyReply> {
  const resetEpoch = simulator.resetEpoch();
  const fault = simulator.consumeFault(target);
  if (fault === undefined) return operation(undefined, resetEpoch);
  if (fault.mode === "delay") {
    await delay(fault.delayMs);
    return operation(fault, resetEpoch);
  }
  if (fault.mode === "timeout") {
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
  const simulator = options.simulator ?? new VehicleSimulator();
  const app = Fastify({ logger: options.logger ?? false });

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
    const ready = simulator.isReady();
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
  });

  app.get("/vehicle/state", (_request, reply) =>
    withFault(simulator, "vehicle.get_state", reply, (fault) =>
      simulator.vehicleState(fault?.mode === "stale_response"),
    ),
  );
  app.get("/trip/state", (_request, reply) =>
    withFault(simulator, "trip.get_state", reply, (fault) =>
      simulator.tripState(fault?.mode === "stale_response"),
    ),
  );

  app.post("/cabin/temperature", (request, reply) =>
    withFault(simulator, "cabin.set_temperature", reply, async (_fault, resetEpoch) => {
      const state = await simulator.setCabinTemperature(
        parseTemperatureBody(request.body),
        resetEpoch,
      );
      return { cabinTemperature: state.vehicle.cabinTemperature };
    }),
  );
  app.post("/cabin/seat-heating", (request, reply) =>
    withFault(simulator, "cabin.set_seat_heating", reply, async (_fault, resetEpoch) => {
      const body = parseSeatHeatingBody(request.body);
      const state = await simulator.setSeatHeating(body.seat, body.level, resetEpoch);
      return { seatHeating: state.cabin.seatHeating };
    }),
  );
  app.post("/media/volume", (request, reply) =>
    withFault(simulator, "media.set_volume", reply, async (_fault, resetEpoch) => {
      const state = await simulator.setMediaVolume(parseVolumeBody(request.body), resetEpoch);
      return { volume: state.cabin.mediaVolume };
    }),
  );

  app.post("/navigation/destination", (request, reply) =>
    withFault(simulator, "navigation.set_destination", reply, async (_fault, resetEpoch) => {
      const state = await simulator.setDestination(parseDestinationBody(request.body), resetEpoch);
      return state.trip;
    }),
  );
  app.post("/navigation/reroute", (_request, reply) =>
    withFault(simulator, "navigation.reroute", reply, async (_fault, resetEpoch) => {
      const state = await simulator.reroute(resetEpoch);
      return state.trip;
    }),
  );

  app.get("/charging/stations", (_request, reply) =>
    withFault(simulator, "charging.list_stations", reply, () => ({
      stations: simulator.chargingStations(),
    })),
  );
  app.get("/charging/status", (_request, reply) =>
    withFault(simulator, "charging.get_status", reply, () => simulator.chargingStatus()),
  );
  app.post("/charging/reservations", (request, reply) =>
    withFault(simulator, "charging.create_reservation", reply, async (_fault, resetEpoch) => {
      const state = await simulator.createReservation(parseStationBody(request.body), resetEpoch);
      const reservation = state.charging.reservations.at(-1);
      return reply.status(201).send({ reservation });
    }),
  );
  app.delete("/charging/reservations/:id", (request, reply) =>
    withFault(simulator, "charging.cancel_reservation", reply, async (_fault, resetEpoch) => {
      await simulator.cancelReservation(parseIdParameter(request.params), resetEpoch);
      return reply.status(204).send();
    }),
  );

  app.post("/assistance/roadside", (request, reply) =>
    withFault(simulator, "assistance.roadside", reply, async (_fault, resetEpoch) => {
      const state = await simulator.requestRoadsideAssistance(
        parseAssistanceBody(request.body),
        resetEpoch,
      );
      return reply.status(201).send({ request: state.assistance.requests.at(-1) });
    }),
  );

  // TEST / CONTROL PLANE. These routes must not be exposed by a production gateway.
  app.get("/simulator/state", () => simulator.state());
  app.post("/simulator/reset", async (request) => {
    const body = parseResetBody(request.body);
    return simulator.reset(body.scenario, body.seed);
  });
  app.post("/simulator/faults", (request, reply) =>
    reply.status(201).send({ fault: simulator.configureFault(parseFaultBody(request.body)) }),
  );
  app.get("/simulator/faults", () => ({ faults: simulator.listFaults() }));
  app.delete("/simulator/faults", (_request, reply) => {
    simulator.clearFaults();
    return reply.status(204).send();
  });
  app.post("/simulator/vehicle/speed", async (request) => {
    const resetEpoch = simulator.resetEpoch();
    return simulator.setVehicleSpeed(parseSpeedBody(request.body), resetEpoch);
  });
  app.post("/simulator/vehicle/soc", async (request) => {
    const resetEpoch = simulator.resetEpoch();
    return simulator.setSoc(parseSocBody(request.body), resetEpoch);
  });

  return app;
}
