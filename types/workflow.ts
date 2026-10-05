import { z } from "zod";

import {
  ActivityFactSchema,
  reasons,
  ReplanningRequestSchema,
} from "./activity";
import { MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE } from "./protocol";
import {
  DateSchema,
  FactSourceSchema,
  SnapshotSchema,
  StateSourcesSchema,
  TimeSchema,
  TripStateSchema,
} from "./travel";
import { ResolutionEvidenceSchema, WorldOptionsSchema } from "./world";

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
  progress: z
    .enum(["not_started", "missed", "ongoing", "completed"])
    .default("not_started"),
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
  answerType: z.enum([
    "text",
    "time",
    "poi",
    "browser_location",
    "event_selection",
  ]),
  candidates: z
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .max(10)
    .optional(),
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
  activityWeatherJudgments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        exposure: z.enum(["outdoor", "indoor", "unknown"]),
        evidence: z.string(),
        affected: z.boolean(),
      }),
    )
    .default([]),
  availableTimeWindows: z.array(
    z.object({
      startTime: TimeSchema,
      endTime: TimeSchema,
      cause: z.string(),
      constraints: z.array(z.string()),
    }),
  ),
});

export const PlanConflictSchema = z.object({
  kind: z.enum([
    "unknown_duration_window",
    "locked_schedule_conflict",
    "time_conflict",
    "travel_time",
    "other",
  ]),
  eventId: z.string().min(1),
  nextAnchorEventId: z.string().min(1).optional(),
  availableMinutes: z.number().int().optional(),
  requiredTransferMinutes: z.number().int().nonnegative().optional(),
  message: z.string().min(1),
});

export const ResolutionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  action: z.enum([
    "remove_event",
    "shorten_unknown_duration",
    "edit_locked_arrangement",
  ]),
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

export type ExperienceMode = z.infer<typeof ExperienceModeSchema>;
export type FlowStage = z.infer<typeof FlowStageSchema>;
export type ParsedUserInput = z.infer<typeof ParsedUserInputSchema>;
export type ConfirmedDraft = z.infer<typeof ConfirmedDraftSchema>;
export type SemanticExtraction = z.infer<typeof SemanticExtractionSchema>;
export type MissingFact = z.infer<typeof MissingFactSchema>;
export type ImpactAnalysis = z.infer<typeof ImpactAnalysisSchema>;
export type PlanConflict = z.infer<typeof PlanConflictSchema>;
export type ResolutionOption = z.infer<typeof ResolutionOptionSchema>;
