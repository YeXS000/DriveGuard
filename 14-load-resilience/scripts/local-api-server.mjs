import process from "node:process";

import { buildApi } from "../../dist/apps/api/src/app.js";
import { RequestAdmissionController } from "../../dist/apps/api/src/admission-control.js";

const port = Number(process.env.PHASE14_LOCAL_PORT || "3014");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("PHASE14_LOCAL_PORT must be a valid TCP port");
}

const admissionController = new RequestAdmissionController({
  maxConcurrent: 32,
  maxQueue: 64,
  queueTimeoutMs: 100,
});
const app = buildApi({ admissionController });
app.get("/v1/phase14/backend-probe", async () => ({ status: "ok" }));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  admissionController.beginShutdown();
  await app.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void close().finally(() => {
      process.exitCode = 0;
    });
  });
}

await app.listen({ host: "127.0.0.1", port });
process.stdout.write(`PHASE14_LOCAL_API http://127.0.0.1:${port}\n`);
