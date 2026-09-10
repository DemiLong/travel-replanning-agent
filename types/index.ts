import { z } from "zod";

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
  dailyBudget: z.number().min(0).max(100000),
  preferences: z.array(z.string().max(300)).max(30),
});
export const TripSchema = z
  .object({
    id: z.string(),
    destination: z.literal("Bangkok"),
    startDate: DateSchema,
    endDate: DateSchema,
  })
  .refine((t) => t.endDate >= t.startDate, "End date must follow start date");
export const TripStateSchema = z.object({
  currentDate: DateSchema,
  currentTime: TimeSchema,
  currentLocation: z.string().min(1),
  energyLevel: z.enum(["low", "medium", "high"]),
  weather: z.enum(["sunny", "rain", "hot"]),
  remainingBudget: z.number().min(0).max(100000),
});
export const EventSchema = z.object({
  id: z.string().min(1),
  placeId: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  startTime: TimeSchema,
  endTime: TimeSchema,
  location: z.string(),
  status: z.enum(["completed", "missed", "planned", "locked"]),
  locked: z.boolean(),
  estimatedCost: z.number().min(0),
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
  "other",
] as const;
export const ReplanningRequestSchema = z.object({
  reason: z.enum(reasons),
  freeText: z.string().max(2000),
  currentState: TripStateSchema,
  closedPlaceIds: z.array(z.string()).max(30),
  variation: z.number().int().min(0).max(100),
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
  profile: UserProfileSchema,
  trip: TripSchema,
  state: TripStateSchema,
  itinerary: z.array(EventSchema).max(30),
  revision: z.number().int().min(0),
});
export const ReplanInputSchema = z.object({
  snapshot: SnapshotSchema,
  request: ReplanningRequestSchema,
  mode: z.enum(["demo", "live"]),
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
export type ItineraryEvent = z.infer<typeof EventSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type ReplanningRequest = z.infer<typeof ReplanningRequestSchema>;
export type ProposedPlan = z.infer<typeof ProposedPlanSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type AgentContext = {
  profile: UserProfile;
  trip: Trip;
  state: TripState;
  existingItinerary: ItineraryEvent[];
  lockedEvents: ItineraryEvent[];
  remainingEvents: ItineraryEvent[];
  disruption: ReplanningRequest;
  places: Place[];
  travelMinutes: Record<string, number>;
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
  id: string;
  ok: boolean;
  plan: ProposedPlan | null;
  attempts: Attempt[];
  mode: "demo" | "live";
  model: string;
  message: string;
  context: AgentContext;
};
export const AgentResultSchema: z.ZodType<AgentResult> = z.object({
  id: z.string(),
  ok: z.boolean(),
  plan: ProposedPlanSchema.nullable(),
  mode: z.enum(["demo", "live"]),
  model: z.string(),
  message: z.string(),
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
    profile: UserProfileSchema,
    trip: TripSchema,
    state: TripStateSchema,
    existingItinerary: z.array(EventSchema),
    lockedEvents: z.array(EventSchema),
    remainingEvents: z.array(EventSchema),
    disruption: ReplanningRequestSchema,
    places: z.array(PlaceSchema),
    travelMinutes: z.record(z.number()),
  }),
});
