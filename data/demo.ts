import { places } from "./places";
import { SnapshotSchema, type ItineraryEvent } from "../types";
export function event(
  placeId: string,
  id: string,
  startTime: string,
  endTime: string,
  status: ItineraryEvent["status"] = "planned",
  locked = false,
): ItineraryEvent {
  const p = places.find((p) => p.id === placeId)!;
  return {
    id,
    placeId,
    name: p.name,
    category: p.category,
    startTime,
    endTime,
    status,
    locked,
    location: p.district,
    estimatedCost: p.estimatedCost,
    indoorOutdoor: p.indoorOutdoor,
    openingTime: p.openingTime,
    closingTime: p.closingTime,
    travelTimeFromPrevious: null,
    reason: locked ? "你的预约会保持原位。" : "你原定行程的一部分。",
    constraint: locked ? "Locked reservation" : "Original itinerary",
  };
}
export const demo = SnapshotSchema.parse({
  mode: "demo",
  profile: {
    id: "demo-traveler",
    travelPace: "relaxed",
    interests: ["coffee", "food", "local neighborhoods"],
    dislikes: ["packed schedules"],
    walkingTolerance: "low",
    dailyBudget: 2500,
    preferences: [],
  },
  trip: {
    id: "bangkok-demo",
    destination: "Bangkok",
    startDate: "2026-09-10",
    endDate: "2026-09-13",
  },
  state: {
    currentDate: "2026-09-10",
    currentTime: "15:00",
    currentLocation: "Siam",
    energyLevel: "low",
    weather: "rain",
    remainingBudget: 1750,
  },
  stateSources: {
    currentTime: "demo",
    currentLocation: "demo",
    energyLevel: "demo",
    weather: "demo",
    disruption: "demo",
  },
  itinerary: [
    event("palace", "e-palace", "09:00", "11:00", "completed"),
    event("lunch", "e-lunch", "12:00", "13:00", "completed"),
    event("wat-arun", "e-wat", "14:00", "15:30", "missed"),
    event("iconsiam", "e-mall", "17:00", "18:00"),
    event("dinner", "e-dinner", "19:00", "20:30", "locked", true),
  ],
  revision: 0,
});

export function createStarterSnapshot() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return SnapshotSchema.parse({
    mode: "user",
    profile: {
      id: "local-traveler",
      travelPace: "balanced",
      interests: [],
      dislikes: [],
      walkingTolerance: "medium",
      preferences: [],
    },
    trip: {
      id: "thailand-trip",
      destination: "Bangkok",
      startDate: date,
      endDate: date,
    },
    state: {
      currentDate: date,
      currentTime,
      currentLocation: "",
    },
    stateSources: {
      currentTime: "system",
      currentLocation: "unset",
      energyLevel: "unset",
      weather: "unset",
      disruption: "unset",
    },
    itinerary: [],
    revision: 0,
  });
}
