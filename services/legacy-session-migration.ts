import {
  ActivityFactSchema,
  AgentResultSchema,
  ConfirmedDraftSchema,
  ItineraryDraftSchema,
  ParsedUserInputSchema,
  PendingInputSchema,
  PendingPlanSchema,
  ProtectionPolicySchema,
  RealSessionSchema,
  ReplanningRequestSchema,
  SnapshotSchema,
  type ActivityFact,
  type ProtectionPolicy,
  type RealSession,
  type Snapshot,
} from "../types";
import { createStarterSnapshot } from "../data/session-defaults";
import { addMinutesWithinDay, minutes } from "../lib/time";
import { snapshotActivityFacts } from "./activity-facts";
import { protectionPolicyForActivity } from "./protection-policy";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

function legacyProtectionPolicyForEvent(event: Snapshot["itinerary"][number]): ProtectionPolicy | undefined {
  if (!event.locked) return undefined;
  const duration = Math.max(0, minutes(event.endTime) - minutes(event.startTime));
  return ProtectionPolicySchema.parse({
    source: "legacy",
    kind: "generic",
    lockedFields: ["name", "startTime", "endTime", "duration", "location"],
    timeAnchor: "starts_at",
    durationPolicy: {
      mode: event.durationSource === "unknown" ? "unknown" : "fixed",
      defaultMinutes: event.durationSource === "unknown" ? null : duration,
      minMinutes: event.durationSource === "unknown" ? null : duration,
      maxMinutes: event.durationSource === "unknown" ? null : duration,
    },
    allowedStartTimes: [event.startTime],
    locationGranularity: "venue",
    transportKind: null,
    arrivalBuffer: null,
    locationNote: null,
  });
}

export function createStarterSession(): RealSession {
  const snapshot = createStarterSnapshot();
  snapshot.trip.destination = "待确认城市";
  return RealSessionSchema.parse({
    schemaVersion: 4,
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
        ? { ...event, protectionPolicy: legacyProtectionPolicyForEvent(event) }
        : event,
    ),
  });
}

export function migrateSnapshotValue(value: unknown): Snapshot {
  const fallback = createStarterSnapshot();
  const candidate = record(value);
  const state = record(candidate.state);
  const trip = record(candidate.trip);
  const currentDate = typeof state.currentDate === "string" ? state.currentDate : fallback.state.currentDate;
  return withProtectionPolicies(SnapshotSchema.parse({
    ...candidate,
    mode: "user",
    profile: { ...fallback.profile, ...record(candidate.profile) },
    trip: { ...fallback.trip, ...trip, startDate: currentDate, endDate: currentDate },
    state: {
      ...fallback.state,
      ...state,
      currentDate,
      stateCapturedAt: typeof state.stateCapturedAt === "string" ? state.stateCapturedAt : new Date().toISOString(),
    },
  }));
}

