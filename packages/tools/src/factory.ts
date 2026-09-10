import { createFormalToolDefinitions, type DriveGuardToolDependencies } from "./definitions.js";
import { ToolRegistry } from "./registry.js";

export function createDriveGuardToolRegistry(
  dependencies: DriveGuardToolDependencies,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of createFormalToolDefinitions(dependencies)) {
    registry.register(definition);
  }
  return registry.seal();
}
