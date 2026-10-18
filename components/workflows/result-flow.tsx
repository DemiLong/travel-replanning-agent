"use client";

import Link from "next/link";
import { PlanningError } from "@/components/ui/planning-error";
import { ItineraryTimeline, type ItineraryTone } from "@/components/ui/itinerary-timeline";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ArrowRight, Check, ChevronRight } from "lucide-react";
import { confirmedDraftFromParsed, eventsFromActivityFacts } from "@/services/itinerary-domain";
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
} from "@/types";
import type { ResolutionOption } from "@/types";
import { FailureEnvelopeSchema } from "@/types/failures";
import {
  errorText,
  readApiJson,
  readAssistResponse,
  userFacingPlanningMessage,
} from "./assist-client";
import {
  Loading,
} from "./shared-ui";
import { useRealSession } from "./use-real-session";

const ValidateResponseSchema = z.object({
  ok: z.boolean(),
  violations: z.array(z.unknown()).optional(),
}).passthrough();

function PlanDetails({ plan, request }: { plan: ProposedPlan; request: ReplanningRequest }) {
  const originalIds = new Set(request.activityFacts.filter(fact => fact.progress !== "completed").map(fact => fact.id));
  return <div className="plan-details-content">
    <section className="plan-detail-group explanation"><h2>方案说明</h2><p>{plan.explanation}</p></section>
    <section className="plan-detail-group retained"><h2>保留与新增的原因</h2>
      {plan.events.map(event => <div className="plan-detail-reason" key={event.id}><h3><span>{originalIds.has(event.id) ? "保留／调整" : "新增"}</span>{event.name}</h3><p>{event.reason}</p></div>)}
    </section>
    {plan.removedEvents.length > 0 && <section className="plan-detail-group removed"><h2>移除的原因</h2>
      {plan.removedEvents.map(item => <div className="plan-detail-reason" key={item.eventId}><h3>{item.name}</h3><p>{item.reason}</p></div>)}
    </section>}
  </div>;
}

function planIdentity(plan: ProposedPlan) {
  return JSON.stringify({ events: plan.events.map(event => [event.id, event.placeId, event.startTime, event.endTime, event.travelMode]), removed: plan.removedEvents.map(event => event.eventId) });
}

