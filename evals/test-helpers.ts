import { SnapshotSchema, type ItineraryEvent, type Snapshot } from "../types";
import { createStarterSnapshot } from "../data/session-defaults";

type EventOverrides = Partial<
  Pick<
    ItineraryEvent,
    | "name"
    | "category"
    | "location"
    | "estimatedCost"
    | "indoorOutdoor"
    | "openingTime"
    | "closingTime"
    | "reason"
    | "constraint"
  >
>;

const eventDefaults: Record<
  string,
  Pick<
    ItineraryEvent,
    | "name"
    | "category"
    | "location"
    | "estimatedCost"
    | "indoorOutdoor"
    | "openingTime"
    | "closingTime"
  >
> = {
  museum: {
    name: "城市博物馆",
    category: "museum",
    location: "历史街区",
    estimatedCost: 500,
    indoorOutdoor: "mixed",
    openingTime: "08:30",
    closingTime: "18:00",
  },
  lunch: {
    name: "城市午餐点",
    category: "restaurant",
    location: "城市中心",
    estimatedCost: 250,
    indoorOutdoor: "indoor",
    openingTime: "10:00",
    closingTime: "21:00",
  },
  "riverside-gallery": {
    name: "河畔文化馆",
    category: "museum",
    location: "河畔区域",
    estimatedCost: 200,
    indoorOutdoor: "mixed",
    openingTime: "08:00",
    closingTime: "18:00",
  },
  "shopping-center": {
    name: "室内商业中心",
    category: "shopping mall",
    location: "河畔区域",
    estimatedCost: 300,
    indoorOutdoor: "indoor",
    openingTime: "10:00",
    closingTime: "22:00",
  },
  dinner: {
    name: "预约晚餐",
    category: "restaurant",
    location: "城市中心",
    estimatedCost: 650,
    indoorOutdoor: "indoor",
    openingTime: "17:00",
    closingTime: "22:00",
  },
  "history-museum": {
    name: "城市历史馆",
    category: "museum",
    location: "历史街区",
    estimatedCost: 200,
    indoorOutdoor: "indoor",
    openingTime: "09:00",
    closingTime: "16:00",
  },
  "nature-center": {
    name: "室内自然馆",
    category: "indoor attraction",
    location: "城市中心",
    estimatedCost: 1200,
    indoorOutdoor: "indoor",
    openingTime: "10:00",
    closingTime: "20:00",
  },
};

export function event(
  placeId: string,
  id: string,
  startTime: string,
  endTime: string,
  status: ItineraryEvent["status"] = "planned",
  locked = false,
  overrides: EventOverrides = {},
): ItineraryEvent {
  const defaults = eventDefaults[placeId];
  return {
    id,
    placeId,
    name: overrides.name ?? defaults?.name ?? `测试地点 ${placeId}`,
    category: overrides.category ?? defaults?.category ?? "test venue",
    startTime,
    endTime,
    status,
    locked,
    location: overrides.location ?? defaults?.location ?? "测试区域",
    estimatedCost: overrides.estimatedCost ?? defaults?.estimatedCost ?? 100,
    indoorOutdoor: overrides.indoorOutdoor ?? defaults?.indoorOutdoor ?? "mixed",
    openingTime: overrides.openingTime ?? defaults?.openingTime ?? "08:00",
    closingTime: overrides.closingTime ?? defaults?.closingTime ?? "22:00",
    travelTimeFromPrevious: null,
    reason: overrides.reason ?? "测试行程中的通用安排。",
    constraint: overrides.constraint ?? (locked ? "固定安排" : "原计划"),
  };
}

/** A generic legacy payload used only to verify old demo data is isolated. */
export function createLegacyDemoSnapshot(): Snapshot {
  const snapshot = createStarterSnapshot();
  return SnapshotSchema.parse({
    ...snapshot,
    mode: "demo",
    trip: { ...snapshot.trip, id: "legacy-demo" },
    state: { ...snapshot.state, currentLocation: "测试区域" },
    stateSources: {
      ...snapshot.stateSources,
      currentTime: "demo",
      currentLocation: "demo",
      energyLevel: "demo",
      weather: "demo",
      disruption: "demo",
    },
    itinerary: [
      event("museum", "legacy-museum", "10:00", "11:30", "planned"),
      event("dinner", "legacy-dinner", "19:00", "20:00", "locked", true),
    ],
  });
}

export function createDeterministicTestSnapshot(): Snapshot {
  const snapshot = createStarterSnapshot();
  snapshot.profile.travelPace = "relaxed";
  snapshot.profile.interests = ["coffee", "food", "culture"];
  snapshot.profile.dislikes = ["packed schedules"];
  snapshot.profile.walkingTolerance = "low";
  snapshot.trip.destination = "测试城市";
  snapshot.state.currentTime = "15:00";
  snapshot.state.currentLocation = "城市中心";
  snapshot.state.energyLevel = "low";
  snapshot.state.weather = "rain";
  snapshot.state.remainingBudget = 1750;
  snapshot.stateSources.currentTime = "user";
  snapshot.stateSources.currentLocation = "user";
  snapshot.itinerary = [
    event("museum", "e-museum", "09:00", "11:00", "completed"),
    event("lunch", "e-lunch", "12:00", "13:00", "completed"),
    event("riverside-gallery", "e-riverside", "14:00", "15:30", "missed"),
    event("shopping-center", "e-shopping", "17:00", "18:00"),
    event("dinner", "e-dinner", "19:00", "20:30", "locked", true),
  ];
  return SnapshotSchema.parse(snapshot);
}
