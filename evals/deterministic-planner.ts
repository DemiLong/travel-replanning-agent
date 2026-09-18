import type { AgentContext, ItineraryEvent, ProposedPlan } from "../types";
import type { Planner } from "../services/openai";
import { minutes, time } from "../lib/time";
import { travelMinutes } from "../services/place-service";

/** Deterministic planner used by offline validator/evaluation tests only. */
export class DeterministicTestPlanner implements Planner {
  name = "deterministic-test-v1";

  async generate(c: AgentContext): Promise<ProposedPlan> {
    const events: ItineraryEvent[] = [...c.lockedEvents.map((e) => ({ ...e }))];
    let cursor = minutes(c.state.currentTime),
      district = c.state.currentLocation,
      previousPlace = "";
    let budget =
      (c.state.remainingBudget ?? Number.POSITIVE_INFINITY) -
      events.reduce((sum, event) => sum + event.estimatedCost, 0);
    const restful =
      c.state.energyLevel === "low" ||
      c.profile.preferences.some((preference) => /rest|休息/i.test(preference));
    const adjustments = c.disruption.adjustments ?? [];
    const lessWalking = adjustments.includes("less_walking");
    const cheaper = adjustments.includes("cheaper");
    const earlier = adjustments.includes("earlier");
    const keepStops = adjustments.includes("keep_stop");
    const maxStops =
      c.profile.travelPace === "packed"
        ? 4
        : c.profile.travelPace === "balanced"
          ? 3
          : 2;
    const candidates = c.places.filter(
      (place) =>
        !c.disruption.closedPlaceIds.includes(place.id) &&
        !events.some((event) => event.placeId === place.id) &&
        !c.existingItinerary.some(
          (event) => event.placeId === place.id && event.status === "completed",
        ),
    );
    const score = (place: (typeof candidates)[number]) => {
      let value =
        c.profile.interests.filter((interest) => place.tags.includes(interest))
          .length * 6;
      if (restful && place.tags.includes("rest")) value += 18;
      if (c.state.weather === "rain" && place.indoorOutdoor === "outdoor")
        value -= 80;
      if (c.state.weather === "hot" && place.indoorOutdoor === "outdoor")
        value -= 30;
      if (
        c.profile.walkingTolerance === "low" &&
        place.indoorOutdoor === "outdoor"
      )
        value -= 12;
      if (lessWalking && place.indoorOutdoor === "outdoor") value -= 45;
      if (cheaper && place.estimatedCost > 350) value -= 25;
      if (place.district === c.state.currentLocation) value += 7;
      if (c.remainingEvents.some((event) => event.placeId === place.id))
        value += keepStops || !restful ? 25 : 0;
      if (
        c.profile.dislikes.some((dislike) =>
          `${place.name} ${place.category} ${place.tags.join(" ")}`
            .toLowerCase()
            .includes(dislike.toLowerCase()),
        )
      )
        value -= 100;
      if (c.disruption.variation % 2 === 1 && place.category === "cafe")
        value += 22;
      return value;
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
        (event) => event.placeId === place.id && !event.locked,
      );
      if (old && minutes(old.startTime) >= start) start = minutes(old.startTime);
      const end = start + place.averageDuration;
      if (end > minutes(place.closingTime) || end > 23 * 60) continue;
      if (earlier && end > 18 * 60) continue;
      const conflicting = events.some(
        (event) =>
          start <
            minutes(event.endTime) + travelMinutes(event.location, place.district) &&
          end + travelMinutes(place.district, event.location) >
            minutes(event.startTime),
      );
      if (conflicting) continue;
      const reason = place.tags.includes("rest")
        ? "先安排一段休息，给后续行程留出体力。"
        : c.state.weather === "rain"
          ? "选择适合当前天气和节奏的室内安排。"
          : "这是符合当前偏好的通用测试安排。";
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
          old && old.startTime === time(start) ? "原定安排仍然合适，所以保留。" : reason,
        constraint: `${restful ? "体力较低 · " : ""}${c.state.weather === "rain" ? "下雨 · " : ""}路程约 ${transit} 分钟${c.state.remainingBudget === undefined ? "" : " · 剩余预算"}`,
      });
      cursor = end;
      district = place.district;
      previousPlace = place.id;
      budget -= place.estimatedCost;
      added++;
    }

    events.sort((a, b) => a.startTime.localeCompare(b.startTime));
    let priorDistrict = c.state.currentLocation;
    let priorPlace = "";
    for (const event of events) {
      event.travelTimeFromPrevious =
        priorPlace === event.placeId
          ? 0
          : travelMinutes(priorDistrict, event.location);
      priorDistrict = event.location;
      priorPlace = event.placeId;
    }

    const movedEvents: ProposedPlan["movedEvents"] = [];
    const removedEvents: ProposedPlan["removedEvents"] = [];
    const tomorrow = new Date(`${c.state.currentDate}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const nextDate = tomorrow.toISOString().slice(0, 10);
    for (const old of c.remainingEvents.filter(
      (event) => !events.some((next) => next.id === event.id),
    )) {
      const change = {
        eventId: old.id,
        name: old.name,
        reason: c.disruption.closedPlaceIds.includes(old.placeId)
          ? "你报告了这里已经关门。"
          : old.startTime < c.state.currentTime
            ? "原定时间已经过去，不必再赶回去。"
            : "减少几项安排，为行程留出余量。",
        constraint: c.disruption.closedPlaceIds.includes(old.placeId)
          ? "已报告关门"
          : old.startTime < c.state.currentTime
            ? "当前时间"
            : "体力 · 路程 · 锁定安排",
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
          note: "这只是暂定建议，请确认明日行程和营业时间。",
        });
      else removedEvents.push(change);
    }

    return {
      summary: restful ? "少一点奔波，多一点从容。" : "留住值得的部分，为变化腾出位置。",
      events,
      movedEvents,
      removedEvents,
      explanation: "测试规划已根据当前状态调整，并通过代码校验。",
    };
  }
}
