import * as policy from "@driveguard/policy";
import * as runtime from "@driveguard/agent-runtime";

const requiredPolicy = [
  "PolicyEngine",
  "PolicyRuleRegistry",
  "ToolPolicyProfileRegistry",
  "createDefaultPolicyRuleRegistry",
  "createDefaultToolPolicyProfileRegistry",
];
const requiredRuntime = ["PolicyGuardedToolHandler", "PolicyControlError", "PHASE_6_POLICY_NOTICE"];
for (const name of requiredPolicy) {
  if (!(name in policy)) throw new Error(`Missing Policy export ${name}`);
}
for (const name of requiredRuntime) {
  if (!(name in runtime)) throw new Error(`Missing Runtime Policy export ${name}`);
}
process.stdout.write("Phase 6 package exports PASS\n");