function migratedFact(value: unknown, snapshot: Snapshot, index: number): ActivityFact | null {
  const item = record(value);
  const id = typeof item.id === "string" && item.id ? item.id : `legacy-${index}`;
  const snapshotEventId = typeof item.snapshotEventId === "string"
    ? item.snapshotEventId
    : snapshot.itinerary.some(event => event.id === id) ? id : null;
  const saved = snapshotEventId ? snapshot.itinerary.find(event => event.id === snapshotEventId) : undefined;
  const origin = item.origin === "snapshot" || saved ? "snapshot" as const : "message" as const;
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : saved?.name ?? "未命名安排";
  const placeQuery = typeof item.placeQuery === "string"
    ? item.placeQuery.trim() || null
    : typeof item.location === "string" ? item.location.trim() || null : saved?.location ?? null;
  const startTime = typeof item.startTime === "string" && item.startTime ? item.startTime : saved?.startTime ?? null;
  const suppliedEnd = typeof item.endTime === "string" && item.endTime ? item.endTime : null;
  const suppliedDuration = typeof item.durationMinutes === "number" && item.durationMinutes > 0 ? item.durationMinutes : null;
  let endTime = suppliedEnd;
  if (!endTime && startTime && suppliedDuration) {
    try { endTime = addMinutesWithinDay(startTime, suppliedDuration); } catch { endTime = null; }
  }
  if (!endTime && saved?.durationSource !== "unknown") endTime = saved?.endTime ?? null;
  const durationMinutes = suppliedDuration ?? (startTime && endTime ? Math.max(1, minutes(endTime) - minutes(startTime)) : null);
  const commitment = item.commitment === "fixed" || item.commitment === "uncertain" || item.commitment === "flexible"
    ? item.commitment
    : item.locked === "uncertain" ? "uncertain"
      : item.locked === true || item.locked === "yes" || saved?.locked ? "fixed" : "flexible";
  const parsedPolicy = ProtectionPolicySchema.safeParse(item.protectionPolicy);
  const protectionPolicy = commitment === "flexible" ? undefined
    : parsedPolicy.success ? parsedPolicy.data
      : saved?.protectionPolicy ?? (saved ? legacyProtectionPolicyForEvent(saved) : protectionPolicyForActivity({
        name,
        location: placeQuery,
        sourceText: typeof item.sourceText === "string" ? item.sourceText : name,
        startTime,
        endTime,
        durationMinutes,
        commitment,
      }));
  return ActivityFactSchema.parse({
    id: saved?.id ?? id,
    placeId: typeof item.placeId === "string" && item.placeId ? item.placeId : saved?.placeId ?? `custom-${id}`,
    origin,
    snapshotEventId: saved?.id ?? snapshotEventId,
    role: ["existing_plan", "considering", "reference", "uncertain"].includes(String(item.role)) ? item.role : "existing_plan",
    progress: ["not_started", "missed", "ongoing", "completed"].includes(String(item.progress))
      ? item.progress : saved?.status === "completed" ? "completed" : saved?.status === "missed" ? "missed" : "not_started",
    name,
    placeQuery,
    startTime,
    startTimeSource: ["user", "snapshot", "not_provided"].includes(String(item.startTimeSource))
      ? item.startTimeSource : saved ? "snapshot" : startTime ? "user" : "not_provided",
    endTime,
    durationMinutes,
    durationSource: ["user", "suggested", "unknown"].includes(String(item.durationSource))
      ? item.durationSource : saved?.durationSource ?? (durationMinutes ? "user" : "unknown"),
    commitment,
    protectionPolicy,
    sourceText: typeof item.sourceText === "string" ? item.sourceText : null,
  });
}

function migratedFacts(value: unknown, snapshot: Snapshot): ActivityFact[] {
  const container = record(value);
  const direct = Array.isArray(container.activityFacts) ? container.activityFacts : [];
  const legacyPlans = Array.isArray(container.existingPlans) ? container.existingPlans : [];
  const legacyMentions = Array.isArray(container.activityMentions) ? container.activityMentions : [];
  const source = direct.length ? direct : [...legacyPlans, ...legacyMentions];
  const merged = new Map<string, ActivityFact>();
  source.forEach((item, index) => {
    try {
      const fact = migratedFact(item, snapshot, index);
      if (fact) merged.set(fact.snapshotEventId ?? fact.id, fact);
    } catch {
      // A malformed activity is omitted while the rest of the local session survives.
    }
  });
  return [...merged.values()];
}

function migrateParsedInputValue(value: unknown, snapshot: Snapshot) {
  if (!value) return null;
  const parsed = record(value);
  return ParsedUserInputSchema.parse({ ...parsed, activityFacts: migratedFacts(parsed, snapshot) });
}

function migrateConfirmedDraftValue(value: unknown, snapshot: Snapshot) {
  const draft = record(value);
  return ConfirmedDraftSchema.parse({ ...draft, activityFacts: migratedFacts(draft, snapshot) });
}

function migrateRequestValue(value: unknown, snapshot: Snapshot, fallbackFacts?: ActivityFact[]) {
  if (!value) return null;
  const request = record(value);
  const facts = Array.isArray(request.activityFacts)
    ? migratedFacts({ activityFacts: request.activityFacts }, snapshot)
    : fallbackFacts ?? [
      ...snapshotActivityFacts(snapshot),
      ...migratedFacts({ activityFacts: request.unscheduledOriginals }, snapshot),
    ];
  return ReplanningRequestSchema.parse({ ...request, activityFacts: facts });
}

