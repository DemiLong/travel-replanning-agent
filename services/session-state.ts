import { createStarterSnapshot } from "../data/session-defaults";
import { RealSessionSchema, type RealSession } from "../types";

export function createStarterSession(): RealSession {
  const snapshot = createStarterSnapshot();
  snapshot.trip.destination = "待确认城市";
  return RealSessionSchema.parse({
    schemaVersion: 5,
    experienceMode: "real",
    flowStage: "NO_ITINERARY",
    snapshot,
    rawInput: "",
    parsedInput: null,
    lastDisruption: null,
    pendingPlan: null,
    pendingInput: null,
    conditionalAdvice: null,
    itineraryDraft: null,
    resolutionState: {
      currentBlockerKey: null,
      sameBlockerCount: 0,
      roundCount: 0,
      answeredFields: [],
      questionHistory: [],
    },
    updatedAt: new Date().toISOString(),
  });
}

export function parseCurrentSessionValue(value: unknown): RealSession {
  return RealSessionSchema.parse(value);
}

export function repairCurrentSession(session: RealSession): {
  session: RealSession;
  shouldPersist: boolean;
} {
  let current = session;
  let shouldPersist = false;

  if (
    current.itineraryDraft &&
    current.itineraryDraft.baseRevision !== current.snapshot.revision
  ) {
    current = RealSessionSchema.parse({ ...current, itineraryDraft: null });
    shouldPersist = true;
  }

  if (
    current.pendingInput &&
    current.pendingInput.baseRevision !== current.snapshot.revision
  ) {
    current = RealSessionSchema.parse({
      ...current,
      rawInput: current.rawInput || current.pendingInput.questionRawText,
      pendingInput: null,
      parsedInput: null,
      pendingPlan: null,
      flowStage: current.snapshot.itinerary.length
        ? "HAS_ITINERARY"
        : "NO_ITINERARY",
      resolutionState: {
        currentBlockerKey: null,
        sameBlockerCount: 0,
        roundCount: 0,
        answeredFields: [],
        questionHistory: [],
      },
    });
    shouldPersist = true;
  }

  return { session: current, shouldPersist };
}
