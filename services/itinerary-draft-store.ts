import {
  ItineraryDraftSchema,
  type ItineraryDraft,
  type ParsedUserInput,
  type RealSession,
} from "../types";
import type { SessionStore } from "./session-store";

export function createItineraryDraft(session: RealSession): ItineraryDraft {
  return ItineraryDraftSchema.parse({
    baseRevision: session.snapshot.revision,
    profile: session.snapshot.profile,
    destination: session.snapshot.trip.destination,
    currentDate: session.snapshot.state.currentDate,
    currentTime: session.snapshot.state.currentTime,
    currentLocation: session.snapshot.state.currentLocation,
    stateCapturedAt: session.snapshot.state.stateCapturedAt,
    currentTimeSource: session.snapshot.stateSources.currentTime,
    currentLocationSource: session.snapshot.stateSources.currentLocation,
    rawInput: session.rawInput,
    items: session.parsedInput?.existingPlans ?? [],
    updatedAt: new Date().toISOString(),
  });
}

export interface ItineraryDraftStore {
  saveItineraryDraft(
    value: ItineraryDraft,
    parsedInput?: ParsedUserInput | null,
  ): RealSession;
}

export function createItineraryDraftStore(
  store: SessionStore,
): ItineraryDraftStore {
  return {
    saveItineraryDraft(value, parsedInput = null) {
      const itineraryDraft = ItineraryDraftSchema.parse({
        ...value,
        updatedAt: new Date().toISOString(),
      });
      return store.updateSessionAtRevision(
        { itineraryDraft, parsedInput },
        itineraryDraft.baseRevision,
        "行程已在其他页面更新，请刷新后重新编辑。",
      );
    },
  };
}
