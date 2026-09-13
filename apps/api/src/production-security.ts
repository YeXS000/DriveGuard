import { readRequestAuthentication } from "./authentication.js";

/** Validates the production authentication contract before dependencies or a listener start. */
export function assertProductionSecurityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.DRIVEGUARD_DEPLOYMENT_ENV !== "production") return;
  readRequestAuthentication(environment);
}
