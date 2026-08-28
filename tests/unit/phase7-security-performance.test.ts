import {
  ActionLifecycleError,
  DEFAULT_CONFIRMATION_TTL_MS,
  type PendingActionCreation,
} from "@driveguard/action-lifecycle";
import { PolicyGuardedToolHandler } from "@driveguard/agent-runtime";
import { createDefaultToolPolicyProfileRegistry, PolicyEngine } from "@driveguard/policy";
import type { FormalToolName } from "@driveguard/tools";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { createValidSnapshot } from "../fixtures/phase2-domain.js";
import { FULL_CAPABILITY_CONTEXT } from "../fixtures/phase4-tools.js";
import { createPhase7Harness } from "../fixtures/phase7-lifecycle.js";
import { nextSnapshot, policyInput } from "../fixtures/phase6-policy.js";

async function confirmCreated(
  harness: ReturnType<typeof createPhase7Harness>,
  created: PendingActionCreation,
) {
  return harness.service.confirm({
    actionId: created.action.actionId,
    confirmationToken: created.trustedChallenge.confirmationToken,
    sessionId: created.action.sessionId,
    userId: created.action.userId,
  });
}

describe("Phase 7 10,000-case adversarial lifecycle security matrix", () => {
  it("has zero bypass, replay success, unauthorized READY, and duplicate authorization", async () => {
    const casesPerScenario = 1_000;
    const scenarios = [
      "valid",
      "wrong_token",
      "expired",
      "replay",
      "cross_session",
      "cross_user",
      "tampered_action",
      "context_conflict",
      "capability_loss",
      "invalid_state",
    ] as const;
    let generatedCases = 0;
    let confirmationBypass = 0;
    let replaySuccess = 0;
    let unauthorizedReady = 0;
    let duplicateAuthorization = 0;
    let underlyingExecutions = 0;
    for (const scenario of scenarios) {
      const harness = createPhase7Harness({ withEvents: false });
      const authorizationCounts = new Map<string, number>();
      const observeAuthorization = (
        actionId: string,
        authorization: Awaited<ReturnType<typeof confirmCreated>>["authorization"],
      ): void => {
        if (authorization === null) return;
        const count = (authorizationCounts.get(actionId) ?? 0) + 1;
        authorizationCounts.set(actionId, count);
        if (count > 1) duplicateAuthorization += 1;
      };
      const command = harness.command();
      const profiles = createDefaultToolPolicyProfileRegistry();
      const pendingCreations: PendingActionCreation[] = [];
      const guarded = new PolicyGuardedToolHandler({
        engine: new PolicyEngine({ profiles }),
        clock: harness.clock,
        inputProvider: () =>
          policyInput(command.definition.name as FormalToolName, {
            contextSnapshot: command.contextSnapshot,
          }),
        isTrustedDefinition: (definition) => definition === command.definition,
        confirmationRequired: async (definition, validatedArguments, decision, input) => {
          pendingCreations.push(
            await harness.service.create({
              ...command,
              definition,
              validatedArguments,
              policyDecision: decision,
              contextSnapshot: input.contextSnapshot,
            }),
          );
        },
      });
      if (scenario === "context_conflict") {
        harness.setCurrent(
          nextSnapshot(createValidSnapshot(), (candidate) => {
            (candidate.vehicle as Record<string, unknown>).soc = 15;
          }),
        );
      }
      if (scenario === "capability_loss") {
        harness.setAvailability({
          capabilities: { ...FULL_CAPABILITY_CONTEXT.capabilities, charging: false },
          services: FULL_CAPABILITY_CONTEXT.services,
        });
      }
      for (let index = 0; index < casesPerScenario; index += 1) {
        generatedCases += 1;
        await expect(
          guarded.execute(command.definition, command.validatedArguments, () => {
            underlyingExecutions += 1;
            return Promise.resolve();
          }),
        ).rejects.toMatchObject({ code: "POLICY_CONFIRMATION_REQUIRED" });
        const created = pendingCreations.shift();
        if (created === undefined) throw new Error("Policy Gate did not create a PendingAction");
        let legitimatelyConfirmed = false;
        try {
          switch (scenario) {
            case "valid": {
              const outcome = await confirmCreated(harness, created);
              legitimatelyConfirmed = true;
              observeAuthorization(created.action.actionId, outcome.authorization);
              break;
            }
            case "wrong_token":
              await harness.service.confirm({
                actionId: created.action.actionId,
                confirmationToken: `wrong-${index}`,
                sessionId: created.action.sessionId,
                userId: created.action.userId,
              });
              confirmationBypass += 1;
              break;
            case "expired":
              harness.clock.advance(DEFAULT_CONFIRMATION_TTL_MS);
              await confirmCreated(harness, created);
              confirmationBypass += 1;
              break;
            case "replay": {
              const first = await confirmCreated(harness, created);
              legitimatelyConfirmed = true;
              observeAuthorization(created.action.actionId, first.authorization);
              try {
                const second = await confirmCreated(harness, created);
                replaySuccess += 1;
                if (second.authorization !== null) {
                  observeAuthorization(created.action.actionId, second.authorization);
                }
              } catch {
                // Expected replay rejection.
              }
              break;
            }
            case "cross_session":
              await harness.service.confirm({
                actionId: created.action.actionId,
                confirmationToken: created.trustedChallenge.confirmationToken,
                sessionId: "session:attacker",
                userId: created.action.userId,
              });
              confirmationBypass += 1;
              break;
            case "cross_user":
              await harness.service.confirm({
                actionId: created.action.actionId,
                confirmationToken: created.trustedChallenge.confirmationToken,
                sessionId: created.action.sessionId,
                userId: "attacker-user",
              });
              confirmationBypass += 1;
              break;
            case "tampered_action": {
              const mutationAccepted = Reflect.set(
                created.action.validatedArguments as object,
                "stationId",
                "tampered-station",
              );
              if (mutationAccepted) confirmationBypass += 1;
              const outcome = await confirmCreated(harness, created);
              legitimatelyConfirmed = true;
              observeAuthorization(created.action.actionId, outcome.authorization);
              break;
            }
            case "context_conflict":
            case "capability_loss": {
              const outcome = await confirmCreated(harness, created);
              legitimatelyConfirmed = true;
              if (outcome.authorization !== null) confirmationBypass += 1;
              break;
            }
            case "invalid_state":
              await harness.service.cancel({
                actionId: created.action.actionId,
                sessionId: created.action.sessionId,
                userId: created.action.userId,
              });
              await confirmCreated(harness, created);
              confirmationBypass += 1;
              break;
          }
        } catch (error) {
          expect(error).toBeInstanceOf(ActionLifecycleError);
        }
        const final = harness.service.get(created.action.actionId);
        if (final?.state === "READY_FOR_EXECUTION" && !legitimatelyConfirmed) {
          unauthorizedReady += 1;
        }
        if (scenario === "expired") harness.clock.advance(-DEFAULT_CONFIRMATION_TTL_MS);
      }
    }

    const metrics = {
      generatedCases,
      confirmationBypass,
      replaySuccess,
      unauthorizedReady,
      duplicateAuthorization,
      underlyingExecutions,
    };
    console.log("PHASE7_SECURITY_METRICS", JSON.stringify(metrics));
    expect(metrics).toEqual({
      generatedCases: 10_000,
      confirmationBypass: 0,
      replaySuccess: 0,
      unauthorizedReady: 0,
      duplicateAuthorization: 0,
      underlyingExecutions: 0,
    });
    expect(underlyingExecutions).toBe(0);
  }, 60_000);
});

describe("Phase 7 process-local lifecycle performance", () => {
  it("measures 10,000 complete create/confirm/revalidate/authorize lifecycles", async () => {
    const harness = createPhase7Harness({ withEvents: false });
    const samples: number[] = [];
    const operationCount = 10_000;
    for (let index = 0; index < operationCount; index += 1) {
      const command = harness.command();
      const started = performance.now();
      const created = await harness.service.create(command);
      const outcome = await confirmCreated(harness, created);
      samples.push(performance.now() - started);
      expect(outcome.action.state).toBe("READY_FOR_EXECUTION");
    }
    samples.sort((left, right) => left - right);
    const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    const p99Ms = samples[Math.ceil(samples.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY;
    const metrics = { operationCount, p95Ms, p99Ms };
    console.log("PHASE7_PERFORMANCE_METRICS", JSON.stringify(metrics));
    expect(p95Ms).toBeLessThan(5);
    expect(p99Ms).toBeLessThan(10);
  }, 60_000);
});
