"use client";

import Link from "next/link";
import { PlanningError } from "@/components/ui/planning-error";
import { PlaceCandidateContent, PLACE_CANDIDATE_LIMIT, locationConfirmationTitle } from "@/components/ui/place-candidate";
import { TimeField } from "@/components/ui/time-field";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { LocationService } from "@/services/world/location-service";
import { confirmedDraftFromParsed } from "@/services/itinerary-domain";
import {
  loadSession,
  saveFlowDraft,
  savePendingPlan,
  updateSession,
} from "@/services/trip-service";
import { authenticatedJsonFetch, retryAnonymousSession } from "@/services/api-client";
import {
  AgentResultSchema,
  MAX_RAW_INPUT_LENGTH,
  ParsedUserInputSchema,
  RAW_INPUT_TOO_LONG_MESSAGE,
  ReplanningRequestSchema,
  SnapshotSchema,
  isRawInputWithinLimit,
  type MissingFact,
  type ResolutionState,
} from "@/types";
import {
  errorText,
  readAssistResponse,
  userFacingPlanningMessage,
} from "./assist-client";
import { Loading } from "./shared-ui";
import { HomeExampleDrawer } from "./home-example-drawer";
import { useRealSession } from "./use-real-session";
import { useAuthState } from "./use-auth-state";

