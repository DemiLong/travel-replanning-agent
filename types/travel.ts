import { z } from "zod";

import { BrowserLocationSchema } from "./world";

export const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
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
  .refine(
    (trip) => trip.endDate === trip.startDate,
    "Only same-day trips are supported",
  );

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
  source: z.enum(["confirmed", "possible"]),
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

export type UserProfile = z.infer<typeof UserProfileSchema>;
export type Trip = z.infer<typeof TripSchema>;
export type TripState = z.infer<typeof TripStateSchema>;
export type StateSources = z.infer<typeof StateSourcesSchema>;
export type ItineraryEvent = z.infer<typeof EventSchema>;
export type ProtectionPolicy = z.infer<typeof ProtectionPolicySchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
