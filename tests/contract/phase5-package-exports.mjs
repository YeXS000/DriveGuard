const runtime = await import("@driveguard/agent-runtime");

const required = [
  "AgentRun",
  "ContextLoader",
  "PiEventAdapter",
  "PiToolAdapter",
  "PHASE_5_PRE_POLICY_NOTICE",
  "createProductionDriveGuardRuntime",
  "createDeepSeekPhase5Selection",
];

for (const name of required) {
  if (!(name in runtime)) throw new Error(`Missing Phase 5 package export: ${name}`);
}

for (const name of ["DriveGuardAgentRuntime", "AgentSession", "AgentSessionStore"]) {
  if (name in runtime) throw new Error(`Unsafe raw Phase 5 package export: ${name}`);
}

process.stdout.write(`Phase 5 package exports PASS (${required.length}/${required.length})\n`);
