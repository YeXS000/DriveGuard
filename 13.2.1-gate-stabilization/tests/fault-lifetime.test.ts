import { describe, expect, it } from "vitest";

import { shouldReleaseNativeFaultAfterEvent } from "../../evals/runner/live-provider.js";

describe("Phase 13.2.1 Native fault lifetime", () => {
  it("releases a retry-safe duplicate-request injection after the first failed attempt", () => {
    expect(
      shouldReleaseNativeFaultAfterEvent(
        "duplicate_request",
        { eventType: "execution.attempt.failed", attempt: 1 },
        false,
      ),
    ).toBe(true);
  });

  it("never releases the duplicate-request injection more than once", () => {
    expect(
      shouldReleaseNativeFaultAfterEvent(
        "duplicate_request",
        { eventType: "execution.attempt.failed", attempt: 2 },
        false,
      ),
    ).toBe(false);
    expect(
      shouldReleaseNativeFaultAfterEvent(
        "duplicate_request",
        { eventType: "execution.attempt.failed", attempt: 1 },
        true,
      ),
    ).toBe(false);
  });

  it.each(["http_503", "timeout", "connection_abort", "ambiguous_side_effect"] as const)(
    "keeps %s fault persistence unchanged",
    (mode) => {
      expect(
        shouldReleaseNativeFaultAfterEvent(
          mode,
          { eventType: "execution.attempt.failed", attempt: 1 },
          false,
        ),
      ).toBe(false);
    },
  );
});
