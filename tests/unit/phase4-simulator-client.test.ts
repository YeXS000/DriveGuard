import { SimulatorClient, ToolExecutionError } from "@driveguard/tools";
import { describe, expect, it, vi } from "vitest";

function fetchMock(implementation: typeof fetch): typeof fetch {
  return vi.fn(implementation);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Phase 4 SimulatorClient construction", () => {
  it.each([
    "relative/path",
    "ftp://simulator.example",
    "http://user:secret@simulator.example",
    "http://simulator.example?secret=value",
    "http://simulator.example#fragment",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() => new SimulatorClient({ baseUrl })).toThrow(TypeError);
  });

  it.each([0, -1, 60_001, 1.5, Number.NaN])("rejects invalid timeout %s", (defaultTimeoutMs) => {
    expect(() => new SimulatorClient({ baseUrl: "http://localhost", defaultTimeoutMs })).toThrow(
      TypeError,
    );
  });

  it("normalizes a trailing slash without duplicating request separators", async () => {
    const mock = fetchMock(() =>
      Promise.resolve(jsonResponse({ chargingState: "not_charging", reservations: [] })),
    );
    const client = new SimulatorClient({
      baseUrl: "http://localhost:3001/",
      fetchImplementation: mock,
    });
    await client.getChargingStatus();
    expect(mock).toHaveBeenCalledWith("http://localhost:3001/charging/status", expect.anything());
  });
});

describe("Phase 4 SimulatorClient transport and response errors", () => {
  it.each([
    [404, "RESOURCE_NOT_FOUND"],
    [409, "CONFLICT"],
    [500, "DEPENDENCY_UNAVAILABLE"],
    [503, "DEPENDENCY_UNAVAILABLE"],
    [400, "DEPENDENCY_RESPONSE_INVALID"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    const client = new SimulatorClient({
      baseUrl: "http://localhost",
      fetchImplementation: fetchMock(() => Promise.resolve(jsonResponse({ error: {} }, status))),
    });
    await expect(client.createChargingReservation("station-1")).rejects.toMatchObject({ code });
  });

  it("maps a network rejection to dependency unavailable", async () => {
    const client = new SimulatorClient({
      baseUrl: "http://localhost",
      fetchImplementation: fetchMock(() => Promise.reject(new Error("socket details"))),
    });
    await expect(client.getVehicleState()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Simulator request failed",
    });
  });

  it("maps an aborted request to dependency timeout", async () => {
    const client = new SimulatorClient({
      baseUrl: "http://localhost",
      defaultTimeoutMs: 5,
      fetchImplementation: fetchMock(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    await expect(client.getTripState()).rejects.toMatchObject({ code: "DEPENDENCY_TIMEOUT" });
  });

  it("rejects malformed JSON", async () => {
    const client = new SimulatorClient({
      baseUrl: "http://localhost",
      fetchImplementation: fetchMock(() => Promise.resolve(new Response("{", { status: 200 }))),
    });
    await expect(client.getChargingStatus()).rejects.toMatchObject({
      code: "DEPENDENCY_RESPONSE_INVALID",
      message: "Simulator returned invalid JSON",
    });
  });

  it("rejects a schema-invalid success response", async () => {
    const client = new SimulatorClient({
      baseUrl: "http://localhost",
      fetchImplementation: fetchMock(() => Promise.resolve(jsonResponse({ unexpected: true }))),
    });
    await expect(client.listChargingStations()).rejects.toMatchObject({
      code: "DEPENDENCY_RESPONSE_INVALID",
      message: "Simulator response failed validation",
    });
  });

  it("requires HTTP 204 for cancellation", async () => {
    const client = new SimulatorClient({
      baseUrl: "http://localhost",
      fetchImplementation: fetchMock(() => Promise.resolve(jsonResponse({}, 200))),
    });
    await expect(client.cancelChargingReservation("reservation-1")).rejects.toMatchObject({
      code: "DEPENDENCY_RESPONSE_INVALID",
    });
  });

  it("encodes a reservation ID into the URL", async () => {
    const mock = fetchMock(() => Promise.resolve(new Response(null, { status: 204 })));
    const client = new SimulatorClient({ baseUrl: "http://localhost", fetchImplementation: mock });
    await client.cancelChargingReservation("reservation/with spaces");
    expect(mock).toHaveBeenCalledWith(
      "http://localhost/charging/reservations/reservation%2Fwith%20spaces",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("sends a closed JSON mutation body", async () => {
    const mock = fetchMock(() => Promise.resolve(jsonResponse({ volume: 44 })));
    const client = new SimulatorClient({ baseUrl: "http://localhost", fetchImplementation: mock });
    await expect(client.setMediaVolume(44)).resolves.toEqual({ volume: 44 });
    expect(mock).toHaveBeenCalledWith(
      "http://localhost/media/volume",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volume: 44 }),
      }),
    );
  });

  it("returns a structured safe error serialization", async () => {
    const client = new SimulatorClient({
      baseUrl: "http://localhost",
      fetchImplementation: fetchMock(() => Promise.resolve(jsonResponse({}, 404))),
    });
    try {
      await client.cancelChargingReservation("missing");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect(JSON.stringify((error as ToolExecutionError).toJSON())).not.toMatch(
        /stack|socket|authorization/iu,
      );
    }
  });
});
