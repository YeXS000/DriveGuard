import { describe, expect, it } from "vitest";

import { PHASE_ZERO_MARKER } from "@driveguard/shared";

describe("Phase 0 toolchain", () => {
  it("loads TypeScript workspace modules under Vitest", () => {
    expect(PHASE_ZERO_MARKER).toBe("driveguard-phase-0");
  });
});