export function ResultFlow() {
  const { session, setSession, error, setError } = useRealSession();
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const validationControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => validationControllerRef.current?.abort(), []);
  if (!session) return <Loading error={error} />;
  const pending = session.flowStage === "PLAN_READY" ? session.pendingPlan : null;
  if (!pending || pending.result.mode !== "live") return <div className="mobile-workspace empty-screen"><span className="eyebrow">方案</span><h1>还没有待确认的方案。</h1><p className="muted">先从首页告诉我今天发生了什么。</p><Link className="primary full" href="/">返回首页 <ArrowRight size={17} /></Link></div>;
  const { result, base, request } = pending;
  const activePending = pending;
  const plan = result.plan && !validatePlanExplanation(result.context, result.plan).length
    ? { ...result.plan, summary: summarizeVerifiedPlan(result.context, result.plan) } : null;
  const currentParsed = pending.parsedInput ? ParsedUserInputSchema.parse(pending.parsedInput) : null;

  async function regenerateFromDraft(nextParsed: ParsedUserInput, removedLockedIds: string[] = [], removedEventIds: string[] = []) {
    const confirmedDraft = confirmedDraftFromParsed(base, nextParsed, nextParsed.closedPlaceIds, removedLockedIds, removedEventIds);
    const response = await authenticatedJsonFetch("/api/assist", { json: { snapshot: base, confirmedDraft, resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] } } });
    const body = await readAssistResponse(response);
    if (!response.ok) throw new Error(body.message ?? "暂时无法重新安排。");
    if (body.status !== "READY" || !body.result || !body.base || !body.request || !body.parsedInput) throw new Error(body.missingFact?.question ?? body.message ?? "请先补充这次调整需要的信息。");
    const nextResult = AgentResultSchema.parse(body.result);
    const nextRequest = ReplanningRequestSchema.parse(body.request);
    savePendingPlan({ result: nextResult, base: SnapshotSchema.parse(body.base), request: nextRequest, parsedInput: ParsedUserInputSchema.parse(body.parsedInput), impactAnalysis: body.impactAnalysis }, nextRequest);
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
      const nextParsed = option.action === "remove_event" ? { ...currentParsed, activityFacts: currentParsed.activityFacts.filter(item => item.id !== option.eventId) } : { ...currentParsed, activityFacts: currentParsed.activityFacts.map(item => item.id === option.eventId ? { ...item, endTime: null, durationMinutes: option.suggestedDuration ?? 60, durationSource:"suggested" as const } : item) };
      const removedLockedIds = option.action === "remove_event" && request.activityFacts.some(fact => fact.id === option.eventId && fact.commitment !== "flexible") ? [option.eventId] : [];
      await regenerateFromDraft(nextParsed, removedLockedIds, option.action === "remove_event" ? [option.eventId] : []);
    } catch (cause) { setError(errorText(cause)); setBusy(false); }
  }

  function chooseCandidate(candidate: NonNullable<typeof result.candidatePlans>[number]) {
    if (!candidate.plan || !candidate.feasible || validatePlanExplanation(result.context, candidate.plan).length) return;
    const verifiedPlan = { ...candidate.plan, summary: summarizeVerifiedPlan(result.context, candidate.plan) };
    const choices = [...(result.candidatePlans ?? [])];
    if (plan && !choices.some(choice => choice.plan && planIdentity(choice.plan) === planIdentity(plan))) {
      choices.unshift({ id: "primary-" + result.id, title: plan.summary, tradeOff: plan.explanation, feasible: true, plan, conflicts: [] });
    }
    const nextResult = AgentResultSchema.parse({ ...result, id: result.id, ok: true, plan: verifiedPlan, message: candidate.tradeOff, candidatePlans: choices });
    setError("");
    const updated = updateSession({ pendingPlan: { base: activePending.base, request: activePending.request, parsedInput: activePending.parsedInput, impactAnalysis: activePending.impactAnalysis, result: nextResult } });
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
      const completedEvents=eventsFromActivityFacts(base,request.activityFacts.filter(fact=>fact.progress==="completed"));
      const next = SnapshotSchema.parse({ ...base, state: request.currentState, itinerary: [...completedEvents, ...plan.events], revision: current.snapshot.revision + 1 });
      commitSnapshot(next, current.snapshot.revision);
      const updated = updateSession({ itineraryDraft: null, pendingInput: null, flowStage: "HAS_ITINERARY", rawInput: "", parsedInput: null, lastDisruption: request, pendingPlan: null, itineraryPresentation: { revision: next.revision, events: plan.events.map(event => ({ id: event.id, ...destinationFor(event), ...statusOf(event) })) } });
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
  const originalIds = new Set(request.activityFacts.filter(fact=>fact.progress!=="completed").map(fact=>fact.id));
  const statusOf = (event: ItineraryEvent): { label: string; tone: ItineraryTone } => {
    const original = baseMap.get(event.id);
    if (!original) {
      const fact = request.activityFacts.find(fact => fact.id === event.id);
      if (!fact) return plan?.removedEvents.length ? { label: "替换", tone: "replaced" } : { label: "新增", tone: "new" };
      const changed = Boolean(fact.startTime && fact.startTime !== event.startTime || fact.endTime && fact.endTime !== event.endTime);
      return changed ? { label: "调整", tone: "adjusted" } : { label: "保留", tone: "kept" };
    }
    const changed = original.startTime !== event.startTime || original.endTime !== event.endTime || original.location !== event.location;
    return changed ? { label: "调整", tone: "adjusted" } : { label: "保留", tone: "kept" };
  };
  const originalCount = originalIds.size;
  const retainedCount = plan ? plan.events.filter(event => originalIds.has(event.id)).length : 0;
  const impactLabel = !plan ? "需要再调整" : plan.removedEvents.length + plan.movedEvents.length > 2 ? "较高" : plan.removedEvents.length + plan.movedEvents.length > 0 ? "中等" : "低";
  const conflicts = result.conflicts ?? [];
  const options = result.resolutionOptions ?? [];
  const availableCandidates = (result.candidatePlans ?? []).filter(candidate => candidate.plan && candidate.feasible &&
    !validatePlanExplanation(result.context, candidate.plan).length);
  const candidatePlans = availableCandidates.filter(candidate => !plan || planIdentity(candidate.plan!) !== planIdentity(plan));
  const viewingAlternative = Boolean(plan && availableCandidates[0]?.plan && planIdentity(availableCandidates[0].plan) !== planIdentity(plan));
  const destinationFor = (event: ItineraryEvent) => {
    const world = result.context.world;
    const poi = world?.resolvedPlaces.find(item => item.placeId === event.placeId || item.poi.poiId === event.placeId)?.poi
      ?? world?.alternatives.find(item => item.poiId === event.placeId);
    const fact = request.activityFacts.find(item => item.id === event.id);
    return { name: poi?.name || fact?.placeQuery || event.location || event.name, address: poi?.address || event.location };
  };

  return (
    <div className="mobile-workspace plan-screen">
      <div className="plan-heading"><h1>今天建议这样调整</h1></div>
      {error && <PlanningError message={userFacingPlanningMessage(error)} />}
      {plan && <section className="plan-summary-card">
        <div className="plan-summary-top"><div className="plan-summary-heading"><b>保留 {retainedCount} / {originalCount} 个原安排</b></div><span className="impact-chip">影响程度：{impactLabel}</span></div>
        <p className="plan-summary-overview">{plan.summary}</p>
      </section>}
      {(!result.ok || !plan || conflicts.length > 0) && <section className="conflict-panel" aria-live="polite"><div><span className="eyebrow">需要换一种安排</span><h2>有一处时间需要重新协调</h2><p>{conflicts[0]?.message ?? "当前路线或时间无法同时满足，我们保留了你的原行程。"}</p></div><div className="conflict-options">{options.map(option => <button key={option.id} type="button" disabled={busy} onClick={() => void applyResolutionOption(option)}>{option.label}<ChevronRight size={15} /></button>)}</div>{!options.length && <Link className="secondary full" href="/rescue">重新描述这次变化</Link>}</section>}
      {plan && <>
        <div className="plan-toolbar">
          <Drawer autoFocus open={detailsOpen} onOpenChange={setDetailsOpen}>
            <DrawerTrigger asChild>
              <button type="button" className="text-action plan-reasons-link">查看更改理由 <ChevronRight size={15} aria-hidden="true" /></button>
            </DrawerTrigger>
            <DrawerContent className="analysis-drawer plan-reasons-drawer">
              <DrawerHeader className="analysis-header">
                <DrawerTitle>更改理由</DrawerTitle>
                <DrawerDescription className="sr-only">方案说明、保留与新增的原因，以及移除的原因。</DrawerDescription>
              </DrawerHeader>
              <div className="drawer-scroll" data-vaul-no-drag><PlanDetails plan={plan} request={request} /></div>
              <DrawerClose className="drawer-close">知道了</DrawerClose>
            </DrawerContent>
          </Drawer>
        </div>
        {result.context.world?.dataWarnings?.map(warning => <p className="muted" role="status" key={warning}>{warning}</p>)}
        <ItineraryTimeline items={plan.events.map(event => ({ event, ...destinationFor(event), ...statusOf(event) }))} />
        <button type="button" className="text-action centered" disabled={busy} onClick={reviseDescription}>结果有误？点击重新规划</button>
      </>}
      {!notice && plan && <div className="plan-actions">
        <div className={candidatePlans.length ? "plan-action-row" : "plan-action-row single"}>
          {candidatePlans.length > 0 && <button className="plan-alternative-button" type="button" disabled={busy} onClick={() => chooseCandidate(candidatePlans[0])}>{viewingAlternative ? "返回推荐方案" : "查看备选方案"}<ArrowRight size={16} /></button>}
          <button className="primary" type="button" disabled={busy} onClick={() => void accept()}>{validating ? "正在复验…" : busy ? "正在处理…" : "接受方案"}<Check size={17} /></button>
        </div>
        {validating && <button className="text-action centered" type="button" onClick={() => validationControllerRef.current?.abort()}>取消复验</button>}
      </div>}
      {notice && <div className="success-box" role="status">{notice}</div>}
    </div>
  );
}
