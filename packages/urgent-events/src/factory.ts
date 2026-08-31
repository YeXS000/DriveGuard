import {
  ConfirmationService,
  ContextRevalidator,
  type ActionLifecycleEventSink,
  type PendingActionRepository,
} from "@driveguard/action-lifecycle";
import {
  ContextLoader,
  DEFAULT_PHASE_5_CAPABILITIES,
  DEFAULT_PHASE_5_SERVICES,
  SimulatorContextProvider,
} from "@driveguard/agent-runtime";
import {
  ContextFreshnessEvaluator,
  ContextSnapshotBuilder,
  ContextSnapshotIdAllocator,
  ContextVersionAllocator,
} from "@driveguard/context";
import type { DrivingUser, WeatherState } from "@driveguard/domain";
import {
  ReliableToolExecutor,
  type DurableExecutionCoordinator,
  type ExecutionEventSink,
} from "@driveguard/executor";
import type { SessionCoordinator, SessionRepository } from "@driveguard/memory";
import { createDefaultToolPolicyProfileRegistry, PolicyEngine } from "@driveguard/policy";
import { SystemClock, type Clock } from "@driveguard/shared";
import {
  createDriveGuardToolRegistry,
  DevelopmentEmergencySupportProvider,
  DevelopmentWeatherProvider,
  SimulatorClient,
} from "@driveguard/tools";

import { UrgentActionDispatcher, type UrgentExecutionRecovery } from "./dispatcher.js";
import type { UrgentEventObserver } from "./observer.js";

export interface CreateUrgentActionSystemOptions {
  readonly simulatorBaseUrl: string;
  readonly userId: string;
  readonly confirmationSecret: string;
  readonly pendingActionRepository: PendingActionRepository;
  readonly durableExecutionCoordinator: DurableExecutionCoordinator;
  readonly executionEventSink: ExecutionEventSink;
  readonly sessionRepository: SessionRepository;
  readonly sessionCoordinator: SessionCoordinator;
  readonly executionRecovery: UrgentExecutionRecovery;
  readonly actionLifecycleEventSink?: ActionLifecycleEventSink;
  readonly observer?: UrgentEventObserver;
  readonly clock?: Clock;
}

export function createUrgentActionSystem(options: CreateUrgentActionSystemOptions): Readonly<{
  readonly contextLoader: ContextLoader;
  readonly dispatcher: UrgentActionDispatcher;
}> {
  const clock = options.clock ?? new SystemClock();
  const simulator = new SimulatorClient({ baseUrl: options.simulatorBaseUrl });
  const user = Object.freeze({ userId: options.userId, role: "driver" }) as DrivingUser;
  const weather = Object.freeze({ condition: "clear", temperatureC: 25 }) as WeatherState;
  const contextLoader = new ContextLoader({
    provider: new SimulatorContextProvider({
      simulator,
      weather,
      user,
      capabilities: DEFAULT_PHASE_5_CAPABILITIES,
      serviceAvailability: DEFAULT_PHASE_5_SERVICES,
    }),
    snapshotBuilder: new ContextSnapshotBuilder({
      clock,
      versionAllocator: new ContextVersionAllocator(),
      snapshotIdAllocator: new ContextSnapshotIdAllocator("urgent-context"),
    }),
    freshnessEvaluator: new ContextFreshnessEvaluator(clock),
  });
  const registry = createDriveGuardToolRegistry({
    simulator,
    weatherProvider: new DevelopmentWeatherProvider(weather),
    emergencySupportProvider: new DevelopmentEmergencySupportProvider(),
  });
  const policyProfiles = createDefaultToolPolicyProfileRegistry();
  const policyEngine = new PolicyEngine({ profiles: policyProfiles });
  const revalidator = new ContextRevalidator({
    freshnessEvaluator: new ContextFreshnessEvaluator(clock),
    profiles: policyProfiles,
    definitionProvider: (toolName) => registry.get(toolName),
    currentContextProvider: async () => {
      const current = await contextLoader.load();
      return {
        snapshot: current.snapshot,
        latestContextVersion: current.freshness.context.latestVersion,
        availability: {
          capabilities: current.snapshot.capabilities,
          services: current.services,
        },
      };
    },
  });
  const authorizationConsumer = new ConfirmationService({
    clock,
    repository: options.pendingActionRepository,
    revalidator,
    isTrustedDefinition: (definition) => registry.get(definition.name) === definition,
    ...(options.actionLifecycleEventSink === undefined
      ? {}
      : { eventSink: options.actionLifecycleEventSink }),
  });
  const reliableExecutor = new ReliableToolExecutor({
    registry,
    authorizationConsumer,
    clock,
    durableCoordinator: options.durableExecutionCoordinator,
    eventSink: options.executionEventSink,
  });
  return Object.freeze({
    contextLoader,
    dispatcher: new UrgentActionDispatcher({
      contextLoader,
      registry,
      policyEngine,
      policyProfiles,
      pendingActionRepository: options.pendingActionRepository,
      reliableExecutor,
      sessionRepository: options.sessionRepository,
      sessionCoordinator: options.sessionCoordinator,
      executionRecovery: options.executionRecovery,
      clock,
      userId: options.userId,
      confirmationSecret: options.confirmationSecret,
      ...(options.actionLifecycleEventSink === undefined
        ? {}
        : { actionLifecycleEventSink: options.actionLifecycleEventSink }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    }),
  });
}
