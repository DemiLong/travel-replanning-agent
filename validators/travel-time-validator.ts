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
  if (c.world) {
    let from="current";
    let previousEvent: ProposedPlan["events"][number] | undefined;
    for(const e of [...p.events].sort((a,b)=>a.startTime.localeCompare(b.startTime))){
      const mode=e.travelMode??c.world.travelMode;
      const route=c.world.routes.find(r=>r.origin.id===from&&r.destination.id===e.placeId&&r.travelMode===mode&&r.status==="available");
      const allowed=c.disruption.worldOptions?.allowedTravelModes;
      if(mode&&allowed&&!allowed.includes(mode))errors.push({code:"travel_time",eventId:e.id,message:"交通方式违反用户明确限制。"});
      if(from!==e.placeId && (!route || route.durationSeconds===null || Date.now()-Date.parse(route.fetchedAt)>c.world.dataFreshness.routeMaxAgeSeconds*1000)) {
        errors.push({code:"travel_time",eventId:e.id,message:`缺少抵达 ${e.name} 的新鲜高德路线，无法判断是否来得及。`});
      }else{
        const required=from===e.placeId?0:Math.ceil((route!.trafficDurationSeconds??route!.durationSeconds!)/60);
        if(previousEnd+required>minutes(e.startTime))errors.push({
          code:"travel_time",
          eventId:e.id,
          message:`按高德路线需要 ${required} 分钟，无法在 ${e.startTime} 前到达 ${e.name}。`,
          ...(previousEvent?.locked&&e.locked?{conflict:{kind:"locked_schedule_conflict" as const,eventId:previousEvent.id,nextAnchorEventId:e.id,availableMinutes:Math.max(0,minutes(e.startTime)-previousEnd),requiredTransferMinutes:required,message:`${previousEvent.name} 与 ${e.name} 之间没有足够时间完成停留和路程。`}}:{}),
        });
        if(e.travelTimeFromPrevious!==required)errors.push({code:"travel_time",eventId:e.id,message:"展示的路程时间与高德数据不一致。"});
      }
      previousEnd=minutes(e.endTime);from=e.placeId;previousEvent=e;
    }
    return errors;
  }
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
        message: `在 ${e.name} 之前，请为从 ${previousLocation} 到 ${place.district} 预留 ${required} 分钟路程。`,
      });
    previousEnd = minutes(e.endTime);
    previousLocation = place.district;
    previousPlace = e.placeId;
  }
  return errors;
}
