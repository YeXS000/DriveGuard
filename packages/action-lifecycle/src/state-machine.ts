import { ActionLifecycleError } from "./errors.js";
import type { ActionState, PendingAction } from "./types.js";

const LEGAL_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = Object.freeze({
  AWAITING_CONFIRMATION: Object.freeze(["CONFIRMED", "CANCELLED", "EXPIRED", "REJECTED"] as const),
  CONFIRMED: Object.freeze(["REPLAN_REQUIRED", "READY_FOR_EXECUTION"] as const),
  READY_FOR_EXECUTION: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
  REPLAN_REQUIRED: Object.freeze([]),
  REJECTED: Object.freeze([]),
});

function freezeAction(action: PendingAction): PendingAction {
  Object.freeze(action.stateHistory);
  return Object.freeze(action);
}

export function allowedActionTransitions(state: ActionState): readonly ActionState[] {
  return LEGAL_TRANSITIONS[state];
}

export function transitionPendingAction(
  action: PendingAction,
  nextState: ActionState,
  transitionedAt: PendingAction["updatedAt"],
): PendingAction {
  if (!LEGAL_TRANSITIONS[action.state].includes(nextState)) {
    throw new ActionLifecycleError(
      "INVALID_TRANSITION",
      `Action cannot transition from ${action.state} to ${nextState}`,
      action.actionId,
      action.state,
    );
  }
  return freezeAction({
    ...action,
    state: nextState,
    updatedAt: transitionedAt,
    stateHistory: [
      ...action.stateHistory,
      Object.freeze({ from: action.state, to: nextState, transitionedAt }),
    ],
  });
}
