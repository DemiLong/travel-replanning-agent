import type { AgentContext, ProposedPlan, ItineraryEvent } from "../types";
import type { Planner } from "../services/openai";
import { minutes, time } from "../lib/time";
import { travelMinutes } from "../services/place-service";
export class DemoPlanner implements Planner {
  name = "deterministic-demo-v1";
  async generate(c: AgentContext): Promise<ProposedPlan> {
    const events: ItineraryEvent[] = [...c.lockedEvents.map((e) => ({ ...e }))];
    let cursor = minutes(c.state.currentTime),
      district = c.state.currentLocation,
      previousPlace = "";
    let budget =
      c.state.remainingBudget - events.reduce((s, e) => s + e.estimatedCost, 0);
    const restful =
      c.state.energyLevel === "low" ||
      c.profile.preferences.some((p) => /rest|休息/i.test(p));
    const maxStops =
      c.profile.travelPace === "packed"
        ? 4
        : c.profile.travelPace === "balanced"
          ? 3
          : 2;
    const candidates = c.places.filter(
      (p) =>
        !c.disruption.closedPlaceIds.includes(p.id) &&
        !events.some((e) => e.placeId === p.id) &&
        !c.existingItinerary.some(
          (e) => e.placeId === p.id && e.status === "completed",
        ),
    );
    const score = (p: (typeof candidates)[number]) => {
      let n = c.profile.interests.filter((i) => p.tags.includes(i)).length * 6;
      if (restful && p.tags.includes("rest")) n += 18;
      if (c.state.weather === "rain" && p.indoorOutdoor === "outdoor") n -= 80;
      if (c.state.weather === "hot" && p.indoorOutdoor === "outdoor") n -= 30;
      if (c.profile.walkingTolerance === "low" && p.indoorOutdoor === "outdoor")
        n -= 12;
      if (p.district === c.state.currentLocation) n += 7;
      if (c.remainingEvents.some((e) => e.placeId === p.id) && !restful)
        n += 25;
      if (
        c.profile.dislikes.some((d) =>
          `${p.name} ${p.category} ${p.tags.join(" ")}`
            .toLowerCase()
            .includes(d.toLowerCase()),
        )
      )
        n -= 100;
      if (c.disruption.variation % 2 === 1 && p.category === "cafe") n += 22;
      return n;
    };
    candidates.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    let added = 0;
    for (const place of candidates) {
      if (added >= maxStops || score(place) < 0 || place.estimatedCost > budget)
        continue;
      const transit =
        previousPlace === place.id
          ? 0
          : travelMinutes(district, place.district);
      let start = Math.max(cursor + transit, minutes(place.openingTime));
      const old = c.remainingEvents.find(
        (e) => e.placeId === place.id && !e.locked,
      );
      if (old && minutes(old.startTime) >= start)
        start = minutes(old.startTime);
      const end = start + place.averageDuration;
      if (end > minutes(place.closingTime) || end > 23 * 60) continue;
      const conflicting = events.some(
        (e) =>
          start <
            minutes(e.endTime) + travelMinutes(e.location, place.district) &&
          end + travelMinutes(place.district, e.location) >
            minutes(e.startTime),
      );
      if (conflicting) continue;
      const why = place.tags.includes("rest")
        ? "A proper pause gives you time to recharge before dinner."
        : c.state.weather === "rain"
          ? "Stay indoors and enjoy a smaller, rain-friendly stop."
          : "A nearby stop matched to your interests, with time to enjoy it.";
      events.push({
        id: old?.id ?? `new-${place.id}`,
        placeId: place.id,
        name: place.name,
        category: place.category,
        startTime: time(start),
        endTime: time(end),
        location: place.district,
        status: "planned",
        locked: false,
        estimatedCost: place.estimatedCost,
        indoorOutdoor: place.indoorOutdoor,
        openingTime: place.openingTime,
        closingTime: place.closingTime,
        travelTimeFromPrevious: transit,
        reason:
          old && old.startTime === time(start)
            ? "This original stop still fits, so it stays."
            : why,
        constraint: `${restful ? "Low energy · " : ""}${c.state.weather === "rain" ? "Rain · " : ""}${transit} min transfer · Remaining budget`,
      });
      cursor = end;
      district = place.district;
      previousPlace = place.id;
      budget -= place.estimatedCost;
      added++;
    }
    events.sort((a, b) => a.startTime.localeCompare(b.startTime));
    let priorDistrict = c.state.currentLocation,
      priorPlace = "";
    for (const e of events) {
      e.travelTimeFromPrevious =
        priorPlace === e.placeId ? 0 : travelMinutes(priorDistrict, e.location);
      priorDistrict = e.location;
      priorPlace = e.placeId;
    }
    const movedEvents: ProposedPlan["movedEvents"] = [],
      removedEvents: ProposedPlan["removedEvents"] = [];
    const tomorrow = new Date(`${c.state.currentDate}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const nextDate = tomorrow.toISOString().slice(0, 10);
    for (const old of c.remainingEvents.filter(
      (e) => !events.some((n) => n.id === e.id),
    )) {
      const change = {
        eventId: old.id,
        name: old.name,
        reason: c.disruption.closedPlaceIds.includes(old.placeId)
          ? "You reported this place closed."
          : old.startTime < c.state.currentTime
            ? "This original slot has passed; there is no need to rush back."
            : `Fewer stops leave more breathing room while keeping your reservation.`,
        constraint: c.disruption.closedPlaceIds.includes(old.placeId)
          ? "Reported closure"
          : old.startTime < c.state.currentTime
            ? "Current time"
            : "Energy · Travel time · Locked dinner",
      };
      if (
        old.category === "temple" &&
        nextDate <= c.trip.endDate &&
        !c.disruption.closedPlaceIds.includes(old.placeId)
      )
        movedEvents.push({
          ...change,
          suggestedDate: nextDate,
          suggestedStart: "09:00",
          note: "Tentative suggestion only. Check tomorrow’s itinerary and opening hours; not scheduled automatically.",
        });
      else removedEvents.push(change);
    }
    return {
      summary: restful
        ? "A little less rush. A little more you."
        : "Keep the good parts. Make room for a change.",
      events,
      movedEvents,
      removedEvents,
      explanation:
        "Your remaining day has been adjusted around your current state. Transfers and your locked reservation are protected. Move suggestions are tentative, not bookings.",
    };
  }
}
