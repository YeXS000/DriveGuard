const lifecycle = await import("@driveguard/action-lifecycle");
const runtime = await import("@driveguard/agent-runtime");

const lifecycleExports = [
  "ConfirmationService",
  "ContextRevalidator",
  "transitionPendingAction",
  "createActionFingerprint",
  "createConfirmationSummary",
];

for (const name of lifecycleExports) {
  if (!(name in lifecycle)) throw new Error(`Missing lifecycle export: ${name}`);
}
if (!("createProductionDriveGuardRuntime" in runtime)) {
  throw new Error("Missing production runtime factory");
}
if (!("InMemoryTrustedConfirmationChallengeChannel" in runtime)) {
  throw new Error("Missing trusted confirmation challenge channel export");
}
if ("InMemoryPendingActionRepository" in lifecycle) {
  throw new Error("Repository mutation capability must not be publicly exported");
}

console.log(
  JSON.stringify({
    status: "PASS",
    lifecycleExports: lifecycleExports.length,
    confirmationToolExports: Object.keys(runtime).filter((name) => /confirm.*tool/iu.test(name))
      .length,
  }),
);