export function HomeFlow() {
  const { session, setSession, error, setError } = useRealSession();
  const auth = useAuthState();
  const authPreparing = auth.status === "preparing";
  const [raw, setRaw] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [missingFact, setMissingFact] = useState<MissingFact | null>(null);
  const [confirmedDraft, setConfirmedDraft] = useState<ReturnType<typeof confirmedDraftFromParsed> | null>(null);
  const [resolutionState, setResolutionState] = useState<ResolutionState | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [requestController, setRequestController] = useState<AbortController | null>(null);
  const requestId = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => {
    requestId.current += 1;
    controllerRef.current?.abort();
  }, []);
  useEffect(() => {
    if (!session || ready) return;
    const timeout = window.setTimeout(() => {
      setRaw(session.rawInput);
      setResolutionState(session.resolutionState);
      if (session.pendingInput && session.pendingInput.baseRevision === session.snapshot.revision) {
        setConfirmedDraft(session.pendingInput.confirmedDraft);
        setMissingFact(session.pendingInput.missingFact);
      }
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [session, ready]);
  if (!session) return <Loading error={error} />;
  const activeSession = session;
  const hasItinerary = activeSession.snapshot.itinerary.length > 0;
  const lastUpdated = new Date(activeSession.updatedAt);
  const updatedLabel = Number.isNaN(lastUpdated.getTime()) ? "刚刚更新" : lastUpdated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const descriptionChanged = Boolean(activeSession.pendingInput && raw !== activeSession.pendingInput.questionRawText);

  function abandonRound() {
    requestId.current += 1;
    controllerRef.current?.abort();
    const latest = loadSession();
    const clean = updateSession({ rawInput: raw, parsedInput: null, pendingInput: null, pendingPlan: null, conditionalAdvice: null,
      flowStage: latest.snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
      resolutionState: { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] } });
    setSession(clean);
    setMissingFact(null); setConfirmedDraft(null); setResolutionState(clean.resolutionState); setFollowUp(""); setBusy(false); setError("");
    return clean;
  }

  function changeRaw(text: string) {
    if (controllerRef.current) {
      requestId.current += 1;
      controllerRef.current.abort();
      controllerRef.current = null;
      setRequestController(null);
      setBusy(false);
    }
    setRaw(text);
    if (!isRawInputWithinLimit(text)) {
      setError(RAW_INPUT_TOO_LONG_MESSAGE);
      return;
    }
    saveFlowDraft(text, null, activeSession.pendingPlan ? "PLAN_READY" : hasItinerary ? "HAS_ITINERARY" : "NO_ITINERARY");
    if (activeSession.conditionalAdvice) {
      const cleanResolutionState = { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] };
      setResolutionState(cleanResolutionState);
      setSession(updateSession({ conditionalAdvice: null, parsedInput: null, resolutionState: cleanResolutionState }));
    }
  }

  async function submitAssist(event?: FormEvent, candidateValue?: string, forcedAnswer?: Record<string, unknown>, forceFresh = false) {
    event?.preventDefault();
    const fresh = forceFresh || descriptionChanged || !missingFact;
    if (fresh && !raw.trim()) {
      setError("先写下今天发生的变化吧。");
      return;
    }
    if (fresh && !isRawInputWithinLimit(raw)) {
      setError(RAW_INPUT_TOO_LONG_MESSAGE);
      return;
    }
    if (!fresh && missingFact && !candidateValue && !forcedAnswer && !followUp.trim()) {
      setError("请先回答当前这一个问题。");
      return;
    }
    const requestSession = fresh && activeSession.pendingInput ? abandonRound() : loadSession();
    if (fresh && requestSession.pendingPlan) updateSession({ pendingPlan: null,
      flowStage: requestSession.snapshot.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY" });
    const currentRequestId = ++requestId.current;
    setBusy(true);
    setError("");
    setElapsed(0);
    const controller = new AbortController();
    controllerRef.current = controller;
    setRequestController(controller);
    const ticker = window.setInterval(() => setElapsed(value => value + 1), 1000);
    try {
      let answer = forcedAnswer;
      if (!fresh && missingFact && !answer) {
        if (missingFact.answerType === "poi") answer = { kind: "poi", field: missingFact.key, poiId: candidateValue };
        else if (missingFact.answerType === "event_selection") answer = { kind: "event_selection", field: missingFact.key, eventId: candidateValue };
        else if (missingFact.answerType === "time") answer = { kind: "time", field: missingFact.key, value: followUp.trim() };
        else if (missingFact.key === "travelMode") answer = { kind: "travel_mode", field: "travelMode", value: candidateValue ?? followUp.trim() };
        else answer = { kind: "text", field: missingFact.key, value: candidateValue ?? followUp.trim() };
      }
      const payload = fresh
        ? { snapshot: requestSession.snapshot, rawText: raw, resolutionState: requestSession.resolutionState }
        : { snapshot: requestSession.snapshot, confirmedDraft, answer, resolutionState };
      const response = await authenticatedJsonFetch("/api/assist", { json: payload, signal: controller.signal });
      const body = await readAssistResponse(response);
      if (currentRequestId !== requestId.current) return;
      if (body.status === "NEEDS_INPUT" && body.parsedInput && body.confirmedDraft && body.missingFact && body.resolutionState) {
        setMissingFact(body.missingFact);
        setConfirmedDraft(body.confirmedDraft);
        setResolutionState(body.resolutionState);
        setFollowUp("");
        const updated = updateSession({ rawInput: raw, parsedInput: ParsedUserInputSchema.parse(body.parsedInput), flowStage: "NEEDS_INPUT", resolutionState: body.resolutionState, pendingPlan: null,
          pendingInput: { parsedInput: body.parsedInput, confirmedDraft: body.confirmedDraft,
            missingFact: body.missingFact, questionRawText: raw, baseRevision: requestSession.snapshot.revision } });
        setSession(updated);
        return;
      }
      if (body.status === "CONDITIONAL" && body.advice && body.parsedInput) {
        setMissingFact(null);
        setConfirmedDraft(null);
        setSession(updateSession({ rawInput: raw, parsedInput: body.parsedInput,
          flowStage: "NO_SAFE_PLAN", pendingPlan: null, pendingInput: null,
          conditionalAdvice: body.advice, resolutionState: body.resolutionState ?? requestSession.resolutionState }));
        return;
      }
      if (!response.ok || body.status !== "READY") {
        if (body.status === "AUTH_REQUIRED" || body.status === "RATE_LIMITED" || body.failure?.stage === "AUTH") {
          throw new Error(body.message ?? "会话服务暂时不可用，请稍后重试。");
        }
        const flowStage = body.status === "OUT_OF_SCOPE" ? "OUT_OF_SCOPE" : body.status === "NO_SAFE_PLAN" || body.status === "CONDITIONAL" ? "NO_SAFE_PLAN" : "UNAVAILABLE";
        const cleanResolutionState = { currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] };
        setMissingFact(null);
        setConfirmedDraft(null);
        setFollowUp("");
        setResolutionState(cleanResolutionState);
        setSession(updateSession({ rawInput: raw, flowStage, resolutionState: cleanResolutionState,
          pendingInput: null, pendingPlan: null, conditionalAdvice: null }));
        throw new Error(body.message ?? "真实信息暂时不可用，请稍后重试。");
      }
      if (!body.parsedInput || !body.result || !body.base || !body.request) throw new Error("服务没有返回完整方案，原行程未改变。");
      const result = AgentResultSchema.parse(body.result);
      const base = SnapshotSchema.parse(body.base);
      const request = ReplanningRequestSchema.parse(body.request);
      savePendingPlan({ result, base, request, parsedInput: ParsedUserInputSchema.parse(body.parsedInput), impactAnalysis: body.impactAnalysis }, request);
      updateSession({ pendingInput: null, conditionalAdvice: null, resolutionState: body.resolutionState ?? requestSession.resolutionState });
      window.location.assign("/result");
    } catch (cause) {
      if (currentRequestId === requestId.current && (cause as Error)?.name !== "AbortError") setError(errorText(cause));
    } finally {
      window.clearInterval(ticker);
      if (currentRequestId === requestId.current) { controllerRef.current = null; setRequestController(null); setBusy(false); }
    }
  }

  async function requestBrowserLocation() {
    try {
      const location = await new LocationService().getCurrentPosition();
      await submitAssist(undefined, undefined, { kind: "browser_location", field: "currentLocation", location });
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  const isLocationQuestion = Boolean(missingFact && (missingFact.answerType === "poi" || /location|place/i.test(missingFact.key)));
  const locationName = missingFact?.key === "currentLocation" ? confirmedDraft?.context.currentLocation : confirmedDraft?.activityFacts.find(fact => fact.placeId === missingFact?.key || fact.id === missingFact?.key)?.placeQuery;

  return (
    <div className="mobile-workspace home-screen">
      <div className="home-copy">
        <h1>发生了什么？</h1>
        <div className="home-intro-row">
          <p>请在下方填写你的原计划和突发情况</p>
          <HomeExampleDrawer disabled={busy} onUseExample={text => {
            changeRaw(text);
            setError("");
            inputRef.current?.focus();
          }} />
        </div>
      </div>
      <form className="home-form" onSubmit={submitAssist}>
        <div className="mobile-card home-card">
          <textarea ref={inputRef} id="home-input" value={raw} maxLength={MAX_RAW_INPUT_LENGTH} onChange={event => changeRaw(event.target.value)} aria-label="描述今天的安排和变化" />
        </div>
        {missingFact && !descriptionChanged && (
          <div className="follow-up-card" role="dialog" aria-label="补充必要信息">
            {isLocationQuestion ? <h2 className="location-confirmation-title">{locationConfirmationTitle(missingFact.question, locationName)}</h2> : <><span className="eyebrow">再确认一下</span><h2>{missingFact.question}</h2></>}
            {missingFact.candidates?.length ? <div className={missingFact.answerType === "poi" ? "place-candidate-list" : undefined}>
              {(missingFact.answerType === "poi" ? missingFact.candidates.slice(0, PLACE_CANDIDATE_LIMIT) : missingFact.candidates).map(candidate => <button key={candidate.value} type="button" className={missingFact.answerType === "poi" ? "place-candidate-option" : "poi-option"} disabled={busy} onClick={() => void submitAssist(undefined, candidate.value)}>
                {missingFact.answerType === "poi" ? <PlaceCandidateContent name={candidate.label} description={candidate.description} /> : <span><b>{candidate.label}</b>{candidate.description && <small>{candidate.description}</small>}</span>}
                <ChevronRight size={17} aria-hidden="true" />
              </button>)}
            </div> : null}
            {missingFact.key === "travelMode" && [
              ["WALKING", "步行"], ["TRANSIT", "公共交通"], ["DRIVING", "驾车或打车"],
            // eslint-disable-next-line react-hooks/refs
            ].map(([value, label]) => <button className="poi-option" key={value} type="button" disabled={busy} onClick={() => void submitAssist(undefined, value)}><span><b>{label}</b></span><ChevronRight size={17} /></button>)}
            {!missingFact.candidates?.length && missingFact.key !== "travelMode" && (missingFact.answerType === "time" ? <TimeField id="follow-up-time" value={followUp} onValueChange={setFollowUp} aria-label="补充时间" /> : <input type="text" value={followUp} onChange={event => setFollowUp(event.target.value)} placeholder="只补充这一项信息" />)}
            {missingFact.key === "currentLocation" && <button type="button" className="secondary full browser-location-button" disabled={busy} onClick={() => void requestBrowserLocation()}>使用当前浏览器位置</button>}
            {!missingFact.candidates?.length && missingFact.key !== "travelMode" && <button type="button" className="primary full" disabled={busy} onClick={() => void submitAssist()}>{busy ? "正在确认…" : "回答当前问题"}</button>}
            <button type="button" className="follow-up-retry" onClick={() => void submitAssist(undefined, undefined, undefined, true)}>放弃这个问题，按上方描述重新分析</button>
          </div>
        )}
        {activeSession.conditionalAdvice && !missingFact && <section className="conditional-advice" role="status">
          <strong>{activeSession.conditionalAdvice.heading}</strong>
          {activeSession.conditionalAdvice.suggestions.map((item, index) => <p key={index}>{item}</p>)}
          <p className="conditional-warning">{activeSession.conditionalAdvice.warning}</p>
          <p>可在上方描述中补充固定安排的准确时间，然后重新分析。</p>
        </section>}
        {error && <PlanningError message={userFacingPlanningMessage(error)} />}
        {(!missingFact || descriptionChanged) && <button type="submit" className="primary full home-submit" disabled={busy || authPreparing}>{authPreparing ? "正在准备安全会话…" : busy ? "正在处理…" : descriptionChanged ? "按新描述重新分析" : "帮我重新安排今天"}<ArrowRight size={18} /></button>}
        {auth.status === "error" && <button type="button" className="text-action centered" onClick={() => { void retryAnonymousSession(); }}>会话没准备好，点此重试</button>}
        {busy && <div className="loading-caption" role="status">正在处理你的请求，已等待 {elapsed} 秒。<button type="button" className="text-button" onClick={() => requestController?.abort()}>取消</button></div>}
      </form>
      {activeSession.pendingPlan && <Link className="text-action centered" href="/result">返回上一个方案</Link>}
      {hasItinerary && <Link className="continue-card" href="/trip"><span><b>继续今天的行程</b><small>已有 {activeSession.snapshot.itinerary.length} 个安排 · 上次更新 {updatedLabel}</small></span><ChevronRight size={21} /></Link>}
      {!hasItinerary && <Link className="home-create-link" href="/onboarding">还没有安排？先创建今天的行程</Link>}
    </div>
  );
}
