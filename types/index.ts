import { z } from "zod";
import { BrowserLocationSchema, WorldOptionsSchema, RealWorldContextSchema, ResolutionEvidenceSchema, type RealWorldContext } from "./world";

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
  interests: z.array(z.string().max(60)).max(12),
  dislikes: z.array(z.string().max(200)).max(12),
  walkingTolerance: z.enum(["low", "medium", "high"]),
  dailyBudget: z.number().min(0).max(100000).optional(),
  preferences: z.array(z.string().max(300)).max(30),
});
export const TripSchema = z
  .object({
    id: z.string(),
    destination: z.string().min(1).max(80),
    startDate: DateSchema,
    endDate: DateSchema,
  })
  .refine((t) => t.endDate >= t.startDate, "End date must follow start date");
export const TripStateSchema = z.object({
  currentDate: DateSchema,
  currentTime: TimeSchema,
  currentLocation: z.string().max(100),
  browserLocation: BrowserLocationSchema.optional(),
  energyLevel: z.enum(["low", "medium", "high"]).optional(),
  weather: z.enum(["sunny", "rain", "hot"]).optional(),
  remainingBudget: z.number().min(0).max(100000).optional(),
});
export const FactSourceSchema = z.enum(["user", "system", "demo", "unset"]);
export const StateSourcesSchema = z.object({
  currentTime: FactSourceSchema,
  currentLocation: FactSourceSchema,
  weather: FactSourceSchema,
  energyLevel: FactSourceSchema,
  disruption: FactSourceSchema,
});
export const EventSchema = z.object({
  id: z.string().min(1),
  placeId: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  startTime: TimeSchema,
  endTime: TimeSchema,
  durationSource: z.enum(["user", "suggested", "unknown"]).optional(),
  travelMode: z.enum(["DRIVING", "WALKING", "TRANSIT"]).optional(),
  location: z.string(),
  status: z.enum(["completed", "missed", "planned", "locked"]),
  locked: z.boolean(),
  estimatedCost: z.number().min(0),
  estimatedCostKnown: z.boolean().optional(),
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
  estimatedCost: z.number().min(0),
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
export const planAdjustments = [
  "less_walking",
  "cheaper",
  "keep_stop",
  "earlier",
] as const;
export const ReplanningRequestSchema = z.object({
  reason: z.enum(reasons),
  freeText: z.string().max(2000),
  currentState: TripStateSchema,
  closedPlaceIds: z.array(z.string()).max(30),
  variation: z.number().int().min(0).max(100),
  adjustments: z.array(z.enum(planAdjustments)).max(4).optional(),
  stateSources: StateSourcesSchema.optional(),
  worldOptions: WorldOptionsSchema.optional(),
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
  "RESCUE_INPUT",
  "RESCUE_CONFIRM",
  "PLAN_READY",
]);
export const UnifiedIntentSchema = z.enum([
  "create",
  "rescue",
  "mixed",
  "optimize",
]);
export const SemanticActivitySchema = z.object({
  role: z.enum(["existing_plan", "considering", "reference"]),
  name: z.string().max(160),
  startTime: TimeSchema.nullable(),
  endTime: TimeSchema.nullable(),
  durationMinutes: z.number().int().positive().max(1440).nullable(),
  location: z.string().max(100).nullable(),
  estimatedCost: z.number().min(0).max(100000).nullable(),
  locked: z.enum(["yes", "no", "uncertain"]),
  sourceText: z.string().max(500),
});
export const ActivityMentionSchema = SemanticActivitySchema.extend({
  id: z.string().min(1),
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
        kind: z.enum(["keep", "budget", "time", "region"]),
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
    remainingBudget: z.object({
      value: z.number().min(0).max(100000).nullable(),
      sourceText: z.string().max(500).nullable(),
    }),
  }),
  question: z.string().max(500).nullable(),
  ambiguities: z.array(z.string().min(1).max(300)).max(12),
});
export const ParsedPlanItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  startTime: TimeSchema,
  endTime: TimeSchema.nullable(),
  durationMinutes: z.number().int().positive().max(1440).nullable().default(null),
  location: z.string(),
  estimatedCost: z.number().min(0),
  estimatedCostKnown: z.boolean().optional(),
  locked: z.boolean(),
  source: FactSourceSchema,
});
export const ParsedDisruptionSchema = z.object({
  kind: z.enum(reasons),
  label: z.string().min(1),
  source: FactSourceSchema,
});
export const ParsedConstraintSchema = z.object({
  kind: z.enum(["keep", "budget", "time", "region"]),
  value: z.string().min(1),
  source: FactSourceSchema,
});
export const ParsedContextSchema = TripStateSchema.partial().extend({
  currentDate: DateSchema,
  currentTime: TimeSchema,
});
export const ParsedUserInputSchema = z.object({
  rawText: z.string().max(4000),
  intent: UnifiedIntentSchema,
  existingPlans: z.array(ParsedPlanItemSchema).max(30),
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
  activityMentions: z.array(ActivityMentionSchema).max(30).default([]),
  question: z.string().max(500).nullable().optional(),
  resolutionEvidence: ResolutionEvidenceSchema.array().optional(),
  worldOptions: WorldOptionsSchema.optional(),
});
export const ConfirmedPlanItemSchema = ParsedPlanItemSchema.omit({ source: true });
export const ConfirmedPlanItemWithPlaceSchema = ConfirmedPlanItemSchema.extend({
  placeId: z.string().min(1).optional(),
});
export const ConfirmedDraftSchema = z.object({
  rawText: z.string().max(4000),
  intent: UnifiedIntentSchema,
  existingPlans: z.array(ConfirmedPlanItemWithPlaceSchema).max(30),
  activityMentions: z.array(ActivityMentionSchema).max(30).default([]),
  disruptions: z.array(ParsedDisruptionSchema).max(10),
  constraints: z.array(ParsedConstraintSchema).max(30),
  context: ParsedContextSchema,
  contextSources: StateSourcesSchema,
  closedPlaceIds: z.array(z.string()).max(30).default([]),
  question: z.string().max(500).nullable().optional(),
  worldOptions: WorldOptionsSchema.optional(),
  removedLockedIds: z.array(z.string()).max(30).default([]),
  baseRevision: z.number().int().min(0),
});
export const MissingFactSchema = z.object({
  field: z.string().min(1),
  importance: z.enum(["blocking", "optional"]),
  reason: z.string().min(1),
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
  availableTimeWindows: z.array(z.object({
    startTime: TimeSchema,
    endTime: TimeSchema,
    cause: z.string(),
    constraints: z.array(z.string()),
  })),
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
export type Place = z.infer<typeof PlaceSchema>;
export type ReplanningRequest = z.infer<typeof ReplanningRequestSchema>;
export type ProposedPlan = z.infer<typeof ProposedPlanSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type ExperienceMode = z.infer<typeof ExperienceModeSchema>;
export type FlowStage = z.infer<typeof FlowStageSchema>;
export type ParsedUserInput = z.infer<typeof ParsedUserInputSchema>;
export type ConfirmedDraft = z.infer<typeof ConfirmedDraftSchema>;
export type SemanticExtraction = z.infer<typeof SemanticExtractionSchema>;
export type MissingFact = z.infer<typeof MissingFactSchema>;
export type ImpactAnalysis = z.infer<typeof ImpactAnalysisSchema>;
export type AgentContext = {
  world?: RealWorldContext;
  profile: UserProfile;
  trip: Trip;
  state: TripState;
  stateSources: StateSources;
  existingItinerary: ItineraryEvent[];
  lockedEvents: ItineraryEvent[];
  remainingEvents: ItineraryEvent[];
  disruption: ReplanningRequest;
  places: Place[];
  travelMinutes: Record<string, number>;
  impactAnalysis?: ImpactAnalysis;
  unresolvedMentions?: ParsedUserInput["activityMentions"];
  removedLockedIds?: string[];
};
export type Violation = {
  code:
    | "locked_event"
    | "time_conflict"
    | "travel_time"
    | "opening_hours"
    | "budget"
    | "past_event"
    | "duration"
    | "place_data"
    | "schema"
    | "context"
    | "change_accounting";
  message: string;
  eventId?: string;
};
export type Attempt = {
  attempt: number;
  violations: Violation[];
  durationMs: number;
};
export type AgentResult = {
  candidateComparisons?: Array<{title:string;tradeOff:string;feasible:boolean;conflicts:string[]}>;
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
export const AgentResultSchema: z.ZodType<AgentResult> = z.object({
  candidateComparisons:z.array(z.object({title:z.string(),tradeOff:z.string(),feasible:z.boolean(),conflicts:z.array(z.string())})).optional(),
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
            "budget",
            "past_event",
            "duration",
            "place_data",
            "schema",
            "context",
            "change_accounting",
          ]),
          message: z.string(),
          eventId: z.string().optional(),
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
    existingItinerary: z.array(EventSchema),
    lockedEvents: z.array(EventSchema),
    remainingEvents: z.array(EventSchema),
    disruption: ReplanningRequestSchema,
    places: z.array(PlaceSchema),
    travelMinutes: z.record(z.number()),
    impactAnalysis: ImpactAnalysisSchema.optional(),
    unresolvedMentions: z.array(ActivityMentionSchema).optional(),
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
export const RealSessionSchema = z.object({
  schemaVersion: z.literal(2),
  experienceMode: z.literal("real"),
  flowStage: FlowStageSchema,
  snapshot: SnapshotSchema.extend({ mode: z.literal("user") }),
  rawInput: z.string().max(4000),
  parsedInput: ParsedUserInputSchema.nullable(),
  lastDisruption: ReplanningRequestSchema.nullable(),
  pendingPlan: PendingPlanSchema.nullable(),
  updatedAt: z.string().datetime(),
});
export type PendingPlan = z.infer<typeof PendingPlanSchema>;
export type RealSession = z.infer<typeof RealSessionSchema>;
