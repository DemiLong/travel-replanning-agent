import {
  ProposedPlanSchema,
  type AgentContext,
  type Violation,
} from "../types";
import { lockedEventValidator } from "./locked-event-validator";
import { timeConflictValidator } from "./time-conflict-validator";
import { travelTimeValidator } from "./travel-time-validator";
import { openingHoursValidator } from "./opening-hours-validator";
import { budgetValidator } from "./budget-validator";
import { pastEventValidator } from "./past-event-validator";
import { MAX_SUGGESTED_DURATION, MIN_SUGGESTED_DURATION, minutes as minutesOf } from "../lib/time";
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
        message: "安排 ID 重复。",
      });
    ids.add(e.id);
    if (e.locked !== (e.status === "locked"))
      errors.push({
        code: "locked_event",
        eventId: e.id,
        message: "锁定状态与锁定标记不一致。",
      });
    const original=c.existingItinerary.find(old=>old.id===e.id);
    const arrivalOnly=Boolean(c.world&&original?.durationSource==="unknown"&&e.durationSource==="unknown"&&e.startTime===e.endTime);
    const nextEvent = p.events.find(other=>other.id!==e.id&&other.startTime>=e.startTime);
    if(arrivalOnly&&nextEvent)errors.push({code:"duration",eventId:e.id,message:"这项安排的结束时间未知，无法安全安排后续活动。",conflict:{kind:"unknown_duration_window",eventId:e.id,nextAnchorEventId:nextEvent.id,message:`${e.name} 后面还有 ${nextEvent.name}，需要先确定可执行的停留时间。`}});
    if (e.endTime <= e.startTime && !arrivalOnly)
      errors.push({
        code: "duration",
        eventId: e.id,
        message: "结束时间必须晚于开始时间。",
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
        message: "候选方案只能包含未完成的安排，不能混入已完成的历史记录。",
      });
    const old = c.existingItinerary.find((old) => old.id === e.id);
    if (old && old.placeId !== e.placeId)
      errors.push({
        code: "place_data",
        eventId: e.id,
        message: "原安排 ID 不能被重新分配到其他地点。",
      });
    if (e.locked && !c.lockedEvents.some((old) => old.id === e.id))
      errors.push({
        code: "locked_event",
        eventId: e.id,
        message: "未经用户授权，不能新建锁定安排。",
      });
    const place = c.places.find((place) => place.id === e.placeId);
    if(c.world){
      const resolved=c.world.resolvedPlaces.find(x=>x.placeId===e.placeId);
      const alternative=c.world.alternatives.find(x=>x.poiId===e.placeId);
      if(!resolved&&!alternative)errors.push({code:"place_data",eventId:e.id,message:"地点未由高德解析并确认。"});
      const unknownDuration=old?.durationSource==="unknown";
      const proposedDuration=unknownDuration&&e.durationSource==="suggested";
      if(unknownDuration&&!arrivalOnly&&(!proposedDuration||minutesOf(e.endTime)-minutesOf(e.startTime)<MIN_SUGGESTED_DURATION||minutesOf(e.endTime)-minutesOf(e.startTime)>MAX_SUGGESTED_DURATION))errors.push({code:"duration",eventId:e.id,message:`未知停留时长只能使用${MIN_SUGGESTED_DURATION}–${MAX_SUGGESTED_DURATION}分钟的方案建议，不能伪装成用户事实。`});
      if(old && (e.name!==old.name || e.location!==old.location || e.estimatedCost!==old.estimatedCost || e.estimatedCostKnown!==old.estimatedCostKnown || (!unknownDuration&&(e.durationSource!==old.durationSource||minutesOf(e.endTime)-minutesOf(e.startTime)!==minutesOf(old.endTime)-minutesOf(old.startTime)))))errors.push({code:"place_data",eventId:e.id,message:"模型不能改写用户确认的地点、费用或活动时长。"});
      if(!old && (!alternative || e.name!==alternative.name || e.location!==(alternative.address||alternative.name) || e.estimatedCostKnown!==false || e.estimatedCost!==0))errors.push({code:"place_data",eventId:e.id,message:"新增活动必须使用真实候选地点，费用未知不能假定免费。"});
      if(e.openingTime!==null||e.closingTime!==null)errors.push({code:"place_data",eventId:e.id,message:"高德 POI 基础数据未验证营业时间，不能自行填入。"});
      if(!old && (minutesOf(e.endTime)-minutesOf(e.startTime)<MIN_SUGGESTED_DURATION||minutesOf(e.endTime)-minutesOf(e.startTime)>MAX_SUGGESTED_DURATION))errors.push({code:"duration",eventId:e.id,message:`新增活动时长必须在${MIN_SUGGESTED_DURATION}–${MAX_SUGGESTED_DURATION}分钟之间。`});
      continue;
    }
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
        message: "必须使用标准的地点身份、区域、费用、营业时间和室内外信息。",
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
        message: "每个原安排必须保留，或明确说明一次移除/移动原因。",
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
        message: "调整内容必须对应已知的未完成安排。",
      });
  for (const moved of p.movedEvents) {
    if(c.world){errors.push({code:"change_accounting",eventId:moved.eventId,message:"本轮真实规划不能在未查询未来数据时移动到其他日期。"});continue;}
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
        message: "移动建议必须落在未来旅行日期，并处于营业时间内。",
      });
  }
  return errors;
}
