import {
  type FlowStage,
  type PendingPlan,
  type RealSession,
  type ReplanningRequest,
} from "../types";
import type { SessionStore } from "./session-store";

export interface PendingPlanStore {
  savePendingPlan(
    pendingPlan: PendingPlan,
    lastDisruption: ReplanningRequest,
  ): RealSession;
  clearPendingPlan(flowStage?: FlowStage): RealSession;
}

export function createPendingPlanStore(store: SessionStore): PendingPlanStore {
  return {
    savePendingPlan(pendingPlan, lastDisruption) {
      return store.updateSession({
        pendingPlan,
        pendingInput: null,
        lastDisruption,
        flowStage: "PLAN_READY",
      });
    },
    clearPendingPlan(flowStage) {
      const session = store.loadPersisted();
      return store.updateSession({
        pendingPlan: null,
        flowStage:
          flowStage ??
          (session.snapshot.itinerary.length
            ? "HAS_ITINERARY"
            : "NO_ITINERARY"),
      });
    },
  };
}
