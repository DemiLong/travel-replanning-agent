import {
  ProposedPlanSchema,
  type AgentContext,
  type ProposedPlan,
  type Violation,
} from "../types";
import { lockedEventValidator } from "./locked-event-validator";
import { timeConflictValidator } from "./time-conflict-validator";
import { travelTimeValidator } from "./travel-time-validator";
import { openingHoursValidator } from "./opening-hours-validator";
import { budgetValidator } from "./budget-validator";
import { pastEventValidator } from "./past-event-validator";
export const validators = [
  lockedEventValidator,
  timeConflictValidator,
  travelTimeValidator,
  openingHoursValidator,
  budgetValidator,
  pastEventValidator,
];
export function validatePlan(c: AgentContext, candidate: unknown): Violation[] {
  const parsed = ProposedPlanSchema.safeParse(candidate);
  if (!parsed.success)
    return [
      {
        code: "schema",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
          .slice(0, 1500),
      },
    ];
  const p = parsed.data,
    errors = validators.flatMap((v) => v(c, p));
  const ids = new Set<string>();
  for (const e of p.events) {
    if (ids.has(e.id))
      errors.push({
        code: "schema",
        eventId: e.id,
        message: "Duplicate event ID.",
      });
    ids.add(e.id);
    if (e.locked !== (e.status === "locked"))
      errors.push({
        code: "locked_event",
        eventId: e.id,
        message: "Lock status and locked flag must agree.",
      });
    if (e.endTime <= e.startTime)
      errors.push({
        code: "duration",
        eventId: e.id,
        message: "End time must be after start time.",
      });
    if (
      !["planned", "locked"].includes(e.status) ||
      c.existingItinerary.some(
        (old) => old.id === e.id && old.status === "completed",
      )
    )
      errors.push({
        code: "past_event",
        eventId: e.id,
        message:
          "Candidate must contain only remaining activities, never completed history.",
      });
    const old = c.existingItinerary.find((old) => old.id === e.id);
    if (old && old.placeId !== e.placeId)
      errors.push({
        code: "place_data",
        eventId: e.id,
        message:
          "An original event ID cannot be reassigned to a different place.",
      });
    if (e.locked && !c.lockedEvents.some((old) => old.id === e.id))
      errors.push({
        code: "locked_event",
        eventId: e.id,
        message: "Do not create new locks without user authorization.",
      });
    const place = c.places.find((place) => place.id === e.placeId);
    if (
      !place ||
      e.name !== place.name ||
      e.location !== place.district ||
      e.category !== place.category ||
      e.estimatedCost !== place.estimatedCost ||
      e.indoorOutdoor !== place.indoorOutdoor ||
      e.openingTime !== place.openingTime ||
      e.closingTime !== place.closingTime
    )
      errors.push({
        code: "place_data",
        eventId: e.id,
        message:
          "Use canonical place identity, district, cost, hours and indoor/outdoor metadata.",
      });
  }
  const changes = [...p.movedEvents, ...p.removedEvents];
  for (const old of c.remainingEvents) {
    const count =
      Number(ids.has(old.id)) +
      changes.filter((x) => x.eventId === old.id).length;
    if (count !== 1)
      errors.push({
        code: "change_accounting",
        eventId: old.id,
        message:
          "Retain the original event or explain its removal/move exactly once.",
      });
  }
  for (const change of changes)
    if (
      !c.remainingEvents.some(
        (e) => e.id === change.eventId && e.name === change.name,
      )
    )
      errors.push({
        code: "change_accounting",
        message: "Changes must refer to known remaining events.",
      });
  for (const moved of p.movedEvents) {
    const old = c.remainingEvents.find((e) => e.id === moved.eventId);
    const place = c.places.find((p) => p.id === old?.placeId);
    if (
      moved.suggestedDate <= c.state.currentDate ||
      moved.suggestedDate > c.trip.endDate ||
      !place ||
      moved.suggestedStart < place.openingTime ||
      moved.suggestedStart >= place.closingTime
    )
      errors.push({
        code: "change_accounting",
        eventId: moved.eventId,
        message:
          "Move suggestions must fall on a future trip date during opening hours.",
      });
  }
  return errors;
}
