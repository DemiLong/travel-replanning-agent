import { ReplanInputSchema, type AgentContext } from "../types";
import {
  getPlaces,
  itineraryPlaces,
  travelMatrix,
} from "../services/place-service";
export function buildContext(input: unknown): AgentContext {
  const { snapshot, request, mode, confirmation } =
    ReplanInputSchema.parse(input);
  if (mode === "local" && confirmation?.status !== "confirmed")
    throw new Error("请先确认系统对行程和变化的理解。");
  if (mode === "local" && !snapshot.itinerary.length)
    throw new Error("请先确认至少一项今天已有的安排。");
  if (mode === "local" && !request.currentState.currentLocation.trim())
    throw new Error("请先确认当前地点。");
  const state = request.currentState;
  if (state.currentDate !== snapshot.state.currentDate)
    throw new Error("重新规划只能针对当前行程日期。");
  if (
    state.currentDate < snapshot.trip.startDate ||
    state.currentDate > snapshot.trip.endDate
  )
    throw new Error("当前日期必须在旅行日期范围内。");
  if (
    new Set(snapshot.itinerary.map((e) => e.id)).size !==
    snapshot.itinerary.length
  )
    throw new Error("行程中存在重复的安排 ID。");
  // Historical events are immutable and never sent back as newly planned activities.
  const remainingEvents = snapshot.itinerary.filter(
    (e) => e.status !== "completed",
  );
  const catalog = getPlaces(snapshot.trip.destination);
  const available = [
    ...catalog,
    ...itineraryPlaces(snapshot.itinerary).filter(
      (item) => !catalog.some((place) => place.id === item.id),
    ),
  ];
  if (request.closedPlaceIds.some((id) => !available.some((p) => p.id === id)))
    throw new Error("发现了未知的关门地点。");
  return {
    profile: snapshot.profile,
    trip: snapshot.trip,
    state,
    stateSources: request.stateSources ?? snapshot.stateSources,
    existingItinerary: snapshot.itinerary,
    lockedEvents: remainingEvents.filter((e) => e.locked),
    remainingEvents,
    disruption: request,
    places: available,
    travelMinutes: travelMatrix([
      ...new Set([state.currentLocation, ...available.map((p) => p.district)]),
    ]),
  };
}