function migratePendingPlanValue(value: unknown, sessionSnapshot: Snapshot) {
  if (!value) return null;
  const pending = record(value);
  const base = migrateSnapshotValue(pending.base ?? sessionSnapshot);
  const parsedInput = migrateParsedInputValue(pending.parsedInput, base) ?? undefined;
  const request = migrateRequestValue(pending.request, base, parsedInput?.activityFacts);
  if (!request) return null;
  const result = record(pending.result);
  const context = record(result.context);
  const activityFacts = request.activityFacts;
  const remainingActivityFacts = activityFacts.filter(fact => fact.role === "existing_plan" && fact.progress !== "completed");
  const protectedActivityFacts = remainingActivityFacts.filter(fact => fact.commitment !== "flexible");
  const migratedResult = AgentResultSchema.parse({
    ...result,
    context: { ...context, activityFacts, remainingActivityFacts, protectedActivityFacts, disruption: request },
  });
  return PendingPlanSchema.parse({ ...pending, base, request, result: migratedResult, parsedInput });
}

function migrateCurrentLikeSession(value: unknown): RealSession {
  const legacy = record(value);
  const snapshot = migrateSnapshotValue(legacy.snapshot);
  const parsedInput = migrateParsedInputValue(legacy.parsedInput, snapshot);
  const itineraryDraftValue = legacy.itineraryDraft ? record(legacy.itineraryDraft) : null;
  const itineraryDraft = itineraryDraftValue ? ItineraryDraftSchema.parse({
    ...itineraryDraftValue,
    activityFacts: migratedFacts({ activityFacts: itineraryDraftValue.activityFacts, existingPlans: itineraryDraftValue.items }, snapshot),
  }) : null;
  const pendingInputValue = legacy.pendingInput ? record(legacy.pendingInput) : null;
  const pendingInput = pendingInputValue ? PendingInputSchema.parse({
    ...pendingInputValue,
    parsedInput: migrateParsedInputValue(pendingInputValue.parsedInput, snapshot),
    confirmedDraft: migrateConfirmedDraftValue(pendingInputValue.confirmedDraft, snapshot),
  }) : null;
  return RealSessionSchema.parse({
    ...createStarterSession(),
    ...legacy,
    schemaVersion: 4,
    snapshot,
    parsedInput,
    lastDisruption: migrateRequestValue(legacy.lastDisruption, snapshot, parsedInput?.activityFacts) ?? null,
    itineraryDraft,
    pendingInput,
    pendingPlan: migratePendingPlanValue(legacy.pendingPlan, snapshot),
  });
}

export function migrateV3SessionValue(value: unknown): RealSession | null {
  try { return migrateCurrentLikeSession(value); } catch { return null; }
}

export function migrateV2SessionValue(value: unknown): RealSession | null {
  try {
    const legacy = record(value);
    const snapshot = migrateSnapshotValue(legacy.snapshot);
    return RealSessionSchema.parse({
      ...createStarterSession(),
      rawInput: typeof legacy.rawInput === "string" ? legacy.rawInput : "",
      snapshot,
      flowStage: snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
    });
  } catch { return null; }
}

export function migrateLegacySnapshotValue(value: unknown): RealSession | null {
  try {
    const legacyValue = record(value);
    if (legacyValue.mode === "demo") return null;
    const snapshot = migrateSnapshotValue(legacyValue);
    return RealSessionSchema.parse({
      ...createStarterSession(),
      flowStage: snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
      snapshot: { ...snapshot, mode: "user" },
    });
  } catch { return null; }
}

export function parseCurrentSessionValue(value: unknown): RealSession {
  return RealSessionSchema.parse(value);
}

export function repairCurrentSession(session: RealSession): { session: RealSession; shouldPersist: boolean } {
  let current = session;
  let shouldPersist = false;
  if (current.itineraryDraft && current.itineraryDraft.baseRevision !== current.snapshot.revision) {
    current = RealSessionSchema.parse({ ...current, itineraryDraft: null });
    shouldPersist = true;
  }
  if (current.pendingInput && (current.pendingInput.stage === "review" || current.pendingInput.baseRevision !== current.snapshot.revision)) {
    current = RealSessionSchema.parse({
      ...current,
      rawInput: current.rawInput || current.pendingInput.questionRawText,
      pendingInput: null,
      parsedInput: null,
      pendingPlan: null,
      flowStage: current.snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
      resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] },
    });
    shouldPersist = true;
  }
  return { session: current, shouldPersist };
}
