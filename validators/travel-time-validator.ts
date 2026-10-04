import type { AgentContext, ProposedPlan, Violation } from "../types";
import { minutes } from "../lib/time";
import { protectedArrivalDeadline } from "../services/protection-policy";
export function travelTimeValidator(
  c: AgentContext,
  p: ProposedPlan,
): Violation[] {
  let previousEnd = minutes(c.state.currentTime);
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
        const fact=c.activityFacts.find(item=>item.id===e.id);
        const deadline=fact&&fact.commitment!=="flexible"?protectedArrivalDeadline(fact):minutes(e.startTime);
        const policy=fact?.protectionPolicy;
        const buffer=policy?.timeAnchor==="departs_at" ? policy.arrivalBuffer?.recommendedMinutes??0 : 0;
        if(previousEnd+required>deadline)errors.push({
          code:"travel_time",
          eventId:e.id,
          message: buffer
            ? `按高德路线需要 ${required} 分钟，且需为 ${e.startTime} 的${policy?.transportKind === "flight" ? "航班" : "车次"}预留 ${buffer} 分钟进站缓冲。`
            : `按高德路线需要 ${required} 分钟，无法在 ${e.startTime} 前到达 ${e.name}。`,
          ...(previousEvent?.locked&&e.locked?{conflict:{kind:"locked_schedule_conflict" as const,eventId:previousEvent.id,nextAnchorEventId:e.id,availableMinutes:Math.max(0,deadline-previousEnd),requiredTransferMinutes:required,message:`${previousEvent.name} 与 ${e.name} 之间没有足够时间完成停留、路程和到达缓冲。`}}:{}),
        });
        if(e.travelTimeFromPrevious!==required)errors.push({code:"travel_time",eventId:e.id,message:"展示的路程时间与高德数据不一致。"});
      }
      previousEnd=minutes(e.endTime);from=e.placeId;previousEvent=e;
    }
    return errors;
  }
  return [{ code: "context", message: "缺少实时路线数据，不能校验方案。" }];
}
