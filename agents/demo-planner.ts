import type { AgentContext, ProposedPlan, ItineraryEvent } from "../types";
import type { Planner } from "../services/openai";
import { minutes, time } from "../lib/time";
import { travelMinutes } from "../services/place-service";
export class DemoPlanner implements Planner {
  name = "deterministic-local-v1";
  async generate(c: AgentContext): Promise<ProposedPlan> {
    const events: ItineraryEvent[] = [...c.lockedEvents.map((e) => ({ ...e }))];
    let cursor = minutes(c.state.currentTime),
      district = c.state.currentLocation,
      previousPlace = "";
    let budget =
      (c.state.remainingBudget ?? Number.POSITIVE_INFINITY) -
      events.reduce((s, e) => s + e.estimatedCost, 0);
    const restful =
      c.state.energyLevel === "low" ||
      c.profile.preferences.some((p) => /rest|休息/i.test(p));
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
      if (lessWalking && p.indoorOutdoor === "outdoor") n -= 45;
      if (cheaper && p.estimatedCost > 350) n -= 25;
      if (p.district === c.state.currentLocation) n += 7;
      if (c.remainingEvents.some((e) => e.placeId === p.id))
        n += keepStops || !restful ? 25 : 0;
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
      if (earlier && end > 18 * 60) continue;
      const conflicting = events.some(
        (e) =>
          start <
            minutes(e.endTime) + travelMinutes(e.location, place.district) &&
          end + travelMinutes(place.district, e.location) >
            minutes(e.startTime),
      );
      if (conflicting) continue;
      const why = place.tags.includes("rest")
        ? "先好好歇一会儿，晚餐前把体力养回来。"
        : c.state.weather === "rain"
          ? "留在室内，选一处适合雨天、节奏更从容的安排。"
          : "附近有一处符合你兴趣的去处，留出时间慢慢享受。";
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
            ? "原定安排仍然合适，所以保留。"
            : why,
        constraint: `${restful ? "体力较低 · " : ""}${c.state.weather === "rain" ? "下雨 · " : ""}路程约 ${transit} 分钟${c.state.remainingBudget === undefined ? "" : " · 剩余预算"}`,
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
          ? "你报告了这里已经关门。"
          : old.startTime < c.state.currentTime
            ? "原定时间已经过去，不必再赶回去。"
            : "减少几项安排，给旅程留出呼吸空间，同时保留你的预约。",
        constraint: c.disruption.closedPlaceIds.includes(old.placeId)
          ? "已报告关门"
          : old.startTime < c.state.currentTime
            ? "当前时间"
            : "体力 · 路程 · 锁定晚餐",
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
          note: "这只是暂定建议，请确认明日行程和营业时间；系统不会自动替你安排。",
        });
      else removedEvents.push(change);
    }
    return {
      summary: restful
        ? "少一点奔波，多一点从容。"
        : "留住值得的部分，为变化腾出位置。",
      events,
      movedEvents,
      removedEvents,
      explanation:
        "接下来的行程已根据你当前的状态调整。路程和锁定预约会受到保护；移动建议只是暂定方案，并非预订。",
    };
  }
}
