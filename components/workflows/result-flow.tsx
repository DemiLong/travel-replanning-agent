"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowRight, Check, ChevronRight, MapPin } from "lucide-react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { confirmedDraftFromParsed } from "@/services/itinerary-domain";
import {
  summarizeVerifiedPlan,
  validatePlanExplanation,
} from "@/services/plan-narrative";
import {
  commitSnapshot,
  loadSession,
  logEvent,
  savePendingPlan,
  updateSession,
} from "@/services/trip-service";
import { authenticatedJsonFetch } from "@/services/api-client";
import {
  AgentResultSchema,
  ParsedUserInputSchema,
  ReplanningRequestSchema,
  SnapshotSchema,
  isWorldConfirmationExpired,
  type ItineraryEvent,
  type ParsedUserInput,
  type ProposedPlan,
  type ReplanningRequest,
  type Snapshot,
} from "@/types";
import type { ImpactAnalysis, ResolutionOption } from "@/types";
import { FailureEnvelopeSchema } from "@/types/failures";
import {
  errorText,
  readApiJson,
  readAssistResponse,
  userFacingPlanningMessage,
} from "./assist-client";
import {
  displayPlace,
  eventDurationLabel,
  Loading,
} from "./shared-ui";
import { useRealSession } from "./use-real-session";

const ValidateResponseSchema = z.object({
  ok: z.boolean(),
  violations: z.array(z.unknown()).optional(),
}).passthrough();

function ResultAnalysisContent({ plan, impact, request, base }: {
  plan: ProposedPlan; impact: ImpactAnalysis | undefined; request: ReplanningRequest; base: Snapshot;
}) {
  const originalIds = new Set(request.originalActivityIds ?? base.itinerary.filter(event => event.status !== "completed").map(event => event.id));
  const originalNames = new Map([...base.itinerary.map(event => [event.id, event.name] as const),
    ...(request.unscheduledOriginals ?? []).map(fact => [fact.id, fact.name] as const)]);
  const judgments = new Map((impact?.activityWeatherJudgments ?? []).map(item => [item.id, item]));
  const affected = (impact?.affectedActivities ?? []).map(id => ({ id, name: originalNames.get(id) ?? id,
    evidence: judgments.get(id)?.affected ? judgments.get(id)!.evidence : "用户报告的本次变化可能影响这项安排。" }));
  const unknown = request.reason === "weather" ? (impact?.activityWeatherJudgments ?? []).filter(item => item.exposure === "unknown") : [];
  return <div className="drawer-scroll">
    <div className="analysis-block"><span className="eyebrow">受到影响的原安排</span>
      {affected.map(item => <p className="reason-row" key={item.id}><b>{item.name}</b><span>{item.evidence}</span></p>)}
      {!affected.length && <p>尚无法判断哪些原安排受到影响。</p>}
    </div>
    {unknown.length > 0 && <div className="analysis-block"><span className="eyebrow">室内外属性尚无法判断</span>
      {unknown.map(item => <p className="reason-row" key={`unknown-${item.id}`}><b>{item.name}</b><span>{item.evidence}</span></p>)}
    </div>}
    <div className="analysis-block"><span className="eyebrow">方案说明</span><p className="analysis-explanation">{plan.explanation}</p></div>
    <div className="analysis-block"><span className="eyebrow">保留与新增的原因</span>
      {plan.events.map(event => <p className="reason-row" key={event.id}><b>{originalIds.has(event.id) ? "保留／调整" : "新增"} · {event.name}</b><span>{event.reason}</span></p>)}
    </div>
    {plan.removedEvents.length > 0 && <div className="analysis-block"><span className="eyebrow">移除的原因</span>
      {plan.removedEvents.map(item => <p className="reason-row" key={item.eventId}><b>{item.name}</b><span>{item.reason}</span></p>)}
    </div>}
  </div>;
}

