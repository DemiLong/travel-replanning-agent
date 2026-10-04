"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ShieldCheck, Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { LocationService } from "@/services/world/location-service";
import {
  confirmParsedInput,
  confirmedDraftFromParsed,
  eventsFromActivityFacts,
  hydrateParsedPlans,
  normalizeParsed,
} from "@/services/itinerary-domain";
import { mergeActivityFacts } from "@/services/activity-facts";
import { protectionPolicyForActivity } from "@/services/protection-policy";
import { minutes } from "@/lib/time";
import {
  commitSnapshot,
  saveFlowDraft,
  savePendingPlan,
  updateSession,
} from "@/services/trip-service";
import { authenticatedJsonFetch } from "@/services/api-client";
import {
  AgentResultSchema,
  ConfirmedDraftSchema,
  MAX_RAW_INPUT_LENGTH,
  ParsedUserInputSchema,
  RAW_INPUT_TOO_LONG_MESSAGE,
  ReplanningRequestSchema,
  SnapshotSchema,
  isRawInputWithinLimit,
  rawInputRemaining,
  type ActivityFact,
  type ParsedUserInput,
  type ReplanningRequest,
} from "@/types";
import {
  RealWorldContextSchema,
  type RealWorldContext,
  type TravelMode,
} from "@/types/world";
import {
  errorText,
  parseWithModel,
  readAssistResponse,
} from "./assist-client";
import {
  displayPlace,
  Loading,
  RawInputLimitHint,
  reasonLabels,
  Timeline,
} from "./shared-ui";
import { useRealSession } from "./use-real-session";

const mergedRawInput = (current: string, addition: string) =>
  `${current}\n${addition}`.trim();

