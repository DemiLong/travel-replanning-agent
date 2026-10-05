import { z } from "zod";

import {
  ActivityFactSchema,
  DecisionTraceSchema,
  ProposedPlanSchema,
  ReplanningRequestSchema,
  type ActivityFact,
  type ProposedPlan,
  type ReplanningRequest,
} from "./activity";
import {
  ImpactAnalysisSchema,
  PlanConflictSchema,
  ResolutionOptionSchema,
  type ImpactAnalysis,
  type PlanConflict,
  type ResolutionOption,
} from "./workflow";
import {
  PlaceSchema,
  StateSourcesSchema,
  TripSchema,
  TripStateSchema,
  UserProfileSchema,
  type Place,
  type StateSources,
  type Trip,
  type TripState,
  type UserProfile,
} from "./travel";
import { RealWorldContextSchema, type RealWorldContext } from "./world";

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
  candidateComparisons?: Array<{
    title: string;
    tradeOff: string;
    feasible: boolean;
    conflicts: string[];
  }>;
  candidatePlans?: Array<{
    id: string;
    title: string;
    tradeOff: string;
    feasible: boolean;
    plan: ProposedPlan | null;
    conflicts: PlanConflict[];
  }>;
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

export const AgentResultSchema: z.ZodType<AgentResult, z.ZodTypeDef, unknown> =
  z.object({
    candidateComparisons: z
      .array(
        z.object({
          title: z.string(),
          tradeOff: z.string(),
          feasible: z.boolean(),
          conflicts: z.array(z.string()),
        }),
      )
      .optional(),
    candidatePlans: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          tradeOff: z.string(),
          feasible: z.boolean(),
          plan: ProposedPlanSchema.nullable(),
          conflicts: z.array(PlanConflictSchema),
        }),
      )
      .optional(),
    conflicts: z.array(PlanConflictSchema).optional(),
    resolutionOptions: z.array(ResolutionOptionSchema).optional(),
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
