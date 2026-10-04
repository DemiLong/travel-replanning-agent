import { z } from "zod";
import { BrowserLocationSchema, WorldOptionsSchema, RealWorldContextSchema, ResolutionEvidenceSchema, type RealWorldContext } from "./world";
import { MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE } from "./protocol";

export const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Invalid date",
  );
export const UserProfileSchema = z.object({
  id: z.string().min(1),
  travelPace: z.enum(["relaxed", "balanced", "packed"]),
  walkingTolerance: z.enum(["low", "medium", "high"]),
});
export const TripSchema = z
  .object({
    id: z.string(),
    destination: z.string().min(1).max(80),
    startDate: DateSchema,
    endDate: DateSchema,
  })
  .refine((t) => t.endDate === t.startDate, "Only same-day trips are supported");
export const TripStateSchema = z.object({
  currentDate: DateSchema,
  currentTime: TimeSchema,
  stateCapturedAt: z.string().datetime(),
  currentLocation: z.string().max(100),
  browserLocation: BrowserLocationSchema.optional(),
  energyLevel: z.enum(["low", "medium", "high"]).optional(),
  weather: z.enum(["sunny", "rain", "hot"]).optional(),
});
export const FactSourceSchema = z.enum(["user", "system", "demo", "unset"]);
export const StateSourcesSchema = z.object({
  currentTime: FactSourceSchema,
  currentLocation: FactSourceSchema,
  weather: FactSourceSchema,
  energyLevel: FactSourceSchema,
  disruption: FactSourceSchema,
});
export const ProtectedFieldSchema = z.enum([
  "name",
  "startTime",
  "endTime",
  "duration",
  "location",
]);
export const ProtectionPolicySchema = z.object({
  source: z.enum(["confirmed", "possible", "legacy"]),
  kind: z.enum([
    "restaurant_reservation",
    "ticketed_event",
    "meeting",
    "transport",
    "rebookable",
    "generic",
  ]),
  lockedFields: z.array(ProtectedFieldSchema).max(5),
  timeAnchor: z.enum(["starts_at", "arrive_by", "departs_at"]),
  durationPolicy: z.object({
    mode: z.enum(["fixed", "suggested", "unknown"]),
    defaultMinutes: z.number().int().positive().max(1440).nullable(),
    minMinutes: z.number().int().positive().max(1440).nullable(),
    maxMinutes: z.number().int().positive().max(1440).nullable(),
  }),
  allowedStartTimes: z.array(TimeSchema).max(12).default([]),
  locationGranularity: z.enum(["venue", "station", "transport_hub"]),
  transportKind: z.enum(["train", "flight"]).nullable().default(null),
  arrivalBuffer: z
    .object({
      mode: z.literal("dynamic"),
      recommendedMinutes: z.number().int().nonnegative().max(360),
      basis: z.string().min(1).max(200),
    })
    .nullable()
    .default(null),
  locationNote: z.string().max(160).nullable().default(null),
});
export const EventSchema = z.object({
  id: z.string().min(1),
  placeId: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  startTime: TimeSchema,
  endTime: TimeSchema,
  startTimeSource: z.enum(["user", "snapshot", "suggested"]).optional(),
  durationSource: z.enum(["user", "suggested", "unknown"]).optional(),
  travelMode: z.enum(["DRIVING", "WALKING", "TRANSIT"]).optional(),
  location: z.string(),
  status: z.enum(["completed", "missed", "planned", "locked"]),
  locked: z.boolean(),
  protectionPolicy: ProtectionPolicySchema.optional(),
  indoorOutdoor: z.enum(["indoor", "outdoor", "mixed"]),
  openingTime: TimeSchema.nullable(),
  closingTime: TimeSchema.nullable(),
  travelTimeFromPrevious: z.number().min(0).nullable(),
  reason: z.string().min(1),
  constraint: z.string().min(1),
});
export const PlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  district: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  openingTime: TimeSchema,
  closingTime: TimeSchema,
  indoorOutdoor: z.enum(["indoor", "outdoor", "mixed"]),
  averageDuration: z.number().positive(),
  tags: z.array(z.string()),
});
export const reasons = [
  "late",
  "weather",
  "tired",
  "closed",
  "discovery",
  "changed_mind",
  "optimize",
  "other",
] as const;
export const ActivityFactSchema = z.object({
  id: z.string().min(1),
  placeId: z.string().min(1),
  origin: z.enum(["snapshot", "message"]),
  snapshotEventId: z.string().nullable(),
  role: z.enum(["existing_plan", "considering", "reference", "uncertain"]),
  progress: z.enum(["not_started", "missed", "ongoing", "completed"]),
  name: z.string().trim().min(1).max(160),
  placeQuery: z.string().trim().max(160).nullable(),
  startTime: TimeSchema.nullable(),
  startTimeSource: z.enum(["user", "snapshot", "not_provided"]),
  endTime: TimeSchema.nullable(),
  durationMinutes: z.number().int().positive().max(1440).nullable(),
  durationSource: z.enum(["user", "suggested", "unknown"]),
  commitment: z.enum(["fixed", "flexible", "uncertain"]),
  protectionPolicy: ProtectionPolicySchema.optional(),
  sourceText: z.string().max(500).nullable(),
}).superRefine((fact, context) => {
  if (fact.commitment === "flexible" && fact.protectionPolicy) {
    context.addIssue({ code: "custom", path: ["protectionPolicy"], message: "弹性安排不能携带保护策略。" });
  }
  if (fact.commitment !== "flexible" && !fact.protectionPolicy) {
    context.addIssue({ code: "custom", path: ["protectionPolicy"], message: "固定或可能固定的安排必须携带保护策略。" });
  }
});
export const ReplanningRequestSchema = z.object({
  reason: z.enum(reasons),
  freeText: z.string().max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE),
  currentState: TripStateSchema,
  closedPlaceIds: z.array(z.string()).max(30),
  variation: z.number().int().min(0).max(100),
  stateSources: StateSourcesSchema.optional(),
  worldOptions: WorldOptionsSchema.optional(),
  activityFacts: z.array(ActivityFactSchema).max(30),
  confirmedDraftChanges: z.object({ removedLockedIds: z.array(z.string()).max(30) }).optional(),
});
const DecisionFactSchema = z.object({
  field: z.string(),
  value: z.string(),
  source: FactSourceSchema,
});
const DecisionSchema = z.object({
  eventId: z.string().optional(),
  decision: z.string(),
  reason: z.string(),
  evidence: z.array(z.string()),
});
export const ValidationEvidenceSchema = z.object({
  check: z.string(),
  status: z.enum(["passed", "failed", "not_checked"]),
  detail: z.string(),
  source: FactSourceSchema,
});
export const DecisionTraceSchema = z.object({
  inputFacts: z.array(DecisionFactSchema),
  decisions: z.array(DecisionSchema),
  validationEvidence: z.array(ValidationEvidenceSchema),
});
const ChangeSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  reason: z.string().min(1),
  constraint: z.string().min(1),
});
export const ProposedPlanSchema = z.object({
  summary: z.string().min(1),
  events: z.array(EventSchema).max(20),
  movedEvents: z
    .array(
      ChangeSchema.extend({
        suggestedDate: DateSchema,
        suggestedStart: TimeSchema,
        note: z.string(),
      }),
    )
    .max(20),
  removedEvents: z.array(ChangeSchema).max(20),
  explanation: z.string().min(1),
});
export const SnapshotSchema = z.object({
  mode: z.enum(["user", "demo"]).default("user"),
  profile: UserProfileSchema,
  trip: TripSchema,
  state: TripStateSchema,
  stateSources: StateSourcesSchema.default({
    currentTime: "system",
    currentLocation: "unset",
    weather: "unset",
    energyLevel: "unset",
    disruption: "unset",
  }),
  itinerary: z.array(EventSchema).max(30),
  revision: z.number().int().min(0),
});

