import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@driveguard/action-lifecycle": fileURLToPath(
        new URL("./packages/action-lifecycle/src/index.ts", import.meta.url),
      ),
      "@driveguard/context": fileURLToPath(
        new URL("./packages/context/src/index.ts", import.meta.url),
      ),
      "@driveguard/agent-runtime": fileURLToPath(
        new URL("./packages/agent-runtime/src/index.ts", import.meta.url),
      ),
      "@driveguard/capabilities": fileURLToPath(
        new URL("./packages/capabilities/src/index.ts", import.meta.url),
      ),
      "@driveguard/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
      ),
      "@driveguard/executor": fileURLToPath(
        new URL("./packages/executor/src/index.ts", import.meta.url),
      ),
      "@driveguard/memory": fileURLToPath(
        new URL("./packages/memory/src/index.ts", import.meta.url),
      ),
      "@driveguard/observability": fileURLToPath(
        new URL("./packages/observability/src/index.ts", import.meta.url),
      ),
      "@driveguard/persistence": fileURLToPath(
        new URL("./packages/persistence/src/index.ts", import.meta.url),
      ),
      "@driveguard/policy": fileURLToPath(
        new URL("./packages/policy/src/index.ts", import.meta.url),
      ),
      "@driveguard/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
      "@driveguard/tools": fileURLToPath(new URL("./packages/tools/src/index.ts", import.meta.url)),
      "@driveguard/vehicle-simulator": fileURLToPath(
        new URL("./services/vehicle-simulator/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/{unit,contract,integration}/**/*.test.ts"],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
