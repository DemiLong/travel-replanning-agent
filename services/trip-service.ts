"use client";
import {
  ItineraryDraftSchema,
  RealSessionSchema,
  SnapshotSchema,
  type AgentResult,
  type FlowStage,
  type ItineraryDraft,
  type ParsedUserInput,
  type PendingPlan,
  type RealSession,
  type ReplanningRequest,
  type Snapshot,
} from "../types";
import { createStarterSnapshot } from "../data/session-defaults";
import { legacyProtectionPolicy } from "./protection-policy";
export type TripMode = Snapshot["mode"];
export const realSessionKey = "travel-session-real-v3";
const legacyRealSessionKey = "travel-session-real-v2";
const legacyRealSessionBackupKey = "travel-session-real-v2-backup";
const legacySnapshotKey = "travel-snapshot-user";
export const resultKey = (mode: TripMode) => `travel-result-${mode}`;

export function activeTripMode(): TripMode {
  return "user";
}

function starterSession(): RealSession {
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

function migrateSnapshot(value: unknown): Snapshot {
  const fallback = createStarterSnapshot();
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const state = candidate.state && typeof candidate.state === "object" ? candidate.state as Record<string, unknown> : {};
  const trip = candidate.trip && typeof candidate.trip === "object" ? candidate.trip as Record<string, unknown> : {};
  const currentDate = typeof state.currentDate === "string" ? state.currentDate : fallback.state.currentDate;
  return withProtectionPolicies(SnapshotSchema.parse({
    ...candidate,
    mode: "user",
    profile: { ...fallback.profile, ...(candidate.profile && typeof candidate.profile === "object" ? candidate.profile : {}) },
    trip: { ...fallback.trip, ...trip, startDate: currentDate, endDate: currentDate },
    state: {
      ...fallback.state,
      ...state,
      currentDate,
      stateCapturedAt: typeof state.stateCapturedAt === "string" ? state.stateCapturedAt : new Date().toISOString(),
    },
  }));
}

function withProtectionPolicies(snapshot: Snapshot): Snapshot {
  return SnapshotSchema.parse({
    ...snapshot,
    itinerary: snapshot.itinerary.map((event) => event.locked && !event.protectionPolicy
      ? { ...event, protectionPolicy: legacyProtectionPolicy(event) }
      : event),
  });
}

export function migrateV2SessionValue(value: unknown): RealSession | null {
  try {
    if (!value || typeof value !== "object") return null;
    const legacy = value as Record<string, unknown>;
    const snapshot = migrateSnapshot(legacy.snapshot);
    return RealSessionSchema.parse({
      ...starterSession(),
      rawInput: typeof legacy.rawInput === "string" ? legacy.rawInput : "",
      snapshot,
      flowStage: snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
    });
  } catch {
    return null;
  }
}

function migrateV2Session(raw: string): RealSession | null {
  try {
    return migrateV2SessionValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function refreshSessionClock(session: RealSession): RealSession {
  const captured = Date.parse(session.snapshot.state.stateCapturedAt);
  const stale = !Number.isFinite(captured) || Date.now() - captured > 10 * 60 * 1000;
  if (session.snapshot.stateSources.currentTime === "user" && !stale) return session;
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return RealSessionSchema.parse({
    ...session,
    snapshot: {
      ...session.snapshot,
      state: { ...session.snapshot.state, currentTime, stateCapturedAt: now.toISOString() },
      stateSources: { ...session.snapshot.stateSources, currentTime: "system" },
    },
  });
}

function migrateLegacySession(): RealSession {
  const rawUser = localStorage.getItem(legacySnapshotKey);
  const legacy = localStorage.getItem("travel-snapshot");
  const candidate = rawUser ?? legacy;
  if (candidate) {
    try {
      const legacyValue = JSON.parse(candidate) as { mode?: unknown };
      const isDemo = legacyValue.mode === "demo";
      const parsed = migrateSnapshot(legacyValue);
      if (!isDemo) {
        const session = RealSessionSchema.parse({
          ...starterSession(),
          flowStage: parsed.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
          snapshot: { ...parsed, mode: "user" },
        });
        localStorage.setItem(realSessionKey, JSON.stringify(session));
        return session;
      }
    } catch {
      // Invalid legacy data is ignored instead of contaminating a new session.
    }
  }
  const session = starterSession();
  localStorage.setItem(realSessionKey, JSON.stringify(session));
  return session;
}

interface SessionRepository {
  load(): RealSession;
  save(session: RealSession): RealSession;
}

const browserSessionRepository: SessionRepository = {
  load() {
    const raw = localStorage.getItem(realSessionKey);
    if (!raw) {
      const legacySession = localStorage.getItem(legacyRealSessionKey);
      if (legacySession) {
        localStorage.setItem(legacyRealSessionBackupKey, legacySession);
        const migrated = migrateV2Session(legacySession);
        if (migrated) {
          localStorage.setItem(realSessionKey, JSON.stringify(migrated));
          return migrated;
        }
      }
      return migrateLegacySession();
    }
    try {
      let session = RealSessionSchema.parse(JSON.parse(raw));
      session = RealSessionSchema.parse({ ...session, snapshot: withProtectionPolicies(session.snapshot) });
      if (session.itineraryDraft && session.itineraryDraft.baseRevision !== session.snapshot.revision) {
        session = RealSessionSchema.parse({ ...session, itineraryDraft: null });
        localStorage.setItem(realSessionKey, JSON.stringify(session));
      }
      if (session.pendingInput && (session.pendingInput.stage === "review" || session.pendingInput.baseRevision !== session.snapshot.revision)) {
        const migrated = RealSessionSchema.parse({ ...session, rawInput: session.rawInput || session.pendingInput.questionRawText,
          pendingInput: null, parsedInput: null, pendingPlan: null, flowStage: session.snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
          resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] } });
        localStorage.setItem(realSessionKey, JSON.stringify(migrated));
        return migrated;
      }
      return session;
    } catch {
      return migrateLegacySession();
    }
  },
  save(value) {
    const session = RealSessionSchema.parse({
      ...value,
      experienceMode: "real",
      snapshot: { ...value.snapshot, mode: "user" },
      updatedAt: new Date().toISOString(),
    });
    localStorage.setItem(realSessionKey, JSON.stringify(session));
    return session;
  },
};

export function loadSession() {
  return refreshSessionClock(browserSessionRepository.load());
}

function persistSession(value: RealSession) {
  return browserSessionRepository.save(value);
}

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

export function saveItineraryDraft(
  value: ItineraryDraft,
  parsedInput: ParsedUserInput | null = null,
) {
  const session = browserSessionRepository.load();
  const itineraryDraft = ItineraryDraftSchema.parse({
    ...value,
    updatedAt: new Date().toISOString(),
  });
  if (session.snapshot.revision !== itineraryDraft.baseRevision)
    throw new Error("行程已在其他页面更新，请刷新后重新编辑。");
  return persistSession({ ...session, itineraryDraft, parsedInput });
}

export function commitSnapshot(
  next: Snapshot,
  expectedRevision: number,
): RealSession {
  const snapshot = SnapshotSchema.parse({ ...next, mode: "user" });
  const session = browserSessionRepository.load();
  if (session.snapshot.revision !== expectedRevision)
    throw new Error("另一个标签页修改了你的行程，请刷新后再保存。");
  if (snapshot.revision !== expectedRevision + 1)
    throw new Error("行程版本不连续，请刷新后再保存。");
  return persistSession({ ...session, snapshot: { ...snapshot, mode: "user" } });
}

export type SessionPatch = Partial<Omit<RealSession, "snapshot">> & {
  snapshot?: never;
};

export function updateSession(patch: SessionPatch): RealSession {
  return persistSession({ ...browserSessionRepository.load(), ...patch });
}

export function saveFlowDraft(
  rawInput: string,
  parsedInput: ParsedUserInput | null,
  flowStage: FlowStage,
) {
  return updateSession({ rawInput, parsedInput, flowStage });
}

export function savePendingPlan(
  pendingPlan: PendingPlan,
  lastDisruption: ReplanningRequest,
) {
  return updateSession({
    pendingPlan,
    pendingInput: null,
    lastDisruption,
    flowStage: "PLAN_READY",
  });
}

export function clearPendingPlan(flowStage?: FlowStage) {
  const session = loadSession();
  return updateSession({
    pendingPlan: null,
    flowStage:
      flowStage ??
      (session.snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY"),
  });
}

export function localTrip(): Snapshot {
  return loadSession().snapshot;
}
export async function loadTrip() {
  return localTrip();
}
export type AnalyticsName =
  | "trip_created"
  | "replan_started"
  | "replan_generated"
  | "replan_validation_failed"
  | "replan_regenerated"
  | "replan_accepted"
  | "replan_rejected"
  | "preference_saved";
export type AnalyticsEvent = {
  id: string;
  name: AnalyticsName;
  created_at: string;
  properties: Record<string, unknown>;
};
export async function logEvent(
  name: AnalyticsName,
  properties: Record<string, unknown> = {},
  id: string = crypto.randomUUID(),
) {
  const item: AnalyticsEvent = {
    id,
    name,
    created_at: new Date().toISOString(),
    properties,
  };
  try {
    const list: AnalyticsEvent[] = JSON.parse(
      localStorage.getItem("travel-analytics") ?? "[]",
    );
    if (!list.some((e) => e.id === id)) {
      list.push(item);
      localStorage.setItem(
        "travel-analytics",
        JSON.stringify(list.slice(-1000)),
      );
    }
    return true;
  } catch {
    return false;
  }
}
export async function recordResult(result: AgentResult) {
  const properties = {
    planId: result.id,
    mode: result.mode,
    model: result.model,
  };
  for (const attempt of result.attempts) {
    if (attempt.attempt > 1)
      await logEvent(
        "replan_regenerated",
        { ...properties, regenerationCount: attempt.attempt - 1 },
        `${result.id}-retry-${attempt.attempt}`,
      );
    if (attempt.violations.length)
      await logEvent(
        "replan_validation_failed",
        { ...properties, codes: attempt.violations.map((v) => v.code) },
        `${result.id}-failure-${attempt.attempt}`,
      );
  }
  if (result.ok)
    await logEvent(
      "replan_generated",
      { ...properties, regenerationCount: result.attempts.length - 1 },
      `${result.id}-generated`,
    );
}
