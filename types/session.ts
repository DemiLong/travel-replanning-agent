import { z } from "zod";

import { ActivityFactSchema, ReplanningRequestSchema } from "./activity";
import { AgentResultSchema } from "./agent";
import { MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE } from "./protocol";
import {
  DateSchema,
  FactSourceSchema,
  SnapshotSchema,
  TimeSchema,
  UserProfileSchema,
} from "./travel";
import {
  ConfirmedDraftSchema,
  FlowStageSchema,
  ImpactAnalysisSchema,
  MissingFactSchema,
  ParsedUserInputSchema,
} from "./workflow";

export const PendingPlanSchema = z.object({
  result: AgentResultSchema,
  base: SnapshotSchema,
  request: ReplanningRequestSchema,
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
  parsedInput: ParsedUserInputSchema,
  confirmedDraft: ConfirmedDraftSchema,
  missingFact: MissingFactSchema.nullable(),
  questionRawText: z
    .string()
    .max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE),
  baseRevision: z.number().int().min(0),
});

export const ConditionalAdviceSchema = z.object({
  heading: z.string().min(1),
  suggestions: z.array(z.string().min(1)).min(1).max(30),
  warning: z.string().min(1),
});

export const ActivityFactDraftSchema = ActivityFactSchema.innerType()
  .extend({
    name: z.string().max(160),
  })
  .superRefine((fact, context) => {
    if (fact.commitment === "flexible" && fact.protectionPolicy) {
      context.addIssue({
        code: "custom",
        path: ["protectionPolicy"],
        message: "弹性安排不能携带保护策略。",
      });
    }
    if (fact.commitment !== "flexible" && !fact.protectionPolicy) {
      context.addIssue({
        code: "custom",
        path: ["protectionPolicy"],
        message: "固定或可能固定的安排必须携带保护策略。",
      });
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
  schemaVersion: z.literal(5),
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
