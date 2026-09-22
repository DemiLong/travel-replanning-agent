import { SnapshotSchema } from "../types";

/**
 * Creates the neutral starting snapshot used by the real browser session and
 * by tests. It deliberately contains no destination-specific places.
 */
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
      walkingTolerance: "medium",
    },
    trip: {
      id: "test-trip",
      destination: "待确认城市",
      startDate: date,
      endDate: date,
    },
    state: {
      currentDate: date,
      currentTime,
      stateCapturedAt: now.toISOString(),
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
