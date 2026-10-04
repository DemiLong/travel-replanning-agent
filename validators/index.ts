import {
  ProposedPlanSchema,
  type AgentContext,
  type Violation,
} from "../types";
import { protectionPolicyValidator } from "./protection-policy-validator";
import { timeConflictValidator } from "./time-conflict-validator";
import { travelTimeValidator } from "./travel-time-validator";
import { openingHoursValidator } from "./opening-hours-validator";
import { pastEventValidator } from "./past-event-validator";
import { MAX_SUGGESTED_DURATION, MIN_SUGGESTED_DURATION, minutes as minutesOf } from "../lib/time";
import { stationLevelLocation } from "../services/protection-policy";
export const validators = [
  protectionPolicyValidator,
  timeConflictValidator,
  travelTimeValidator,
  openingHoursValidator,
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
    const original=c.activityFacts.find(fact=>fact.id===e.id);
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
      c.activityFacts.some(
        (fact) => fact.id === e.id && fact.progress === "completed",
      )
    )
      errors.push({
        code: "past_event",
        eventId: e.id,
        message: "候选方案只能包含未完成的安排，不能混入已完成的历史记录。",
      });
    const old = c.remainingActivityFacts.find((fact) => fact.id === e.id);
    if (old && old.placeId !== e.placeId)
      errors.push({
        code: "place_data",
        eventId: e.id,
        message: "原安排 ID 不能被重新分配到其他地点。",
      });
    if (e.locked && !c.protectedActivityFacts.some((fact) => fact.id === e.id))
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
      const expectedLocation=old?.placeQuery?stationLevelLocation(old.placeQuery).location:"";
      const expectedDuration=old?.durationMinutes??(old?.startTime&&old.endTime?minutesOf(old.endTime)-minutesOf(old.startTime):null);
      if(old && (e.name!==old.name || ![old.placeQuery,expectedLocation].includes(e.location) || (!unknownDuration&&(e.durationSource!==old.durationSource||(expectedDuration!==null&&minutesOf(e.endTime)-minutesOf(e.startTime)!==expectedDuration)))))errors.push({code:"place_data",eventId:e.id,message:"模型不能改写用户确认的地点或活动时长。"});
      if(old?.startTime===null && (e.placeId!==old.placeId || e.name!==old.name || e.startTimeSource!=="suggested" || (old.durationMinutes!==null && minutesOf(e.endTime)-minutesOf(e.startTime)!==old.durationMinutes)))errors.push({code:"place_data",eventId:e.id,message:"无原定时间活动必须保留原身份，开始时间标为建议。"});
      if(!old && (!alternative || e.name!==alternative.name || e.location!==(alternative.address||alternative.name)))errors.push({code:"place_data",eventId:e.id,message:"新增活动必须使用真实候选地点。"});
      if(e.openingTime!==null||e.closingTime!==null)errors.push({code:"place_data",eventId:e.id,message:"高德 POI 基础数据未验证营业时间，不能自行填入。"});
      if(!old && (minutesOf(e.endTime)-minutesOf(e.startTime)<MIN_SUGGESTED_DURATION||minutesOf(e.endTime)-minutesOf(e.startTime)>MAX_SUGGESTED_DURATION))errors.push({code:"duration",eventId:e.id,message:`建议活动时长必须在${MIN_SUGGESTED_DURATION}–${MAX_SUGGESTED_DURATION}分钟之间。`});
      continue;
    }
    if (
      !place ||
      e.name !== place.name ||
      e.location !== place.district ||
      e.category !== place.category ||
      e.indoorOutdoor !== place.indoorOutdoor ||
      e.openingTime !== place.openingTime ||
      e.closingTime !== place.closingTime
    )
      errors.push({
        code: "place_data",
        eventId: e.id,
        message: "必须使用标准的地点身份、区域、营业时间和室内外信息。",
      });
  }
  const changes = [...p.movedEvents, ...p.removedEvents];
  const originals = c.remainingActivityFacts.map(fact => ({ id: fact.id, name: fact.name }));
  for (const fact of c.remainingActivityFacts.filter(fact => fact.startTime === null)) {
    if (fact.commitment === "fixed") errors.push({ code: "locked_event", eventId: fact.id, message: "固定预约时间未提供，无法验证为可接受方案。" });
  }
  for (const old of originals) {
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
      !originals.some(
        (e) => e.id === change.eventId && e.name === change.name,
      )
    )
      errors.push({
        code: "change_accounting",
        message: "调整内容必须对应已知的未完成安排。",
      });
  for (const moved of p.movedEvents) {
    if(c.world){errors.push({code:"change_accounting",eventId:moved.eventId,message:"本轮真实规划不能在未查询未来数据时移动到其他日期。"});continue;}
    const old = c.remainingActivityFacts.find((fact) => fact.id === moved.eventId);
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
