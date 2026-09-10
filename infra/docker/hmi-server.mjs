import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as proxyRequest } from "node:http";
import { extname, resolve, sep } from "node:path";

const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const publicRoot = resolve("/app/public");
const apiOrigin = new URL(process.env.DRIVEGUARD_API_ORIGIN ?? "http://api:3000");
const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
});

function proxy(req, res) {
  const upstreamPath = req.url.slice(4) || "/";
  let upstreamResponse;
  const upstream = proxyRequest(
    {
      protocol: apiOrigin.protocol,
      hostname: apiOrigin.hostname,
      port: apiOrigin.port,
      method: req.method,
      path: upstreamPath,
      headers: { ...req.headers, host: apiOrigin.host },
    },
    (response) => {
      upstreamResponse = response;
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  const destroyUpstream = () => {
    upstream.destroy();
    upstreamResponse?.destroy();
  };
  req.once("aborted", destroyUpstream);
  res.once("close", destroyUpstream);
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("API unavailable");
  });
  req.pipe(upstream);
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, "http://hmi.local").pathname;
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = resolve(publicRoot, relativePath);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) proxy(req, res);
  else void serveStatic(req, res);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.listen(port, "0.0.0.0");
