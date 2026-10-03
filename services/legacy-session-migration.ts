import {
  RealSessionSchema,
  SnapshotSchema,
  type RealSession,
  type Snapshot,
} from "../types";
import { createStarterSnapshot } from "../data/session-defaults";
import { legacyProtectionPolicy } from "./protection-policy";

export function createStarterSession(): RealSession {
  const snapshot = createStarterSnapshot();
  snapshot.trip.destination = "待确认城市";
  return RealSessionSchema.parse({
    schemaVersion: 3,
    experienceMode: "real",
    flowStage: "NO_ITINERARY",
    snapshot,
    rawInput: "",
    parsedInput: null,
    lastDisruption: null,
    pendingPlan: null,
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

export function withProtectionPolicies(snapshot: Snapshot): Snapshot {
  return SnapshotSchema.parse({
    ...snapshot,
    itinerary: snapshot.itinerary.map((event) =>
      event.locked && !event.protectionPolicy
        ? { ...event, protectionPolicy: legacyProtectionPolicy(event) }
        : event,
    ),
  });
}

export function migrateSnapshotValue(value: unknown): Snapshot {
  const fallback = createStarterSnapshot();
  const candidate = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const state = candidate.state && typeof candidate.state === "object"
    ? candidate.state as Record<string, unknown>
    : {};
  const trip = candidate.trip && typeof candidate.trip === "object"
    ? candidate.trip as Record<string, unknown>
    : {};
  const currentDate = typeof state.currentDate === "string"
    ? state.currentDate
    : fallback.state.currentDate;
  return withProtectionPolicies(SnapshotSchema.parse({
    ...candidate,
    mode: "user",
    profile: {
      ...fallback.profile,
      ...(candidate.profile && typeof candidate.profile === "object"
        ? candidate.profile
        : {}),
    },
    trip: {
      ...fallback.trip,
      ...trip,
      startDate: currentDate,
      endDate: currentDate,
    },
    state: {
      ...fallback.state,
      ...state,
      currentDate,
      stateCapturedAt: typeof state.stateCapturedAt === "string"
        ? state.stateCapturedAt
        : new Date().toISOString(),
    },
  }));
}

export function migrateV2SessionValue(value: unknown): RealSession | null {
  try {
    if (!value || typeof value !== "object") return null;
    const legacy = value as Record<string, unknown>;
    const snapshot = migrateSnapshotValue(legacy.snapshot);
    return RealSessionSchema.parse({
      ...createStarterSession(),
      rawInput: typeof legacy.rawInput === "string" ? legacy.rawInput : "",
      snapshot,
      flowStage: snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
    });
  } catch {
    return null;
  }
}

export function migrateLegacySnapshotValue(value: unknown): RealSession | null {
  try {
    if (!value || typeof value !== "object") return null;
    const legacyValue = value as Record<string, unknown>;
    if (legacyValue.mode === "demo") return null;
    const snapshot = migrateSnapshotValue(legacyValue);
    return RealSessionSchema.parse({
      ...createStarterSession(),
      flowStage: snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
      snapshot: { ...snapshot, mode: "user" },
    });
  } catch {
    return null;
  }
}

export function parseCurrentSessionValue(value: unknown): RealSession {
  const session = RealSessionSchema.parse(value);
  return RealSessionSchema.parse({
    ...session,
    snapshot: withProtectionPolicies(session.snapshot),
  });
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
    (current.pendingInput.stage === "review" ||
      current.pendingInput.baseRevision !== current.snapshot.revision)
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
