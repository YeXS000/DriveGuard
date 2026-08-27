import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@driveguard/context": fileURLToPath(
        new URL("./packages/context/src/index.ts", import.meta.url),
      ),
      "@driveguard/capabilities": fileURLToPath(
        new URL("./packages/capabilities/src/index.ts", import.meta.url),
      ),
      "@driveguard/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
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
