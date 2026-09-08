import process from "node:process";

const [operation, proxy, value] = process.argv.slice(2);
const api = process.env.TOXIPROXY_API_URL || "http://127.0.0.1:8474";
const allowed = new Set(["postgres", "redis", "nats", "simulator"]);

if (!allowed.has(proxy)) {
  throw new Error("proxy must be one of postgres, redis, nats, simulator");
}

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`Toxiproxy API returned HTTP ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

switch (operation) {
  case "down":
    await request(`/proxies/${proxy}`, {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    break;
  case "up":
    await request(`/proxies/${proxy}`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    break;
  case "latency": {
    const latency = Number(value || "500");
    if (!Number.isSafeInteger(latency) || latency < 1 || latency > 30_000) {
      throw new Error("latency must be an integer between 1 and 30000 milliseconds");
    }
    await request(`/proxies/${proxy}/toxics`, {
      method: "POST",
      body: JSON.stringify({
        name: "phase14-latency",
        type: "latency",
        stream: "downstream",
        toxicity: 1,
        attributes: { latency, jitter: 0 },
      }),
    });
    break;
  }
  case "abort":
    await request(`/proxies/${proxy}/toxics`, {
      method: "POST",
      body: JSON.stringify({
        name: "phase14-abort",
        type: "reset_peer",
        stream: "downstream",
        toxicity: 1,
        attributes: { timeout: Number(value || "0") },
      }),
    });
    break;
  case "clear":
    await request(`/proxies/${proxy}/toxics/phase14-latency`, { method: "DELETE" }).catch(
      () => undefined,
    );
    await request(`/proxies/${proxy}/toxics/phase14-abort`, { method: "DELETE" }).catch(
      () => undefined,
    );
    await request(`/proxies/${proxy}`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    break;
  default:
    throw new Error("operation must be down, up, latency, abort, or clear");
}

process.stdout.write(`${JSON.stringify({ operation, proxy, value: value || null })}\n`);
