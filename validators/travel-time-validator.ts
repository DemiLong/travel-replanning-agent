import type { AgentContext, ProposedPlan, Violation } from "../types";
import { minutes } from "../lib/time";
import { travelMinutes } from "../services/place-service";
export function travelTimeValidator(
  c: AgentContext,
  p: ProposedPlan,
): Violation[] {
  let previousEnd = minutes(c.state.currentTime),
    previousLocation = c.state.currentLocation,
    previousPlace = "";
  const errors: Violation[] = [];
  for (const e of [...p.events].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  )) {
    const place = c.places.find((p) => p.id === e.placeId);
    if (!place) continue;
    const required =
      previousPlace === e.placeId
        ? 0
        : travelMinutes(previousLocation, place.district);
    if (previousEnd + required > minutes(e.startTime))
      errors.push({
        code: "travel_time",
        eventId: e.id,
        message: `Allow ${required} min from ${previousLocation} to ${place.district} before ${e.name}.`,
      });
    previousEnd = minutes(e.endTime);
    previousLocation = place.district;
    previousPlace = e.placeId;
  }
  return errors;
}
