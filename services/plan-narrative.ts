import type { AgentContext, ProposedPlan, Violation } from "../types";

function originals(context: AgentContext) {
  const items = [...context.remainingEvents.map(event => ({ id: event.id, name: event.name, place: event.location })),
    ...(context.unscheduledOriginals ?? []).map(fact => ({ id: fact.id, name: fact.name, place: fact.placeQuery ?? "" }))];
  const ids = new Set(context.originalActivityIds ?? items.map(item => item.id));
  return items.filter(item => ids.has(item.id));
}

export function summarizeVerifiedPlan(context: AgentContext, plan: ProposedPlan) {
  const originalIds = new Set(originals(context).map(item => item.id));
  const kept = plan.events.filter(event => originalIds.has(event.id)).map(event => event.name);
  const removed = plan.removedEvents.map(event => event.name);
  const added = plan.events.filter(event => !originalIds.has(event.id)).map(event => event.name);
  const parts: string[] = [];
  if (kept.length) parts.push(`保留或调整：${kept.join("、")}`);
  if (removed.length === 1 && added.length === 1) parts.push(`用${added[0]}替换${removed[0]}`);
  else {
    if (removed.length) parts.push(`移除：${removed.join("、")}`);
    if (added.length) parts.push(`新增：${added.join("、")}`);
  }
  return parts.join("；") || "建议调整今天的行程";
}

const removalClaim = /删除|移除|取消|放弃|跳过|不去|不保留|改成|换成|替换|取代/;
const retentionClaim = /保留|继续|照常|仍去|留下/;
export function validatePlanExplanation(context: AgentContext, plan: ProposedPlan): Violation[] {
  const kept = new Set(plan.events.map(event => event.id));
  const removed = new Set(plan.removedEvents.map(event => event.eventId));
  const clauses = plan.explanation.split(/[。；;，,\n]/).map(clause => clause.trim()).filter(Boolean);
  const errors: Violation[] = [];
  const known = originals(context);
  const city = context.trip.destination.replace(/[市省]$/, "");
  const shortAlias = (name: string, place: string, items: Array<{ name: string; place: string }>) => {
    const rawCore = (place || name).replace(/^去/, "");
    const placeCore = city && rawCore.startsWith(city) ? rawCore.slice(city.length) : rawCore;
    const shortName = placeCore.slice(0, 2);
    return shortName.length === 2 && items.filter(other => [other.name, other.place].some(value => value.includes(shortName))).length === 1 ? shortName : "";
  };
  for (const item of known) {
    const aliases = [item.name, item.place, shortAlias(item.name, item.place, known)].filter(alias => alias.length >= 2);
    for (const clause of clauses.filter(value => aliases.some(alias => value.includes(alias)))) {
      if (kept.has(item.id) && removalClaim.test(clause) && !/不(?:删除|移除|取消|放弃|替换)/.test(clause)) {
        errors.push({ code: "context", eventId: item.id, message: `说明声称移除或替换“${item.name}”，但方案仍保留该活动。` });
      }
      if (removed.has(item.id) && retentionClaim.test(clause) && !/不(?:保留|继续)/.test(clause)) {
        errors.push({ code: "context", eventId: item.id, message: `说明声称保留“${item.name}”，但方案已移除该活动。` });
      }
    }
  }
  const judgments = new Map((context.impactAnalysis?.activityWeatherJudgments ?? []).map(item => [item.id, item.exposure]));
  const unsupportedClaim = (value: string) => /室内|户外|露天/.test(value) && !/室内外|未核实|待核实|无法确认|尚无法判断|不确定|可能|或许|现场核实/.test(value);
  const planned = plan.events.map(event => ({ name: event.name, place: event.location }));
  for (const event of plan.events) {
    const exposure = judgments.get(event.id) ?? (event.indoorOutdoor === "mixed" ? "unknown" : event.indoorOutdoor);
    if (exposure !== "unknown") continue;
    if (unsupportedClaim(event.reason)) errors.push({ code: "context", eventId: event.id, message: `“${event.name}”的室内外属性没有足够依据，活动理由不能写成已确认。` });
    const aliases = [event.name, event.location, shortAlias(event.name, event.location, planned)].filter(alias => alias.length >= 2);
    if (clauses.some(value => aliases.some(alias => value.includes(alias)) && unsupportedClaim(value))) {
      errors.push({ code: "context", eventId: event.id, message: `说明把“${event.name}”的室内外属性写成已确认，但目前没有依据。` });
    }
  }
  return errors;
}
