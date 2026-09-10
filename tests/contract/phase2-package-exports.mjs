import { ContextConflictDetector } from "@driveguard/context";
import { VehicleStateSchema } from "@driveguard/domain";
import { FixedClock } from "@driveguard/shared";

const usable =
  typeof ContextConflictDetector === "function" &&
  VehicleStateSchema.type === "object" &&
  new FixedClock(123).nowMs() === 123;

if (!usable) throw new Error("Phase 2 workspace package exports are not usable");
process.stdout.write("Phase 2 workspace package exports: PASS\n");
