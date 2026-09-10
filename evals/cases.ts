import { demo, event } from "../data/demo";
import type { Snapshot, ReplanningRequest, Violation } from "../types";
export type EvalCase = {
  id: string;
  name: string;
  snapshot: Snapshot;
  disruption: ReplanningRequest;
  expected: {
    feasible: boolean;
    lockedIds: string[];
    maxBudget: number;
    forbiddenPlaceIds: string[];
    hardConstraints: string[];
  };
};
const states = ["15:00", "16:00", "17:00", "18:00", "18:30"];
const budgets = [650, 800, 1000, 1750];
export const cases: EvalCase[] = Array.from({ length: 32 }, (_, i) => {
  const snapshot = structuredClone(demo);
  snapshot.state.currentTime = states[i % 5];
  snapshot.state.weather = (["rain", "sunny", "hot"] as const)[i % 3];
  snapshot.state.energyLevel = (["low", "medium", "high"] as const)[
    Math.floor(i / 3) % 3
  ];
  snapshot.state.remainingBudget = budgets[Math.floor(i / 5) % 4];
  snapshot.profile.travelPace = (["relaxed", "balanced", "packed"] as const)[
    i % 3
  ];
  snapshot.profile.walkingTolerance = (["low", "medium", "high"] as const)[
    Math.floor(i / 4) % 3
  ];
  snapshot.profile.interests =
    i % 2 ? ["museums", "culture"] : ["coffee", "food"];
  let feasible = true;
  let name = `${snapshot.state.currentTime} / ${snapshot.state.weather} / ฿${snapshot.state.remainingBudget}`;
  let closedPlaceIds: string[] = [];
  if (i === 24) {
    snapshot.state.remainingBudget = 400;
    feasible = false;
    name = "Budget below locked dinner cost";
  }
  if (i === 25) {
    snapshot.state.currentTime = "19:15";
    feasible = false;
    name = "Locked dinner starts in the past";
  }
  if (i === 26) {
    snapshot.state.currentTime = "18:45";
    snapshot.state.currentLocation = "Ari";
    feasible = false;
    name = "Cannot reach locked dinner in time";
  }
  if (i === 27) {
    closedPlaceIds = ["dinner"];
    feasible = false;
    name = "Locked restaurant reported closed";
  }
  if (i === 28) {
    snapshot.itinerary.push(
      event("tea", "second-lock", "19:15", "20:00", "locked", true),
    );
    feasible = false;
    name = "Two locked events overlap";
  }
  if (i === 29) {
    snapshot.trip.endDate = snapshot.state.currentDate;
    name = "Last trip day: no future move";
  }
  if (i === 30) {
    closedPlaceIds = ["massage", "cafe"];
    name = "Favourite indoor venues closed";
  }
  if (i === 31) {
    snapshot.profile.preferences = ["I like plans with more resting time."];
    name = "Explicit rest preference";
  }
  return {
    id: `case-${String(i + 1).padStart(2, "0")}`,
    name,
    snapshot,
    disruption: {
      reason: closedPlaceIds.length ? "closed" : "tired",
      freeText: "Plans changed. Adapt to my selected state.",
      currentState: snapshot.state,
      closedPlaceIds,
      variation: i % 2,
    },
    expected: {
      feasible,
      lockedIds: snapshot.itinerary.filter((e) => e.locked).map((e) => e.id),
      maxBudget: snapshot.state.remainingBudget,
      forbiddenPlaceIds: closedPlaceIds,
      hardConstraints: [
        "locked_event",
        "time_conflict",
        "travel_time",
        "opening_hours",
        "budget",
        "past_event",
        "duration",
      ],
    },
  };
});
export const violationCodes: Violation["code"][] = [
  "locked_event",
  "time_conflict",
  "opening_hours",
  "budget",
  "travel_time",
  "past_event",
  "duration",
  "place_data",
  "schema",
  "change_accounting",
];