export const ExperienceModeSchema = z.enum(["real", "demo"]);
export const FlowStageSchema = z.enum([
  "NO_ITINERARY",
  "HAS_ITINERARY",
  "NEEDS_INPUT",
  "PLAN_READY",
  "OUT_OF_SCOPE",
  "UNAVAILABLE",
  "NO_SAFE_PLAN",
]);
export const UnifiedIntentSchema = z.enum([
  "create",
  "rescue",
  "mixed",
  "optimize",
]);
export const SemanticActivitySchema = z.object({
  role: z.enum(["existing_plan", "considering", "reference", "uncertain"]),
  name: z.string().max(160),
  startTime: TimeSchema.nullable(),
  // Exact words in the user's message that support the interpreted start time.
  startTimeEvidence: z.string().max(100).nullable().default(null),
  endTime: TimeSchema.nullable(),
  durationMinutes: z.number().int().positive().max(1440).nullable(),
  location: z.string().max(100).nullable(),
  locked: z.enum(["yes", "no", "uncertain"]),
  sourceText: z.string().max(500),
  progress: z.enum(["not_started", "missed", "ongoing", "completed"]).default("not_started"),
});
export const SemanticExtractionSchema = z.object({
  intent: UnifiedIntentSchema,
  activities: z.array(SemanticActivitySchema).max(30),
  disruptions: z
    .array(
      z.object({
        kind: z.enum(reasons),
        label: z.string().min(1).max(160),
        sourceText: z.string().min(1).max(500),
      }),
    )
    .max(10),
  constraints: z
    .array(
      z.object({
        kind: z.enum(["keep", "time", "region"]),
        value: z.string().min(1).max(300),
        sourceText: z.string().min(1).max(500),
      }),
    )
    .max(30),
  context: z.object({
    currentTime: z.object({
      value: TimeSchema.nullable(),
      sourceText: z.string().max(500).nullable(),
    }),
    currentLocation: z.object({
      value: z.string().max(100).nullable(),
      sourceText: z.string().max(500).nullable(),
    }),
    weather: z.object({
      value: z.enum(["sunny", "rain", "hot"]).nullable(),
      sourceText: z.string().max(500).nullable(),
    }),
    energyLevel: z.object({
      value: z.enum(["low", "medium", "high"]).nullable(),
      sourceText: z.string().max(500).nullable(),
    }),
  }),
  question: z.string().max(500).nullable(),
  ambiguities: z.array(z.string().min(1).max(300)).max(12),
});
export const ParsedDisruptionSchema = z.object({
  kind: z.enum(reasons),
  label: z.string().min(1),
  source: FactSourceSchema,
});
export const ParsedConstraintSchema = z.object({
  kind: z.enum(["keep", "time", "region"]),
  value: z.string().min(1),
  source: FactSourceSchema,
});
export const ParsedContextSchema = TripStateSchema.partial().extend({
  currentDate: DateSchema,
  currentTime: TimeSchema,
});
export const ParsedUserInputSchema = z.object({
  rawText: z.string().max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE),
  destinationDraft: z.string().max(80).optional(),
  intent: UnifiedIntentSchema,
  activityFacts: z.array(ActivityFactSchema).max(30),
  disruptions: z.array(ParsedDisruptionSchema).max(10),
  constraints: z.array(ParsedConstraintSchema).max(30),
  context: ParsedContextSchema,
  contextSources: StateSourcesSchema,
  closedPlaceIds: z.array(z.string()).max(30).default([]),
  missingFacts: z.array(z.string()).max(100),
  status: z.enum(["draft", "needs_input", "confirmed"]),
  parser: z
    .enum(["llm", "deterministic_fallback", "manual"])
    .default("deterministic_fallback"),
  parserModel: z.string().max(100).nullable().default(null),
  parseWarnings: z.array(z.string().max(300)).max(20).default([]),
  question: z.string().max(500).nullable().optional(),
  resolutionEvidence: ResolutionEvidenceSchema.array().optional(),
  worldOptions: WorldOptionsSchema.optional(),
});
export const ConfirmedDraftSchema = z.object({
  rawText: z.string().max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE),
  intent: UnifiedIntentSchema,
  activityFacts: z.array(ActivityFactSchema).max(30),
  removedOriginalIds: z.array(z.string().min(1)).max(30).default([]),
  disruptions: z.array(ParsedDisruptionSchema).max(10),
  constraints: z.array(ParsedConstraintSchema).max(30),
  context: ParsedContextSchema,
  contextSources: StateSourcesSchema,
  closedPlaceIds: z.array(z.string()).max(30).default([]),
  question: z.string().max(500).nullable().optional(),
  worldOptions: WorldOptionsSchema.optional(),
  destination: z.string().min(1).max(80).optional(),
  removedLockedIds: z.array(z.string()).max(30).default([]),
  baseRevision: z.number().int().min(0),
});
export const MissingFactSchema = z.object({
  key: z.string().min(1),
  field: z.string().min(1),
  importance: z.enum(["blocking", "optional"]),
  reason: z.string().min(1),
  question: z.string().min(1),
  answerType: z.enum(["text", "time", "poi", "browser_location", "event_selection"]),
  candidates: z.array(z.object({ value: z.string().min(1), label: z.string().min(1), description: z.string().optional() })).max(10).optional(),
});
export const ImpactAnalysisSchema = z.object({
  completedActivities: z.array(z.string()),
  preservedActivities: z.array(z.string()),
  affectedActivities: z.array(z.string()),
  modifiedActivities: z.array(z.string()),
  removedActivities: z.array(z.string()),
  riskActivities: z.array(z.string()),
  lockedActivities: z.array(z.string()),
  replacementCandidates: z.array(z.string()),
  activityWeatherJudgments: z.array(z.object({
    id: z.string(), name: z.string(), exposure: z.enum(["outdoor", "indoor", "unknown"]),
    evidence: z.string(), affected: z.boolean(),
  })).default([]),
  availableTimeWindows: z.array(z.object({
    startTime: TimeSchema,
    endTime: TimeSchema,
    cause: z.string(),
    constraints: z.array(z.string()),
  })),
});
export const PlanConflictSchema = z.object({
  kind: z.enum(["unknown_duration_window", "locked_schedule_conflict", "time_conflict", "travel_time", "other"]),
  eventId: z.string().min(1),
  nextAnchorEventId: z.string().min(1).optional(),
  availableMinutes: z.number().int().optional(),
  requiredTransferMinutes: z.number().int().nonnegative().optional(),
  message: z.string().min(1),
});
export const ResolutionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  action: z.enum(["remove_event", "shorten_unknown_duration", "edit_locked_arrangement"]),
  eventId: z.string().min(1),
  nextAnchorEventId: z.string().min(1).optional(),
  suggestedDuration: z.number().int().min(1).max(180).optional(),
  requiresConfirmation: z.boolean(),
});
export const ReplanInputSchema = z.object({
  snapshot: SnapshotSchema,
  request: ReplanningRequestSchema,
  mode: z.enum(["demo", "local", "live"]),
  confirmation: z
    .object({
      status: z.literal("confirmed"),
      confirmedAt: z.string().datetime(),
    })
    .optional(),
});
export const SoftEvaluationSchema = z.object({
  planId: z.string(),
  reviewer: z.string(),
  relevance: z.number().int().min(1).max(5),
  personalization: z.number().int().min(1).max(5),
  reasonableness: z.number().int().min(1).max(5),
  preferenceAlignment: z.number().int().min(1).max(5),
  explanationQuality: z.number().int().min(1).max(5),
  notes: z.string(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type Trip = z.infer<typeof TripSchema>;
export type TripState = z.infer<typeof TripStateSchema>;
export type StateSources = z.infer<typeof StateSourcesSchema>;
export type ItineraryEvent = z.infer<typeof EventSchema>;
export type ProtectionPolicy = z.infer<typeof ProtectionPolicySchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type ReplanningRequest = z.infer<typeof ReplanningRequestSchema>;
export type ProposedPlan = z.infer<typeof ProposedPlanSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type ExperienceMode = z.infer<typeof ExperienceModeSchema>;
export type FlowStage = z.infer<typeof FlowStageSchema>;
export type ParsedUserInput = z.infer<typeof ParsedUserInputSchema>;
export type ActivityFact = z.infer<typeof ActivityFactSchema>;
export type ConfirmedDraft = z.infer<typeof ConfirmedDraftSchema>;
export type SemanticExtraction = z.infer<typeof SemanticExtractionSchema>;
export type MissingFact = z.infer<typeof MissingFactSchema>;
export type ImpactAnalysis = z.infer<typeof ImpactAnalysisSchema>;
export type PlanConflict = z.infer<typeof PlanConflictSchema>;
export type ResolutionOption = z.infer<typeof ResolutionOptionSchema>;
export type AgentContext = {
  world?: RealWorldContext;
  profile: UserProfile;
  trip: Trip;
  state: TripState;
  stateSources: StateSources;
  activityFacts: ActivityFact[];
  remainingActivityFacts: ActivityFact[];
  protectedActivityFacts: ActivityFact[];
  disruption: ReplanningRequest;
  places: Place[];
  travelMinutes: Record<string, number>;
  impactAnalysis?: ImpactAnalysis;
  removedLockedIds?: string[];
};
export type Violation = {
  code:
    | "locked_event"
    | "time_conflict"
    | "travel_time"
    | "opening_hours"
    | "past_event"
    | "duration"
    | "place_data"
    | "schema"
    | "context"
    | "change_accounting";
  message: string;
  eventId?: string;
  conflict?: PlanConflict;
};
export type Attempt = {
  attempt: number;
  violations: Violation[];
  durationMs: number;
};
export type AgentResult = {
  candidateComparisons?: Array<{title:string;tradeOff:string;feasible:boolean;conflicts:string[]}>;
  candidatePlans?: Array<{id:string;title:string;tradeOff:string;feasible:boolean;plan:ProposedPlan|null;conflicts:PlanConflict[]}>;
  conflicts?: PlanConflict[];
  resolutionOptions?: ResolutionOption[];
  impactAnalysis?: ImpactAnalysis;
  id: string;
  ok: boolean;
  plan: ProposedPlan | null;
  attempts: Attempt[];
  mode: "demo" | "local" | "live";
  model: string;
  message: string;
  verificationLevel?: "partial" | "complete";
  context: AgentContext;
  decisionTrace?: z.infer<typeof DecisionTraceSchema>;
};
export const AgentResultSchema: z.ZodType<AgentResult, z.ZodTypeDef, unknown> = z.object({
  candidateComparisons:z.array(z.object({title:z.string(),tradeOff:z.string(),feasible:z.boolean(),conflicts:z.array(z.string())})).optional(),
  candidatePlans:z.array(z.object({id:z.string(),title:z.string(),tradeOff:z.string(),feasible:z.boolean(),plan:ProposedPlanSchema.nullable(),conflicts:z.array(PlanConflictSchema)})).optional(),
  conflicts:z.array(PlanConflictSchema).optional(),
  resolutionOptions:z.array(ResolutionOptionSchema).optional(),
  impactAnalysis: ImpactAnalysisSchema.optional(),
  id: z.string(),
  ok: z.boolean(),
  plan: ProposedPlanSchema.nullable(),
  mode: z.enum(["demo", "local", "live"]),
  model: z.string(),
  message: z.string(),
  verificationLevel: z.enum(["partial", "complete"]).default("partial"),
  attempts: z.array(
    z.object({
      attempt: z.number(),
      durationMs: z.number(),
      violations: z.array(
        z.object({
          code: z.enum([
            "locked_event",
            "time_conflict",
            "travel_time",
            "opening_hours",
            "past_event",
            "duration",
            "place_data",
            "schema",
            "context",
            "change_accounting",
          ]),
          message: z.string(),
          eventId: z.string().optional(),
          conflict: PlanConflictSchema.optional(),
        }),
      ),
    }),
  ),
  context: z.object({
    world: RealWorldContextSchema.optional(),
    profile: UserProfileSchema,
    trip: TripSchema,
    state: TripStateSchema,
    stateSources: StateSourcesSchema,
    activityFacts: z.array(ActivityFactSchema),
    remainingActivityFacts: z.array(ActivityFactSchema),
    protectedActivityFacts: z.array(ActivityFactSchema),
    disruption: ReplanningRequestSchema,
    places: z.array(PlaceSchema),
    travelMinutes: z.record(z.number()),
    impactAnalysis: ImpactAnalysisSchema.optional(),
  }),
  decisionTrace: DecisionTraceSchema.default({
    inputFacts: [],
    decisions: [],
    validationEvidence: [],
  }),
});

export const PendingPlanSchema = z.object({
  result: AgentResultSchema,
  base: SnapshotSchema,
  request: ReplanningRequestSchema,
  accepted: z.boolean(),
  parsedInput: ParsedUserInputSchema.optional(),
  impactAnalysis: ImpactAnalysisSchema.optional(),
});
export const ResolutionStateSchema = z.object({
  currentBlockerKey: z.string().nullable(),
  sameBlockerCount: z.number().int().min(0).max(3),
  roundCount: z.number().int().min(0).max(3),
  answeredFields: z.array(z.string().min(1)).max(30),
  questionHistory: z.array(z.string().min(1)).max(12),
});
export const PendingInputSchema = z.object({
  stage: z.enum(["review", "follow_up"]),
  parsedInput: ParsedUserInputSchema,
  confirmedDraft: ConfirmedDraftSchema,
  missingFact: MissingFactSchema.nullable(),
  questionRawText: z.string().max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE),
  baseRevision: z.number().int().min(0),
});
export const ConditionalAdviceSchema = z.object({
  heading: z.string().min(1),
  suggestions: z.array(z.string().min(1)).min(1).max(30),
  warning: z.string().min(1),
});
export const ActivityFactDraftSchema = ActivityFactSchema.innerType().extend({
  name: z.string().max(160),
}).superRefine((fact, context) => {
  if (fact.commitment === "flexible" && fact.protectionPolicy) {
    context.addIssue({ code: "custom", path: ["protectionPolicy"], message: "弹性安排不能携带保护策略。" });
  }
  if (fact.commitment !== "flexible" && !fact.protectionPolicy) {
    context.addIssue({ code: "custom", path: ["protectionPolicy"], message: "固定或可能固定的安排必须携带保护策略。" });
  }
});
export const ItineraryDraftSchema = z.object({
  baseRevision: z.number().int().min(0),
  profile: UserProfileSchema,
  destination: z.string().max(80),
  currentDate: DateSchema.or(z.literal("")),
  currentTime: TimeSchema.or(z.literal("")),
  currentLocation: z.string().max(100),
  stateCapturedAt: z.string().datetime(),
  currentTimeSource: FactSourceSchema,
  currentLocationSource: FactSourceSchema,
  rawInput: z.string().max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE),
  activityFacts: z.array(ActivityFactDraftSchema).max(30),
  updatedAt: z.string().datetime(),
});
export const RealSessionSchema = z.object({
  schemaVersion: z.literal(4),
  experienceMode: z.literal("real"),
  flowStage: FlowStageSchema,
  snapshot: SnapshotSchema.extend({ mode: z.literal("user") }),
  rawInput: z.string().max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE),
  parsedInput: ParsedUserInputSchema.nullable(),
  lastDisruption: ReplanningRequestSchema.nullable(),
  pendingPlan: PendingPlanSchema.nullable(),
  pendingInput: PendingInputSchema.nullable().default(null),
  conditionalAdvice: ConditionalAdviceSchema.nullable().default(null),
  itineraryDraft: ItineraryDraftSchema.nullable().default(null),
  resolutionState: ResolutionStateSchema,
  updatedAt: z.string().datetime(),
});
export type PendingPlan = z.infer<typeof PendingPlanSchema>;
export type ConditionalAdvice = z.infer<typeof ConditionalAdviceSchema>;
export type ResolutionState = z.infer<typeof ResolutionStateSchema>;
export type ItineraryDraft = z.infer<typeof ItineraryDraftSchema>;
export type ActivityFactDraft = z.infer<typeof ActivityFactDraftSchema>;
export type RealSession = z.infer<typeof RealSessionSchema>;
export * from "./failures";
export * from "./protocol";
