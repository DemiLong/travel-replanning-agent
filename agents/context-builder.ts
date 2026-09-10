import { ReplanInputSchema, type AgentContext } from "../types";
import { getPlaces, districts, travelMatrix } from "../services/place-service";
export function buildContext(input: unknown): AgentContext {
  const { snapshot, request } = ReplanInputSchema.parse(input);
  const state = request.currentState;
  if (state.currentDate !== snapshot.state.currentDate)
    throw new Error("Replanning is limited to the current itinerary date.");
  if (
    state.currentDate < snapshot.trip.startDate ||
    state.currentDate > snapshot.trip.endDate
  )
    throw new Error("Current date must be within the trip.");
  if (!districts.includes(state.currentLocation))
    throw new Error("Choose a demo district for your current location.");
  if (
    new Set(snapshot.itinerary.map((e) => e.id)).size !==
    snapshot.itinerary.length
  )
    throw new Error("Duplicate event IDs in itinerary.");
  // Historical events are immutable and never sent back as newly planned activities.
  const remainingEvents = snapshot.itinerary.filter(
    (e) => e.status !== "completed",
  );
  const available = getPlaces(snapshot.trip.destination);
  if (request.closedPlaceIds.some((id) => !available.some((p) => p.id === id)))
    throw new Error("Unknown closed place.");
  return {
    profile: snapshot.profile,
    trip: snapshot.trip,
    state,
    existingItinerary: snapshot.itinerary,
    lockedEvents: remainingEvents.filter((e) => e.locked),
    remainingEvents,
    disruption: request,
    places: available,
    travelMinutes: travelMatrix(),
  };
}