export function ResultFlow() {
  const { session, setSession, error, setError } = useRealSession();
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState("");
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const validationControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => validationControllerRef.current?.abort(), []);
  if (!session) return <Loading error={error} />;
  const pending = session.flowStage === "PLAN_READY" ? session.pendingPlan : null;
  if (!pending || pending.result.mode !== "live") return <div className="mobile-workspace empty-screen"><span className="eyebrow">方案</span><h1>还没有待确认的方案。</h1><p className="muted">先从首页告诉我今天发生了什么。</p><Link className="primary full" href="/">返回首页 <ArrowRight size={17} /></Link></div>;
  const { result, base, request } = pending;
  const activePending = pending;
  const plan = result.plan && !validatePlanExplanation(result.context, result.plan).length
    ? { ...result.plan, summary: summarizeVerifiedPlan(result.context, result.plan) } : null;
  const impact = pending.impactAnalysis ?? result.impactAnalysis;
  const currentParsed = pending.parsedInput ? ParsedUserInputSchema.parse(pending.parsedInput) : null;

  async function regenerateFromDraft(nextParsed: ParsedUserInput, removedLockedIds: string[] = [], removedEventIds: string[] = []) {
    const confirmedDraft = confirmedDraftFromParsed(base, nextParsed, nextParsed.closedPlaceIds, removedLockedIds, removedEventIds);
    const response = await authenticatedJsonFetch("/api/assist", { json: { snapshot: base, confirmedDraft, resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] } } });
    const body = await readAssistResponse(response);
    if (!response.ok) throw new Error(body.message ?? "暂时无法重新安排。");
    if (body.status !== "READY" || !body.result || !body.base || !body.request || !body.parsedInput) throw new Error(body.missingFact?.question ?? body.message ?? "请先补充这次调整需要的信息。");
    const nextResult = AgentResultSchema.parse(body.result);
    const nextRequest = ReplanningRequestSchema.parse(body.request);
    savePendingPlan({ result: nextResult, base: SnapshotSchema.parse(body.base), request: nextRequest, accepted: false, parsedInput: ParsedUserInputSchema.parse(body.parsedInput), impactAnalysis: body.impactAnalysis }, nextRequest);
    window.location.assign("/result");
  }

  async function applyResolutionOption(option: ResolutionOption) {
    if (option.requiresConfirmation && !window.confirm(`确认${option.label}吗？`)) return;
    setBusy(true); setError("");
    try {
      if (option.action === "edit_locked_arrangement") {
        setSession(updateSession({ flowStage: "NEEDS_INPUT", pendingPlan: null }));
        window.location.assign("/rescue");
        return;
      }
      if (!currentParsed) throw new Error("当前调整草稿已过期，请返回编辑页重新确认。");
      const nextParsed = option.action === "remove_event" ? { ...currentParsed, existingPlans: currentParsed.existingPlans.filter(item => item.id !== option.eventId) } : { ...currentParsed, existingPlans: currentParsed.existingPlans.map(item => item.id === option.eventId ? { ...item, endTime: null, durationMinutes: option.suggestedDuration ?? 60 } : item) };
      const removedLockedIds = option.action === "remove_event" && base.itinerary.some(event => event.id === option.eventId && event.locked) ? [option.eventId] : [];
      await regenerateFromDraft(nextParsed, removedLockedIds, option.action === "remove_event" ? [option.eventId] : []);
    } catch (cause) { setError(errorText(cause)); setBusy(false); }
  }

  function chooseCandidate(candidate: NonNullable<typeof result.candidatePlans>[number]) {
    if (!candidate.plan || !candidate.feasible || validatePlanExplanation(result.context, candidate.plan).length) return;
    const verifiedPlan = { ...candidate.plan, summary: summarizeVerifiedPlan(result.context, candidate.plan) };
    const nextResult = AgentResultSchema.parse({ ...result, id: result.id, ok: true, plan: verifiedPlan, message: candidate.tradeOff });
    const updated = updateSession({ pendingPlan: { base: activePending.base, request: activePending.request, accepted: false, parsedInput: activePending.parsedInput, impactAnalysis: activePending.impactAnalysis, result: nextResult } });
    setSession(updated);
  }

  function reviseDescription() {
    const rawInput = activePending.parsedInput?.rawText ?? request.freeText;
    const updated = updateSession({ rawInput, parsedInput: null, pendingInput: null,
      flowStage: "PLAN_READY",
      resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] } });
    setSession(updated);
    window.location.assign("/");
  }

  async function accept() {
    if (!plan) return;
    setBusy(true); setError("");
    setValidating(true);
    const controller = new AbortController();
    validationControllerRef.current = controller;
    try {
      const latest = loadSession();
      if (!latest.pendingPlan || latest.flowStage !== "PLAN_READY") throw new Error("当前方案已失效，请重新分析。");
      if (latest.snapshot.revision !== base.revision) throw new Error("原行程已发生变化，请重新生成方案。");
      if (result.context.world && isWorldConfirmationExpired(result.context.world.currentTime.confirmedAt)) throw new Error("距离确认时间较久，请重新生成方案。");
      const response = await authenticatedJsonFetch("/api/validate", { json: { snapshot: base, request, mode: result.mode, confirmation: { status: "confirmed", confirmedAt: new Date().toISOString() }, plan }, signal: controller.signal });
      const validationBody = await readApiJson(response);
      if (!response.ok) throw new Error(FailureEnvelopeSchema.parse(validationBody).message);
      const checked = ValidateResponseSchema.parse(validationBody);
      if (!checked.ok) throw new Error("方案已不再满足当前安排，请重新生成。");
      const current = loadSession();
      if (!current.pendingPlan || current.flowStage !== "PLAN_READY" || current.pendingPlan.result.id !== result.id) throw new Error("当前方案已失效，请重新分析。");
      if (current.snapshot.revision !== base.revision) throw new Error("原行程已发生变化，请重新生成方案。");
      const next = SnapshotSchema.parse({ ...base, state: request.currentState, itinerary: [...base.itinerary.filter(event => event.status === "completed"), ...plan.events], revision: current.snapshot.revision + 1 });
      commitSnapshot(next, current.snapshot.revision);
      const updated = updateSession({ itineraryDraft: null, pendingInput: null, flowStage: "HAS_ITINERARY", rawInput: "", parsedInput: null, lastDisruption: request, pendingPlan: null });
      setSession(updated); await logEvent("replan_accepted", { planId: result.id, mode: "real" }); setNotice("方案已接受"); window.location.assign("/trip");
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") setError(errorText(cause));
    } finally {
      if (validationControllerRef.current === controller) validationControllerRef.current = null;
      setValidating(false);
      setBusy(false);
    }
  }

  const baseMap = new Map(base.itinerary.map(event => [event.id, event]));
  const originalIds = new Set(request.originalActivityIds ?? base.itinerary.filter(event => event.status !== "completed").map(event => event.id));
  const statusOf = (event: ItineraryEvent) => {
    const original = baseMap.get(event.id);
    if (!original) return originalIds.has(event.id) ? { label: "调整", tone: "adjusted" } : { label: "新增", tone: "new" };
    const changed = original.startTime !== event.startTime || original.endTime !== event.endTime || original.location !== event.location || original.travelTimeFromPrevious !== event.travelTimeFromPrevious;
    return changed ? { label: "调整", tone: "adjusted" } : { label: "保留", tone: "kept" };
  };
  const originalCount = originalIds.size;
  const retainedCount = plan ? plan.events.filter(event => originalIds.has(event.id)).length : 0;
  const impactLabel = !plan ? "需要再调整" : plan.removedEvents.length + plan.movedEvents.length > 2 ? "较高" : plan.removedEvents.length + plan.movedEvents.length > 0 ? "中等" : "低";
  const conflicts = result.conflicts ?? [];
  const options = result.resolutionOptions ?? [];
  const candidatePlans = (result.candidatePlans ?? []).filter(candidate => candidate.plan && candidate.feasible &&
    !validatePlanExplanation(result.context, candidate.plan).length && summarizeVerifiedPlan(result.context, candidate.plan) !== plan?.summary).slice(0, 1);

  return (
    <div className="mobile-workspace plan-screen">
      <div className="plan-heading"><span className="eyebrow">方案等待你的确认</span><h1>今天建议这样调整</h1></div>
      {error && <div className="error-box" role="alert">{userFacingPlanningMessage(error)}</div>}
      {plan && <div className="plan-summary-card"><div className="plan-summary-top"><b>保留 {retainedCount} / {originalCount} 个原安排</b><span className="impact-chip">影响程度：{impactLabel}</span></div><p>{plan.summary}</p></div>}
      {(!result.ok || !plan || conflicts.length > 0) && <section className="conflict-panel" aria-live="polite"><div><span className="eyebrow">需要换一种安排</span><h2>有一处时间需要重新协调</h2><p>{conflicts[0]?.message ?? "当前路线或时间无法同时满足，我们保留了你的原行程。"}</p></div><div className="conflict-options">{options.map(option => <button key={option.id} type="button" disabled={busy} onClick={() => void applyResolutionOption(option)}>{option.label}<ChevronRight size={15} /></button>)}</div>{!options.length && <Link className="secondary full" href="/rescue">重新描述这次变化</Link>}</section>}
      {plan && <>
        <div className="plan-toolbar"><span>按时间顺序</span><Drawer open={analysisOpen} onOpenChange={setAnalysisOpen}><DrawerTrigger asChild><button type="button" className="text-action">查看我的情况分析 <ChevronRight size={15} /></button></DrawerTrigger><DrawerContent className="analysis-drawer"><DrawerHeader className="analysis-header"><DrawerTitle>我的情况分析</DrawerTitle><DrawerDescription>这次变化是怎么影响今天的</DrawerDescription></DrawerHeader><ResultAnalysisContent plan={plan} impact={impact} request={request} base={base} /><DrawerClose className="drawer-close">知道了</DrawerClose></DrawerContent></Drawer></div>
        <div className="plan-timeline">{plan.events.map(event => { const status = statusOf(event); return <div className="plan-event" key={event.id}><div className="plan-event-time"><b>{event.startTime}</b><small>{event.startTimeSource === "suggested" ? "建议时间" : event.endTime === event.startTime ? "时间待定" : event.endTime}</small></div><div className={`plan-event-line ${status.tone}`}><span /></div><div className={`plan-event-card ${status.tone}`}><div className="plan-event-top"><h2 style={{ minWidth: 0, flex: "1 1 auto", overflowWrap: "anywhere" }}>{displayPlace(event.name)}</h2><span className={`status-pill ${status.tone}`} style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}>{status.label}</span></div><p><MapPin size={14} /> {displayPlace(event.location)}</p><div className="event-travel-row"><span className="travel-mode-tag">{event.travelMode ? ({ WALKING: "步行", TRANSIT: "公共交通", DRIVING: "打车" } as Record<string, string>)[event.travelMode] : "路线待查询"}</span><small>{eventDurationLabel(event)}</small></div></div></div>; })}</div>
        <button type="button" className="text-action centered" disabled={busy} onClick={reviseDescription}>结果有误？点击重新规划</button>
        {candidatePlans.length > 0 && <section className="candidate-section"><div className="section-title"><h2>备选方案</h2><span>1 个取舍不同的方案</span></div><div className="candidate-list">{candidatePlans.map(candidate => <button type="button" key={candidate.id} className="candidate-card" onClick={() => chooseCandidate(candidate)}><span><b>{summarizeVerifiedPlan(result.context, candidate.plan!)}</b><small>{candidate.tradeOff}</small></span><ChevronRight size={18} /></button>)}</div></section>}
      </>}
      {!notice && plan && <div className="plan-actions"><button className="primary full" disabled={busy} onClick={() => void accept()}>{validating ? "正在复验…" : busy ? "正在处理…" : "接受方案"}<Check size={17} /></button>{validating && <button className="text-action centered" type="button" onClick={() => validationControllerRef.current?.abort()}>取消复验</button>}{candidatePlans.length > 0 && !validating && <button className="text-action centered" type="button" onClick={() => document.querySelector<HTMLButtonElement>(".candidate-section .candidate-card")?.focus()}>看备选方案</button>}</div>}
      {notice && <div className="success-box" role="status">{notice}</div>}
    </div>
  );
}

