"use client";

import { createAnalyticsService } from "./analytics";
import {
  createBrowserSessionRepository,
  realSessionKey,
} from "./browser-session-repository";
import {
  createItineraryDraft,
  createItineraryDraftStore,
} from "./itinerary-draft-store";
import { createPendingPlanStore } from "./pending-plan-store";
import { createSessionStore } from "./session-store";
import {
  activeTripMode,
  createSnapshotService,
  resultKey,
} from "./snapshot-service";

const repository = createBrowserSessionRepository();
const sessionStore = createSessionStore(repository);
const snapshotService = createSnapshotService(sessionStore);
const itineraryDraftStore = createItineraryDraftStore(sessionStore);
const pendingPlanStore = createPendingPlanStore(sessionStore);
const analyticsService = createAnalyticsService(repository);

export { realSessionKey };
export { activeTripMode, resultKey };
export { createItineraryDraft };
export { migrateV2SessionValue } from "./legacy-session-migration";
export type { SessionPatch } from "./session-store";
export type { TripMode } from "./snapshot-service";
export type { AnalyticsEvent, AnalyticsName } from "./analytics";

export const loadSession = sessionStore.loadSession;
export const updateSession = sessionStore.updateSession;
export const saveFlowDraft = sessionStore.saveFlowDraft;
export const commitSnapshot = snapshotService.commitSnapshot;
export const localTrip = snapshotService.localTrip;
export const loadTrip = snapshotService.loadTrip;
export const saveItineraryDraft = itineraryDraftStore.saveItineraryDraft;
export const savePendingPlan = pendingPlanStore.savePendingPlan;
export const clearPendingPlan = pendingPlanStore.clearPendingPlan;
export const logEvent = analyticsService.logEvent;
export const recordResult = analyticsService.recordResult;