export function RescueFlow() {
  const { session, setSession, error, setError } = useRealSession();
  const [parsed, setParsed] = useState<ParsedUserInput | null>(null);
  const [world, setWorld] = useState<RealWorldContext | null>(null);
  const [locationTried, setLocationTried] = useState(false);
  useEffect(() => {
    if (!parsed || parsed.context.currentLocation?.trim() || locationTried) return;
    window.setTimeout(() => setLocationTried(true), 0);
    new LocationService().getCurrentPosition().then(browserLocation => {
      setParsed(current => {
        if (!current || current.context.currentLocation?.trim()) return current;
        const next = { ...current, context: { ...current.context, currentLocation: "浏览器定位", browserLocation }, contextSources: { ...current.contextSources, currentLocation: "system" as const } };
        saveFlowDraft(next.rawText, next, "NEEDS_INPUT");
        return next;
      });
    }).catch(cause => setError(errorText(cause)));
  }, [parsed, locationTried, setError]);
  const [extraPlans, setExtraPlans] = useState("");
  const [closedPlaceIds, setClosedPlaceIds] = useState<string[]>([]);
  const [removedLockedIds, setRemovedLockedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      if (session && !initialized) {
        const blank=ParsedUserInputSchema.parse({rawText:session.rawInput,destinationDraft:session.snapshot.trip.destination,intent:"rescue",activityFacts:[],disruptions:[],constraints:[],context:session.snapshot.state,contextSources:session.snapshot.stateSources,missingFacts:[],status:"draft",parser:"manual"});
        let initial=blank;
        try {
          initial=session.parsedInput?.parser!=="deterministic_fallback" && session.parsedInput ? session.parsedInput : session.rawInput.trim()?await parseWithModel(session.snapshot,session.rawInput):blank;
        }catch(cause){setError(errorText(cause));}
        initial = ParsedUserInputSchema.parse({
          ...initial,
          destinationDraft:
            initial.destinationDraft ?? session.snapshot.trip.destination,
        });
        const matchedClosed = initial.activityFacts
          .filter(
            (event) =>
              initial.disruptions.some((item) => item.kind === "closed") &&
              (initial.rawText
                .toLowerCase()
                .includes(event.name.toLowerCase()) ||
                initial.rawText
                  .toLowerCase()
                  .includes((event.placeQuery??"").toLowerCase()) && Boolean(event.placeQuery?.trim())),
          )
          .map((event) => event.placeId);
        const restoredClosed = initial.closedPlaceIds.length
          ? initial.closedPlaceIds
          : matchedClosed;
        setClosedPlaceIds(restoredClosed);
        setParsed(hydrateParsedPlans(session.snapshot, { ...initial, closedPlaceIds: restoredClosed }));
        setInitialized(true);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [session, initialized, setError]);
  const availableEvents = useMemo(() => {
    if (!session || !parsed) return [];
    return parsed.activityFacts
      .filter((fact): fact is ActivityFact & { startTime: string; placeQuery: string } =>
        fact.role === "existing_plan" && Boolean(fact.startTime) && Boolean(fact.placeQuery?.trim()))
      .map(fact => ({
        id: fact.id,
        placeId: fact.placeId,
        name: fact.name,
        startTime: fact.startTime,
        endTime: fact.endTime,
        durationSource: fact.durationSource,
        location: fact.placeQuery,
        locked: fact.commitment !== "flexible",
        protectionPolicy: fact.protectionPolicy,
      }))
      .sort((left, right) => left.startTime.localeCompare(right.startTime));
  }, [session, parsed]);
  if (!session || !parsed) return <Loading error={error} />;
  const activeSession = session;
  const activeParsed = parsed;
  const existingFacts=activeParsed.activityFacts.filter(fact=>fact.role==="existing_plan");
  const pendingFacts=activeParsed.activityFacts.filter(fact=>fact.role!=="existing_plan");

  function updateParsed(next: ParsedUserInput) {
    const selectedClosed = next.closedPlaceIds ?? closedPlaceIds;
    const normalized = normalizeParsed(
      next,
      activeSession.snapshot.itinerary.length,
      selectedClosed,
    );
    setParsed(normalized);
    const saved = saveFlowDraft(
      normalized.rawText,
      normalized,
      "NEEDS_INPUT",
    );
    setSession(saved);
  }

  function updateFact(id:string,patch:Partial<ActivityFact>){
    const current=activeParsed.activityFacts.find(fact=>fact.id===id);
    if(!current)return;
    const next={...current,...patch};
    if(patch.startTime!==undefined||patch.endTime!==undefined){
      const duration=next.startTime&&next.endTime?minutes(next.endTime)-minutes(next.startTime):0;
      next.durationMinutes=duration>0?duration:null;
      next.durationSource=next.endTime?"user":"unknown";
    }
    const selectedPois={...(activeParsed.worldOptions?.selectedPois??{})};
    if(patch.placeQuery!==undefined&&patch.placeQuery!==current.placeQuery)delete selectedPois[current.placeId];
    updateParsed({...activeParsed,activityFacts:activeParsed.activityFacts.map(fact=>fact.id===id?{...next,protectionPolicy:protectionPolicyForActivity({name:next.name,location:next.placeQuery,sourceText:next.sourceText??"",startTime:next.startTime,endTime:next.endTime,durationMinutes:next.durationMinutes,commitment:next.commitment})}:fact),worldOptions:activeParsed.worldOptions?{...activeParsed.worldOptions,selectedPois}:undefined});
  }

  function chooseReason(reason: ReplanningRequest["reason"]) {
    const disruptions = [
      ...activeParsed.disruptions.filter((item) => item.kind !== "other"),
      { kind: reason, label: reasonLabels[reason], source: "user" as const },
    ].filter(
      (item, index, list) =>
        list.findIndex((other) => other.kind === item.kind) === index,
    );
    updateParsed({
      ...activeParsed,
      disruptions,
      intent: existingFacts.length
        ? "mixed"
        : reason === "optimize"
          ? "optimize"
          : "rescue",
      contextSources: { ...activeParsed.contextSources, disruption: "user" },
    });
  }

  async function addPlans() {
    if (!extraPlans.trim()) {
      setError("请先写下要补充的安排。");
      return;
    }
    const nextRawText = mergedRawInput(activeParsed.rawText, extraPlans);
    if (!isRawInputWithinLimit(nextRawText)) {
      setError(RAW_INPUT_TOO_LONG_MESSAGE);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const parsedAddition = await parseWithModel(activeSession.snapshot, extraPlans);
      if (!parsedAddition.activityFacts.length) {
        throw new Error("AI 没有识别到可确认的活动，请补充活动名称和时间。");
      }
      updateParsed({
        ...activeParsed,
        rawText: nextRawText,
        activityFacts: mergeActivityFacts(activeParsed.activityFacts,parsedAddition.activityFacts),
        intent: activeParsed.disruptions.length ? "mixed" : "create",
      });
      setExtraPlans("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reparseSentence() {
    setBusy(true);setError("");
    try {
      const next=await parseWithModel(activeSession.snapshot,extraPlans.trim()||activeParsed.rawText);
      updateParsed(hydrateParsedPlans(activeSession.snapshot,{...next,worldOptions:activeParsed.worldOptions}));
      setRemovedLockedIds([]);setWorld(null);
    }catch(cause){setError(errorText(cause));}finally{setBusy(false);}
  }

  function promoteMention(
    mention: ActivityFact,
  ) {
    if (!mention.name.trim() || !mention.startTime || !mention.placeQuery?.trim()) {
      setError("已保留这项安排，请补充具体地点和开始时间。");
      return;
    }
    updateFact(mention.id,{name:mention.name.trim(),placeQuery:mention.placeQuery.trim(),role:"existing_plan"});
    setError("");
  }

  async function saveOnly() {
    try {
      const normalized = normalizeParsed(
        activeParsed,
        activeSession.snapshot.itinerary.length,
        activeParsed.closedPlaceIds,
      );
      if (
        !normalized.activityFacts.some(fact=>fact.role==="existing_plan")
      )
        throw new Error("请先确认至少一项今天已有的安排。");
      if (
        normalized.activityFacts
          .filter(fact=>fact.role==="existing_plan")
          .some(fact=>!fact.name.trim()||!fact.startTime||!fact.placeQuery?.trim())
      )
        throw new Error("已保留这项安排，请补充具体地点和开始时间。");
      const destination = normalized.destinationDraft?.trim();
      if (!destination) throw new Error("请填写所在城市。");
      const next = SnapshotSchema.parse({
        ...activeSession.snapshot,
        trip: { ...activeSession.snapshot.trip, destination },
        state: { ...activeSession.snapshot.state, ...normalized.context },
        stateSources: normalized.contextSources,
        itinerary: eventsFromActivityFacts(activeSession.snapshot, normalized.activityFacts),
        revision: activeSession.snapshot.revision + 1,
      });
      commitSnapshot(next, activeSession.snapshot.revision);
      updateSession({
        itineraryDraft: null,
        pendingInput: null,
        flowStage: "HAS_ITINERARY",
        rawInput: "",
        parsedInput: null,
        pendingPlan: null,
      });
      window.location.assign("/trip");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function confirmAndGenerate() {
    setBusy(true);
    setError("");
    try {
      const normalized = normalizeParsed(
        activeParsed,
        activeSession.snapshot.itinerary.length,
        activeParsed.closedPlaceIds,
      );
      if (normalized.missingFacts.length)
        throw new Error("请先补齐页面中标出的必要信息，再生成方案。");
      const confirmed = confirmParsedInput(normalized);
      const destination = normalized.destinationDraft?.trim();
      if (!destination) throw new Error("请填写所在城市。");
      const confirmedDraft = ConfirmedDraftSchema.parse({
        ...confirmedDraftFromParsed(
          activeSession.snapshot,
          confirmed,
          confirmed.closedPlaceIds,
          removedLockedIds,
        ),
        destination,
      });
      const savedConfirmation = updateSession({
        rawInput: confirmed.rawText,
        parsedInput: confirmed,
        flowStage: "NEEDS_INPUT",
      });
      setSession(savedConfirmation);
      const response = await authenticatedJsonFetch("/api/assist", {
        json: {
          snapshot: activeSession.snapshot,
          confirmedDraft,
          resolutionState: activeSession.resolutionState,
        },
      });
      const body = await readAssistResponse(response);
      if (!response.ok) throw new Error(body.message ?? "暂时无法生成方案。");
      if (body.status === "NEEDS_INPUT") {
        if (body.world) setWorld(RealWorldContextSchema.parse(body.world));
        if (body.parsedInput) setParsed(ParsedUserInputSchema.parse(body.parsedInput));
        setError(body.missingFact?.question ?? "请先补充真实地点信息。");
        setBusy(false);
        return;
      }
      if (body.status !== "READY") throw new Error(body.message ?? "真实信息暂时不可用，请稍后重试。");
      const result = AgentResultSchema.parse(body.result);
      const request = ReplanningRequestSchema.parse(body.request);
      savePendingPlan({ result, base: SnapshotSchema.parse(body.base), request, accepted: false, parsedInput: ParsedUserInputSchema.parse(body.parsedInput), impactAnalysis: body.impactAnalysis }, request);
      if (body.resolutionState) updateSession({ resolutionState: body.resolutionState });
      window.location.assign("/result");
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  const missing = new Set(
    normalizeParsed(
      activeParsed,
      activeSession.snapshot.itinerary.length,
      activeParsed.closedPlaceIds,
    ).missingFacts,
  );
  const editableRawText = extraPlans || activeParsed.rawText;
  const supplementalInputLimit = Math.max(
    0,
    rawInputRemaining(activeParsed.rawText) - (activeParsed.rawText.length ? 1 : 0),
  );
  return (
    <div className="workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">生成方案前先确认</span>
          <h1>我理解的是</h1>
          <p>这里的每一项都可以修改；确认后才会开始规划。</p>
        </div>
        <Link className="secondary" href="/">
          <ArrowLeft size={16} /> 返回首页
        </Link>
      </div>
      <div
        className={activeParsed.parser === "llm" ? "success-box" : "error-box"}
        role="status"
      >
        <b>
          {activeParsed.parser === "llm"
            ? "AI 已完成语义拆解"
            : "请描述变化，或确认你手动填写的信息"}
        </b>
        <p>
          {activeParsed.parser === "llm"
            ? "DeepSeek 已提取事实；确认后查询高德，由 AI 提出候选，代码检查固定安排与路线可达性。"
            : "复杂关系不会自动猜测。配置服务端模型密钥后会启用 AI 语义解析。"}
        </p>
      </div>
      {activeParsed.question && <p>这次要解决：{activeParsed.question}</p>}
      <details className="advanced-details">
        <summary>修改原文或补充回答</summary>
        <div className="field">
          <label htmlFor="rescue-sentence">告诉我今天的安排和现在发生的变化</label>
          <textarea
            id="rescue-sentence"
            value={editableRawText}
            maxLength={MAX_RAW_INPUT_LENGTH}
            aria-describedby="rescue-sentence-limit"
            onChange={event => setExtraPlans(event.target.value)}
          />
          <RawInputLimitHint id="rescue-sentence-limit" remaining={rawInputRemaining(editableRawText)} />
          <button type="button" className="secondary" disabled={busy} onClick={reparseSentence}>{busy ? "正在解析……" : "用 AI 重新理解"}</button>
        </div>
      </details>
      {activeParsed.parseWarnings.length > 0 && (
        <div className="error-box" role="alert">
          <b>需要你留意</b>
          <ul>
            {activeParsed.parseWarnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="trip-grid">
        <section className="card form-card">
          <h2>已有安排</h2>
          {availableEvents.length ? (
            <Timeline events={availableEvents} />
          ) : (
            <p className="muted">{pendingFacts.length ? `已识别 ${pendingFacts.length} 项待确认安排，请补齐下方缺失信息。` : "请补充今天已有的安排。"}</p>
          )}
          {missing.has("activityFacts") && (
            <div className="field" style={{ marginTop: 18 }}>
              <label htmlFor="missing-plans">
                请补充至少一项今天已有的安排
              </label>
              <textarea
                id="missing-plans"
                value={extraPlans}
                maxLength={supplementalInputLimit}
                onChange={(event) => setExtraPlans(event.target.value)}
                placeholder="例如：19 点已预订晚餐"
                aria-describedby="missing-plans-limit"
              />
              <RawInputLimitHint
                id="missing-plans-limit"
                remaining={supplementalInputLimit - extraPlans.length}
              />
              <button type="button" className="secondary" onClick={addPlans}>
                识别补充安排
              </button>
            </div>
          )}
          {existingFacts.length > 0 && (
            <details className="advanced-details" style={{ marginTop: 18 }}>
              <summary>修改从文本中识别的安排</summary>
              <div className="stop-list" style={{ marginTop: 16 }}>
                {existingFacts.map((item, index) => (
                  <div className="stop-editor" key={item.id}>
                    <div className="stop-editor-heading">
                      <b>识别结果 {index + 1}</b>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`删除识别结果 ${index + 1}`}
                        onClick={() =>
                          (() => {
                            if (item.commitment !== "flexible" && !window.confirm("这是一项固定安排。确定要删除吗？")) return;
                            if (item.commitment !== "flexible") setRemovedLockedIds((current) => [...new Set([...current, item.id])]);
                            updateParsed({
                              ...activeParsed,
                              activityFacts: activeParsed.activityFacts.filter((candidate) => candidate.id !== item.id),
                            });
                          })()
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="stop-grid">
                      <div className="field stop-name">
                        <label htmlFor={`confirm-name-${item.id}`}>活动</label>
                        <input
                          id={`confirm-name-${item.id}`}
                          value={item.name}
                          onChange={(event) =>
                            updateFact(item.id,{name:event.target.value})
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`confirm-start-${item.id}`}>开始</label>
                        <input
                          id={`confirm-start-${item.id}`}
                          type="time"
                          value={item.startTime ?? ""}
                          onChange={(event) =>
                            updateFact(item.id,{startTime:event.target.value||null,startTimeSource:event.target.value?"user":"not_provided"})
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`confirm-end-${item.id}`}>结束</label>
                        <input
                          id={`confirm-end-${item.id}`}
                          type="time"
                          value={item.endTime ?? ""}
                          onChange={(event) =>
                            updateFact(item.id,{endTime:event.target.value||null,durationSource:event.target.value?"user":"unknown"})
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`confirm-location-${item.id}`}>
                          地点
                        </label>
                        <input
                          id={`confirm-location-${item.id}`}
                          value={item.placeQuery ?? ""}
                          onChange={(event) =>
                            updateFact(item.id,{placeQuery:event.target.value||null})
                          }
                        />
                      </div>
                      <label className="interest fixed-plan">
                        <Checkbox
                          checked={item.commitment !== "flexible"}
                          onCheckedChange={(checked) =>
                            updateFact(item.id,{commitment:checked?"fixed":"flexible"})
                          }
                        />
                        固定时间或预约
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
          {pendingFacts.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h2>需要你确认的活动提及</h2>
              <p className="muted">
                这些内容的角色或时间还不完整，所以没有自动写入行程。
              </p>
              <div className="stop-list" style={{ marginTop: 16 }}>
                {pendingFacts.map((mention, index) => (
                  <div className="stop-editor" key={mention.id}>
                    <div className="stop-editor-heading">
                      <b>待确认 {index + 1} · {mention.sourceText}</b>
                      <span>{mention.commitment!=="flexible"?"固定预约":"待确认"}</span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`忽略活动提及 ${index + 1}`}
                        onClick={() =>
                          updateParsed({
                            ...activeParsed,
                            activityFacts: activeParsed.activityFacts.filter(
                              (item) => item.id !== mention.id,
                            ),
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="stop-grid">
                      <div className="field stop-name">
                        <label htmlFor={`mention-name-${mention.id}`}>活动</label>
                        <input
                          id={`mention-name-${mention.id}`}
                          value={mention.name}
                          onChange={(event) =>
                            updateFact(mention.id,{name:event.target.value})
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`mention-start-${mention.id}`}>开始时间</label>
                        <input
                          id={`mention-start-${mention.id}`}
                          type="time"
                          value={mention.startTime ?? ""}
                          onChange={(event) =>
                            updateFact(mention.id,{startTime:event.target.value||null,startTimeSource:event.target.value?"user":"not_provided"})
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`mention-end-${mention.id}`}>结束时间（可选，不知道可以留空）</label>
                        <input
                          id={`mention-end-${mention.id}`}
                          type="time"
                          value={mention.endTime ?? ""}
                          onChange={(event) =>
                            updateFact(mention.id,{endTime:event.target.value||null,durationSource:event.target.value?"user":"unknown"})
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`mention-location-${mention.id}`}>地点</label>
                        <input
                          id={`mention-location-${mention.id}`}
                          value={mention.placeQuery ?? ""}
                          onChange={(event) =>
                            updateFact(mention.id,{placeQuery:event.target.value||null})
                          }
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => promoteMention(mention)}
                    >
                      确认为已有安排
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {missing.has("activityDetails") && (
            <p className="error-box" role="status">
              有活动还没有地点。请在“修改从文本中识别的安排”中补充后再生成方案。
            </p>
          )}
          <h2 style={{ marginTop: 24 }}>当前变化</h2>
          <div className="quick-reasons">
            {(Object.keys(reasonLabels) as ReplanningRequest["reason"][]).map(
              (reason) => (
                <button
                  type="button"
                  key={reason}
                  className={
                    parsed.disruptions.some((item) => item.kind === reason)
                      ? "quick-reason selected"
                      : "quick-reason"
                  }
                  onClick={() => chooseReason(reason)}
                >
                  {reasonLabels[reason]}
                </button>
              ),
            )}
          </div>
          {missing.has("disruptionOrOptimize") && (
            <p className="error-box" role="status">
              请选择今天发生的变化；如果没有突发情况，可以选择“帮我优化路线”。
            </p>
          )}
          <h2 style={{ marginTop: 24 }}>当前上下文</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="confirm-time">当前时间（必填）</label>
              <input
                id="confirm-time"
                type="time"
                value={parsed.context.currentTime}
                onChange={(event) =>
                  updateParsed({
                    ...parsed,
                    context: {
                      ...parsed.context,
                      currentTime: event.target.value,
                    },
                    contextSources: {
                      ...parsed.contextSources,
                      currentTime: "user",
                    },
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="confirm-location">当前位置（必填）</label>
              <input
                id="confirm-location"
                value={parsed.context.currentLocation ?? ""}
                onChange={(event) =>
                  updateParsed({
                    ...parsed,
                    context: {
                      ...parsed.context,
                      currentLocation: event.target.value,
                    },
                    contextSources: {
                      ...parsed.contextSources,
                      currentLocation: "user",
                    },
                  })
                }
              />
              {(!parsed.context.currentLocation || parsed.context.browserLocation) && <button type="button" className="secondary" disabled={busy} onClick={()=>{updateParsed({...activeParsed,context:{...activeParsed.context,currentLocation:"",browserLocation:undefined}});setLocationTried(false);}}>重新请求浏览器定位</button>}
            </div>
            <div className="field">
              <label htmlFor="confirm-weather">天气（可选）</label>
              <select
                id="confirm-weather"
                value={parsed.context.weather ?? ""}
                onChange={(event) =>
                  updateParsed({
                    ...parsed,
                    context: {
                      ...parsed.context,
                      weather: event.target.value
                        ? (event.target.value as "rain" | "sunny" | "hot")
                        : undefined,
                    },
                    contextSources: {
                      ...parsed.contextSources,
                      weather: event.target.value ? "user" : "unset",
                    },
                  })
                }
              >
                <option value="">未提供</option>
                <option value="rain">下雨</option>
                <option value="sunny">晴天</option>
                <option value="hot">很热</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="confirm-energy">体力（可选）</label>
              <select
                id="confirm-energy"
                value={parsed.context.energyLevel ?? ""}
                onChange={(event) =>
                  updateParsed({
                    ...parsed,
                    context: {
                      ...parsed.context,
                      energyLevel: event.target.value
                        ? (event.target.value as "low" | "medium" | "high")
                        : undefined,
                    },
                    contextSources: {
                      ...parsed.contextSources,
                      energyLevel: event.target.value ? "user" : "unset",
                    },
                  })
                }
              >
                <option value="">未提供</option>
                <option value="low">较低</option>
                <option value="medium">一般</option>
                <option value="high">充沛</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="rescue-city">所在城市（必填，高德服务适用于中国境内）</label>
            <input
              id="rescue-city"
              required
              maxLength={80}
              value={activeParsed.destinationDraft ?? ""}
              onChange={(event) =>
                updateParsed({
                  ...activeParsed,
                  destinationDraft: event.target.value,
                })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="rescue-mode">愿意使用的交通方式（必填）</label>
            <select id="rescue-mode" value={activeParsed.worldOptions?.travelMode??""} onChange={event=>updateParsed({...activeParsed,worldOptions:{selectedPois:activeParsed.worldOptions?.selectedPois??{},travelMode:event.target.value as TravelMode||undefined}})}>
              <option value="">请选择</option><option value="WALKING">步行</option><option value="DRIVING">驾车 / 打车</option><option value="TRANSIT">公交 / 地铁</option>
            </select>
          </div>
          {world && <section aria-label="地点确认与数据状态">
            {world.missingWorldFacts.map((fact,i)=><p key={i} role="status">{fact.kind==="user"?"请补充：":"数据状态："}{fact.message}</p>)}
            {world.ambiguities.map(item=><fieldset key={item.field} className="field"><legend>请确认：{item.label}</legend>{item.candidates.map(poi=><label key={poi.poiId} className="interest"><input type="radio" name={`poi-${item.field}`} checked={activeParsed.worldOptions?.selectedPois[item.field]===poi.poiId} onChange={()=>updateParsed({...activeParsed,worldOptions:{...activeParsed.worldOptions,selectedPois:{...activeParsed.worldOptions?.selectedPois,[item.field]:poi.poiId}}})}/>{poi.name} · {poi.address}（{poi.city} {poi.district}）</label>)}</fieldset>)}
          </section>}
          <h2 style={{ marginTop: 24 }}>需要保留</h2>
          {availableEvents.filter((event) => event.locked).length ? (
            <Timeline
              events={availableEvents.filter((event) => event.locked)}
            />
          ) : (
            <p className="muted">{activeParsed.activityFacts.some(fact=>fact.commitment!=="flexible")?`已识别需保护的预约：${activeParsed.activityFacts.filter(fact=>fact.commitment!=="flexible").map(fact=>`${fact.startTime??"时间待补充"} ${fact.name}`).join("；")}。固定性不明确时也会先按固定安排保护。`:"暂未识别到固定安排。"}</p>
          )}
          {parsed.disruptions.some((item) => item.kind === "closed") && (
            <fieldset className="field" style={{ marginTop: 18 }}>
              <legend>哪个地点关门了？（必填）</legend>
              {availableEvents.map((event) => (
                <label className="interest" key={event.id}>
                  <Checkbox
                    checked={activeParsed.closedPlaceIds.includes(
                      event.placeId,
                    )}
                    onCheckedChange={(checked) => {
                      const next = checked
                        ? [...activeParsed.closedPlaceIds, event.placeId]
                        : activeParsed.closedPlaceIds.filter(
                            (id) => id !== event.placeId,
                          );
                      setClosedPlaceIds(next);
                      updateParsed({ ...activeParsed, closedPlaceIds: next });
                    }}
                  />
                  {event.startTime} · {displayPlace(event.name)}
                </label>
              ))}
            </fieldset>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || missing.size > 0}
              onClick={confirmAndGenerate}
            >
              {busy ? "正在生成……" : "确认并生成方案"}
              <ArrowRight size={18} />
            </button>
            {existingFacts.length > 0 &&
              parsed.disruptions.length === 0 && (
                <button type="button" className="secondary" onClick={saveOnly}>
                  先保存行程
                </button>
              )}
          </div>
        </section>
        <aside>
          <div className="state-card">
            <ShieldCheck size={24} />
            <h2>确认前不会规划</h2>
            <p>
              确认后查询高德地点和路线，必要时查询天气；无法验证的数据不会被当作事实。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
