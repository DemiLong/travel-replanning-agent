import { z } from "zod";

import { MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE } from "./protocol";
import {
  DateSchema,
  EventSchema,
  FactSourceSchema,
  ProtectionPolicySchema,
  StateSourcesSchema,
  TimeSchema,
  TripStateSchema,
} from "./travel";
import { WorldOptionsSchema } from "./world";

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

export const ActivityFactSchema = z
  .object({
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

export const ReplanningRequestSchema = z.object({
  reason: z.enum(reasons),
  freeText: z.string().max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE),
  currentState: TripStateSchema,
  closedPlaceIds: z.array(z.string()).max(30),
  variation: z.number().int().min(0).max(100),
  stateSources: StateSourcesSchema.optional(),
  worldOptions: WorldOptionsSchema.optional(),
  activityFacts: z.array(ActivityFactSchema).max(30),
  confirmedDraftChanges: z
    .object({ removedLockedIds: z.array(z.string()).max(30) })
    .optional(),
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

export type ActivityFact = z.infer<typeof ActivityFactSchema>;
export type ReplanningRequest = z.infer<typeof ReplanningRequestSchema>;
export type ProposedPlan = z.infer<typeof ProposedPlanSchema>;
