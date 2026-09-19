"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CloudSun,
  LockKeyhole,
  MapPin,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { LocationService } from "@/services/world/location-service";
import { RealWorldContextSchema, type RealWorldContext, type TravelMode } from "@/types/world";
import { confirmParsedInput } from "@/services/input-parser";
import { confirmedDraftFromParsed, hydrateParsedPlans, mergePlans, normalizeParsed } from "@/services/itinerary-domain";
import { addMinutesWithinDay } from "@/lib/time";
import {
  loadSession,
  logEvent,
  requestHeaders,
  saveFlowDraft,
  savePendingPlan,
  saveSession,
  saveTrip,
} from "@/services/trip-service";
import {
  AgentResultSchema,
  ParsedUserInputSchema,
  ReplanningRequestSchema,
  SnapshotSchema,
  type ItineraryEvent,
  type ParsedUserInput,
  type RealSession,
  type ReplanningRequest,
  type Snapshot,
} from "@/types";
import type { ImpactAnalysis, MissingFact, ResolutionOption } from "@/types";

type AssistBody = {
  error?: string;
  status?: string;
  parsedInput?: ParsedUserInput;
  missingFacts?: MissingFact[];
  ambiguities?: RealWorldContext["ambiguities"];
  result?: unknown;
  base?: unknown;
  request?: unknown;
  impactAnalysis?: ImpactAnalysis;
  world?: unknown;
};

const reasonLabels: Record<ReplanningRequest["reason"], string> = {
  weather: "下雨或天气变化",
  late: "晚点或快迟到了",
  tired: "太累了",
  closed: "有个地方关门了",
  discovery: "发现了一个新去处",
  changed_mind: "改变主意了",
  optimize: "帮我优化路线",
  other: "其他变化",
};

const displayPlace = (value: string) => value;
const displayDestination = (value: string) => value;
const eventDurationLabel = (event: ItineraryEvent) => {
  if (event.durationSource === "unknown") return "停留时间待定";
  const [startHour, startMinute] = event.startTime.split(":").map(Number);
  const [endHour, endMinute] = event.endTime.split(":").map(Number);
  const duration = Math.max(0, endHour * 60 + endMinute - (startHour * 60 + startMinute));
  return event.durationSource === "suggested" ? `预计停留 ${duration} 分钟` : `停留至 ${event.endTime}`;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请再试一次。";

const userFacingPlanningMessage = (message: string) =>
  message
    .replaceAll("目前没有找到满足全部硬约束的方案。", "当前安排之间暂时没有可执行的组合。")
    .replaceAll("活动时长缺失或无效。", "这项安排没有足够的可执行停留时间。")
    .replaceAll("未知停留时长只能使用10–180分钟的方案建议，不能伪装成用户事实。", "这项活动的建议停留时间需要重新安排。")
    .replaceAll("活动时长", "停留安排")
    .replaceAll("硬约束", "固定安排")
    .replaceAll("Schema", "行程信息");

async function parseWithModel(
  snapshot: Snapshot,
  rawText: string,
  hint?: ReplanningRequest["reason"],
) {
  const response = await fetch("/api/parse", {
    method: "POST",
    headers: await requestHeaders(),
    body: JSON.stringify({ snapshot, rawText, hint }),
  });
  const body = (await response.json()) as { error?: string; code?: string };
  if (response.ok) return ParsedUserInputSchema.parse(body);
  if (response.status === 503 && body.code === "MODEL_NOT_CONFIGURED") {
    throw new Error("AI 解析未启用，请先配置服务端 DEEPSEEK_API_KEY。");
  }
  throw new Error(body.error ?? "AI 语义解析失败，原文已经保留，请重试。");
}

async function assistWithModel(
  snapshot: Snapshot,
  rawText: string,
  options: { confirmedDraft?: ReturnType<typeof confirmedDraftFromParsed>; appendText?: string; replaceRawText?: string } = {},
) {
  const response = await fetch("/api/assist", {
    method: "POST",
    headers: await requestHeaders(),
    body: JSON.stringify({ snapshot, rawText, ...options }),
  });
  const body = (await response.json()) as { error?: string; parsedInput?: unknown };
  if (!response.ok) throw new Error(body.error ?? "AI 解析失败，请重试。");
  if (!body.parsedInput) throw new Error("AI 没有返回可确认的行程事实。");
  return ParsedUserInputSchema.parse(body.parsedInput);
}

function useRealSession() {
  const [session, setSession] = useState<RealSession | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        setSession(loadSession());
      } catch (cause) {
        setError(errorText(cause));
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);
  return { session, setSession, error, setError };
}

function Loading({ error }: { error?: string }) {
  return (
    <div className="workspace busy" role={error ? "alert" : "status"}>
      {error ? (
        <>
          <h1>恢复上次进度失败</h1>
          <p>{error}</p>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </>
      ) : (
        "正在恢复你上次的进度……"
      )}
    </div>
  );
}

function Timeline({ events }: { events: ItineraryEvent[] }) {
  if (!events.length)
    return <p className="muted">这里暂时没有需要执行的安排。</p>;
  return (
    <div className="timeline">
      {events.map((event) => (
        <div
          className={`event ${event.locked ? "protected" : ""}`}
          key={event.id}
        >
          <div className="event-time">
            {event.startTime}
            <small>{event.durationSource === "unknown" ? "停留时间待定" : event.endTime}</small>
          </div>
          <div className="event-marker">
            {event.locked ? <LockKeyhole size={14} /> : <span />}
          </div>
          <div className="event-body">
            <div className="event-title">
              <h3>{displayPlace(event.name)}</h3>
              <span className={`badge ${event.locked ? "locked" : ""}`}>
                {event.locked ? "保留" : "待进行"}
              </span>
            </div>
            <p>
              <MapPin size={13} /> {displayPlace(event.location)} · {" "}
              {event.estimatedCostKnown === false
                ? "费用未提供"
                : `฿${event.estimatedCost}`}
            </p>
            {event.travelMode && <p>{({WALKING:"步行",TRANSIT:"公共交通",DRIVING:"驾车 / 打车建议"})[event.travelMode]} · 预计 {event.travelTimeFromPrevious} 分钟</p>}
            {event.durationSource === "suggested" && <small>预计停留时间</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomeFlow() {
  const { session, error, setError } = useRealSession();
  const [raw, setRaw] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [missingFacts, setMissingFacts] = useState<MissingFact[]>([]);
  const [assistAnswers, setAssistAnswers] = useState<{ destination?: string; currentLocation?: string; travelMode?: TravelMode; venueSelections?: Record<string, string> }>({});
  const [followUp, setFollowUp] = useState("");
  const [ambiguities, setAmbiguities] = useState<RealWorldContext["ambiguities"]>([]);
  useEffect(() => {
    if (!session || ready) return;
    const timeout = window.setTimeout(() => {
      setRaw(session.rawInput);
      setAssistAnswers({ venueSelections: session.parsedInput?.worldOptions?.selectedPois ?? {}, travelMode: session.lastDisruption?.worldOptions?.travelMode });
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [session, ready]);
  if (!session) return <Loading error={error} />;
  const activeSession = session;
  const hasItinerary = activeSession.snapshot.itinerary.length > 0;
  const lastUpdated = new Date(activeSession.updatedAt);
  const updatedLabel = Number.isNaN(lastUpdated.getTime()) ? "刚刚更新" : lastUpdated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  function chooseQuick(text: string) {
    setRaw(text);
    saveFlowDraft(text, null, "RESCUE_INPUT");
  }

  async function submitAssist(event?: FormEvent, selection?: { field: string; poiId: string }) {
    event?.preventDefault();
    if (!raw.trim()) {
      setError("先写下今天发生的变化吧。");
      return;
    }
    setBusy(true);
    setError("");
    const text = followUp.trim() ? `${raw}\n补充回答：${followUp.trim()}` : raw;
    const answers = selection ? { ...assistAnswers, venueSelections: { ...assistAnswers.venueSelections, [selection.field]: selection.poiId } } : assistAnswers;
    setRaw(text);
    setFollowUp("");
    setAssistAnswers(answers);
    saveFlowDraft(text, activeSession.parsedInput, "RESCUE_INPUT");
    try {
      let response = await fetch("/api/assist", { method: "POST", headers: await requestHeaders(), body: JSON.stringify({ snapshot: activeSession.snapshot, rawText: text, userAnswers: answers }) });
      let body = (await response.json()) as AssistBody;
      if (response.ok && body.status === "needs_input" && body.missingFacts?.[0]?.field === "currentLocation" && !body.ambiguities?.length) {
        try {
          const browserLocation = await new LocationService().getCurrentPosition();
          response = await fetch("/api/assist", { method: "POST", headers: await requestHeaders(), body: JSON.stringify({ snapshot: activeSession.snapshot, rawText: text, userAnswers: answers, browserLocation }) });
          body = (await response.json()) as AssistBody;
        } catch {
          // The normal follow-up card remains available when location is denied.
        }
      }
      if (!response.ok) throw new Error(body.error ?? "暂时无法接住这次变化，请稍后重试。");
      if (!body.parsedInput) throw new Error("AI 没有返回可确认的行程事实。");
      if (body.status === "needs_input") {
        setMissingFacts(body.missingFacts ?? []);
        setAmbiguities(body.ambiguities ?? []);
        setAssistAnswers(current => ({ ...current, venueSelections: body.parsedInput?.worldOptions?.selectedPois ?? current.venueSelections }));
        saveFlowDraft(text, body.parsedInput, "RESCUE_INPUT");
        setBusy(false);
        return;
      }
      if (body.status !== "ready") throw new Error(body.error ?? "真实信息暂时不可用，请稍后重试。");
      const result = AgentResultSchema.parse(body.result);
      const base = SnapshotSchema.parse(body.base);
      const request = ReplanningRequestSchema.parse(body.request);
      savePendingPlan({ result, base, request, accepted: false, parsedInput: ParsedUserInputSchema.parse(body.parsedInput), impactAnalysis: body.impactAnalysis }, request);
      window.location.assign("/result");
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  return (
    <div className="mobile-workspace home-screen">
      <div className="home-brand"><Sparkles size={18} /><span>接住你</span></div>
      <div className="home-copy">
        <span className="eyebrow">今天也可以慢慢来</span>
        <h1>发生了森么？</h1>
        <p>把你的原计划和突发情况直接告诉俺！</p>
      </div>
      <form className="mobile-card home-card" onSubmit={submitAssist}>
        <textarea id="home-input" value={raw} maxLength={4000} onChange={event => { setRaw(event.target.value); saveFlowDraft(event.target.value, null, "RESCUE_INPUT"); }} placeholder="比如：航班晚点了，我想保留晚餐预约" aria-label="描述今天的安排和变化" />
        <div className="example-row" aria-label="示例提示">
          {["航班晚点了", "突然下雨了", "起晚了", "景点关闭"].map(item => <button key={item} type="button" className="example-chip" onClick={() => chooseQuick(item)}>{item}</button>)}
        </div>
        {missingFacts.length > 0 && (
          <div className="follow-up-card" role="dialog" aria-label="补充必要信息">
            <span className="eyebrow">再确认一下</span>
            <h2>{missingFacts[0].reason}</h2>
            {ambiguities.filter(item => item.field === missingFacts[0].field).flatMap(item => item.candidates.map(candidate => <button className="poi-option" key={candidate.poiId} type="button" disabled={busy} onClick={() => void submitAssist(undefined, { field: item.field, poiId: candidate.poiId })}><span><b>{candidate.name}</b><small>{candidate.address}</small></span><ChevronRight size={17} /></button>))}
            {!ambiguities.some(item => item.field === missingFacts[0].field) && <input value={followUp} onChange={event => setFollowUp(event.target.value)} placeholder="直接用自己的话回答" />}
            <button type="button" className="primary full" disabled={busy} onClick={() => void submitAssist()}>{busy ? "正在确认…" : "继续安排今天"}</button>
          </div>
        )}
        {error && <div className="error-box" role="alert">{userFacingPlanningMessage(error)}</div>}
        <button className="primary full home-submit" disabled={busy}>{busy ? "正在帮你重新安排…" : "帮我重新安排今天"}<ArrowRight size={18} /></button>
        {busy && <p className="loading-caption">正在查路线・正在规划…</p>}
      </form>
      {hasItinerary && <Link className="continue-card" href="/trip"><span><b>继续今天的行程</b><small>已有 {activeSession.snapshot.itinerary.length} 个安排 · 上次更新 {updatedLabel}</small></span><ChevronRight size={21} /></Link>}
      {!hasItinerary && <Link className="home-create-link" href="/onboarding">还没有安排？先创建今天的行程</Link>}
    </div>
  );
}

export function OnboardingFlow() {
  const { session, setSession, error, setError } = useRealSession();
  const [raw, setRaw] = useState("");
  const [items, setItems] = useState<ParsedUserInput["existingPlans"]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [budget, setBudget] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [parsing, setParsing] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (session && !initialized) {
        setInitialized(true);
        setSnapshot(session.snapshot);
        setRaw(session.rawInput);
        setItems(session.parsedInput?.existingPlans ?? []);
        setBudget(session.snapshot.profile.dailyBudget?.toString() ?? "");
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [session, initialized, setError]);
  if (!session || !snapshot) return <Loading error={error} />;
  const activeSession = session;
  const activeSnapshot = snapshot;

  function persist(nextSnapshot: Snapshot, nextRaw = raw) {
    setSnapshot(nextSnapshot);
    const updated = saveSession({
      ...activeSession,
      snapshot: { ...nextSnapshot, mode: "user" },
      rawInput: nextRaw,
      flowStage: nextSnapshot.itinerary.length
        ? "HAS_ITINERARY"
        : "NO_ITINERARY",
    });
    setSession(updated);
  }

  async function parsePlans() {
    if (!raw.trim()) {
      setError("请先粘贴或输入今天已有的安排。");
      return;
    }
    setParsing(true);
    setError("");
    try {
      const parsed = await parseWithModel(activeSnapshot, raw);
      setItems(parsed.existingPlans);
      const updated = saveSession({
        ...activeSession,
        rawInput: raw,
        parsedInput: parsed,
      });
      setSession(updated);
      if (parsed.activityMentions.length) window.location.assign("/rescue");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setParsing(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (!items.length)
        throw new Error("请先解析并确认至少一项今天已有的安排。");
      if (!activeSnapshot.state.currentLocation.trim())
        throw new Error("请填写当前地点。");
      if (items.some((item) => !item.name.trim()))
        throw new Error("请检查活动名称。");
      const parsed = ParsedUserInputSchema.parse({
        rawText: raw,
        intent: "create",
        existingPlans: items,
        disruptions: [],
        constraints: items
          .filter((item) => item.locked)
          .map((item) => ({
            kind: "keep",
            value: `${item.startTime} ${item.name}`,
            source: "user",
          })),
        context: activeSnapshot.state,
        contextSources: activeSnapshot.stateSources,
        closedPlaceIds: [],
        missingFacts: [],
        status: "confirmed",
      });
      const dailyBudget = budget ? Number(budget) : undefined;
      const next = SnapshotSchema.parse({
        ...activeSnapshot,
        profile: { ...activeSnapshot.profile, dailyBudget },
        state: { ...activeSnapshot.state, remainingBudget: dailyBudget },
        itinerary: mergePlans({ ...activeSnapshot, itinerary: [] }, parsed),
        revision: activeSnapshot.revision + 1,
      });
      await saveTrip(next, activeSnapshot.revision);
      saveSession({
        ...loadSession(),
        snapshot: { ...next, mode: "user" },
        flowStage: "HAS_ITINERARY",
        rawInput: "",
        parsedInput: null,
        pendingPlan: null,
      });
      await logEvent("trip_created", { tripId: next.trip.id, mode: "real" });
      window.location.assign("/trip");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <div className="mobile-workspace onboarding-screen">
      <div className="onboarding-brand"><Sparkles size={17} /><span>接住你</span></div>
      <div className="onboarding-heading">
        <div>
          <span className="eyebrow">第一次来，先填这几个就行</span>
          <h1>把今天的安排放进来。</h1>
          <p>不用一次写得很完整，之后也可以慢慢调整。</p>
        </div>
      </div>
      <form className="card form-card setup-form" onSubmit={submit}>
        <section className="setup-section">
          <div className="section-heading">
            <span>01</span>
            <div>
              <h2>先告诉我你现在在哪儿</h2>
              <p>这几个信息够我判断接下来怎么走。</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="destination">所在城市</label>
              <input
                id="destination"
                value={snapshot.trip.destination}
                onChange={(event) =>
                  persist({
                    ...snapshot,
                    trip: { ...snapshot.trip, destination: event.target.value },
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="day-date">今天是哪一天</label>
              <input
                id="day-date"
                required
                type="date"
                value={snapshot.state.currentDate}
                onChange={(event) => {
                  const currentDate = event.target.value;
                  persist({
                    ...snapshot,
                    trip: {
                      ...snapshot.trip,
                      startDate: currentDate,
                      endDate: currentDate,
                    },
                    state: { ...snapshot.state, currentDate },
                  });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="current-time">现在大概几点</label>
              <input
                id="current-time"
                required
                type="time"
                value={snapshot.state.currentTime}
                onChange={(event) =>
                  persist({
                    ...snapshot,
                    state: {
                      ...snapshot.state,
                      currentTime: event.target.value,
                    },
                    stateSources: {
                      ...snapshot.stateSources,
                      currentTime: "user",
                    },
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="current-location">现在在哪儿</label>
              <input
                id="current-location"
                required
                value={snapshot.state.currentLocation}
                onChange={(event) =>
                  persist({
                    ...snapshot,
                    state: {
                      ...snapshot.state,
                      currentLocation: event.target.value,
                      browserLocation: undefined,
                    },
                    stateSources: {
                      ...snapshot.stateSources,
                      currentLocation: "user",
                    },
                  })
                }
                placeholder="例如：城市中心、酒店或车站"
              />
            </div>
          </div>
        </section>
        <section className="setup-section">
          <div className="section-heading">
            <span>02</span>
            <div>
              <h2>再放进今天的安排</h2>
              <p>直接粘贴一段话就好，整理后还能逐项修改。</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="itinerary-input">你今天想怎么安排？</label>
            <textarea
              id="itinerary-input"
              value={raw}
              onChange={(event) => {
                setRaw(event.target.value);
                persist(snapshot, event.target.value);
              }}
              placeholder="10 点去城市博物馆，12:30 午餐，19 点已预订晚餐"
            />
          </div>
          <button
            type="button"
            className="secondary"
            disabled={parsing}
            onClick={parsePlans}
          >
            {parsing ? "正在整理你的安排…" : "整理这份行程"}
          </button>
          {items.length > 0 && (
            <div className="stop-list" style={{ marginTop: 18 }}>
              {items.map((item, index) => (
                <div className="stop-editor" key={item.id}>
                  <div className="stop-editor-heading">
                    <b>安排 {index + 1}</b>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`删除安排 ${index + 1}`}
                      onClick={() =>
                        setItems((current) =>
                          current.filter(
                            (candidate) => candidate.id !== item.id,
                          ),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="stop-grid">
                    <div className="field stop-name">
                      <label htmlFor={`name-${item.id}`}>活动</label>
                      <input
                        id={`name-${item.id}`}
                        required
                        value={item.name}
                        onChange={(event) =>
                          setItems((current) =>
                            current.map((candidate) =>
                              candidate.id === item.id
                                ? { ...candidate, name: event.target.value }
                                : candidate,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`start-${item.id}`}>开始</label>
                      <input
                        id={`start-${item.id}`}
                        type="time"
                        required
                        value={item.startTime}
                        onChange={(event) =>
                          setItems((current) =>
                            current.map((candidate) =>
                              candidate.id === item.id
                                ? {
                                    ...candidate,
                                    startTime: event.target.value,
                                  }
                                : candidate,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`end-${item.id}`}>结束</label>
                      <input
                        id={`end-${item.id}`}
                        type="time"
                        value={item.endTime ?? ""}
                        onChange={(event) =>
                          setItems((current) =>
                            current.map((candidate) =>
                              candidate.id === item.id
                                ? { ...candidate, endTime: event.target.value || null }
                                : candidate,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="field stop-location">
                      <label htmlFor={`location-${item.id}`}>地点</label>
                      <input
                        id={`location-${item.id}`}
                        required
                        value={item.location}
                        onChange={(event) =>
                          setItems((current) =>
                            current.map((candidate) =>
                              candidate.id === item.id
                                ? { ...candidate, location: event.target.value }
                                : candidate,
                            ),
                          )
                        }
                      />
                    </div>
                    <label className="interest fixed-plan">
                      <Checkbox
                        checked={item.locked}
                        onCheckedChange={(checked) =>
                          setItems((current) =>
                            current.map((candidate) =>
                              candidate.id === item.id
                                ? { ...candidate, locked: Boolean(checked) }
                                : candidate,
                            ),
                          )
                        }
                      />
                      固定时间或预约
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <details className="preferences-panel">
          <summary>想补充更多？预算与节奏（可选）</summary>
          <div className="form-grid" style={{ marginTop: 16 }}>
            <div className="field">
              <label htmlFor="budget">今天剩余预算（可选，泰铢）</label>
              <input
                id="budget"
                type="number"
                min="0"
                max="100000"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="pace">旅行节奏（可选）</label>
              <select
                id="pace"
                value={snapshot.profile.travelPace}
                onChange={(event) =>
                  persist({
                    ...snapshot,
                    profile: {
                      ...snapshot.profile,
                      travelPace: event.target
                        .value as Snapshot["profile"]["travelPace"],
                    },
                  })
                }
              >
                <option value="relaxed">轻松</option>
                <option value="balanced">平衡</option>
                <option value="packed">紧凑</option>
              </select>
            </div>
          </div>
        </details>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="form-actions">
          <button className="primary" disabled={!items.length}>
            开始今天的行程 <ArrowRight size={18} />
          </button>
          <Link className="secondary" href="/">
            返回首页
          </Link>
        </div>
        <p className="small-note">
          行程会保存在这台设备上，之后随时可以回来调整。
        </p>
      </form>
    </div>
  );
}

export function TripFlow() {
  const { session, error } = useRealSession();
  if (!session) return <Loading error={error} />;
  const { snapshot } = session;
  if (!snapshot.itinerary.length)
    return (
      <div className="mobile-workspace empty-screen">
        <span className="eyebrow">今日</span>
        <h1>今天还没有行程。</h1>
        <p className="muted">把今天的安排告诉我，我们一起慢慢排好。</p>
        <Link className="primary full" href="/">开始安排今天 <ArrowRight size={17} /></Link>
      </div>
    );
  const currentMinutes = snapshot.state.currentTime.split(":").map(Number).reduce((h, m) => h * 60 + m, 0);
  const remaining = snapshot.itinerary.filter(event => event.status !== "completed").sort((a, b) => a.startTime.localeCompare(b.startTime));
  const nextEvent = remaining.find((event) => event.startTime.split(":").map(Number).reduce((h, m) => h * 60 + m, 0) >= currentMinutes) ?? remaining[0];
  return (
    <div className="mobile-workspace today-screen">
      <div className="today-heading">
        <div><span className="eyebrow">{displayDestination(snapshot.trip.destination)} · {snapshot.state.currentDate}</span><h1>今天，慢慢走</h1></div>
        <div className="today-meta"><span>{snapshot.state.currentTime}</span><span><CloudSun size={16} />{snapshot.state.weather === "rain" ? "有雨" : "天气不错"}</span></div>
      </div>
      <section className="next-card">
        <div><span className="eyebrow">下一步去哪</span>{nextEvent ? <><h2>{displayPlace(nextEvent.name)}</h2><p><MapPin size={14} /> {displayPlace(nextEvent.location)} · {nextEvent.travelMode ? ({ WALKING: "步行", TRANSIT: "公共交通", DRIVING: "打车" } as Record<string, string>)[nextEvent.travelMode] : "路线待查询"}</p></> : <h2>今天没有待执行安排</h2>}</div><ChevronRight size={24} />
      </section>
      <div className="route-strip"><span className="route-dot active" /><span /><span className="route-dot" /><span /><span className="route-dot" /><small>{nextEvent?.travelTimeFromPrevious ? `路上约 ${nextEvent.travelTimeFromPrevious} 分钟` : "按自己的节奏走"}</small></div>
      <section className="today-list-section"><div className="section-title"><h2>今日剩余</h2><span>{remaining.length} 个安排</span></div><div className="mobile-timeline">{remaining.map((event, index) => <div className={`mobile-timeline-item ${event.id === nextEvent?.id ? "current" : ""}`} key={event.id}><div className="mobile-time"><b>{event.startTime}</b><small>{event.endTime === event.startTime ? "时间待定" : event.endTime}</small></div><div className="mobile-line"><span /></div><div className="mobile-event"><div><b>{displayPlace(event.name)}</b>{event.locked && <span className="status-pill kept">保留</span>}</div><p>{displayPlace(event.location)} · {event.durationSource === "unknown" ? "停留时间待定" : `${Math.max(0, event.endTime.split(":").map(Number).reduce((h, m) => h * 60 + m, 0) - event.startTime.split(":").map(Number).reduce((h, m) => h * 60 + m, 0))} 分钟`}</p>{index === 0 && <small className="now-label">进行中</small>}</div></div>)}</div></section>
      <Link className="change-card" href="/"><span><b>发生变化？</b><small>随时告诉我，我来帮你重新安排</small></span><ArrowRight size={18} /></Link>
      <Link className="today-edit-link" href="/onboarding">编辑今天的安排</Link>
    </div>
  );
}

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
        saveFlowDraft(next.rawText, next, "RESCUE_CONFIRM");
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
        const blank=ParsedUserInputSchema.parse({rawText:session.rawInput,intent:"rescue",existingPlans:[],disruptions:[],constraints:[],context:session.snapshot.state,contextSources:session.snapshot.stateSources,missingFacts:[],status:"draft",parser:"manual"});
        let initial=blank;
        try {
          initial=session.parsedInput?.parser!=="deterministic_fallback" && session.parsedInput ? session.parsedInput : session.rawInput.trim()?await assistWithModel(session.snapshot,session.rawInput):blank;
        }catch(cause){setError(errorText(cause));}
        const matchedClosed = mergePlans(session.snapshot, initial)
          .filter(
            (event) =>
              initial.disruptions.some((item) => item.kind === "closed") &&
              (initial.rawText
                .toLowerCase()
                .includes(event.name.toLowerCase()) ||
                initial.rawText
                  .toLowerCase()
                  .includes(event.location.toLowerCase()) && Boolean(event.location.trim())),
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
  }, [session, initialized]);
  const availableEvents = useMemo(() => {
    if (!session || !parsed) return [];
    return mergePlans(session.snapshot, parsed);
  }, [session, parsed]);
  if (!session || !parsed) return <Loading error={error} />;
  const activeSession = session;
  const activeParsed = parsed;

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
      "RESCUE_CONFIRM",
    );
    setSession(saved);
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
      intent: activeParsed.existingPlans.length
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
    setBusy(true);
    setError("");
    try {
      const draft = confirmedDraftFromParsed(activeSession.snapshot, activeParsed, closedPlaceIds, removedLockedIds);
      const parsedAddition = await assistWithModel(activeSession.snapshot, `${activeParsed.rawText}\n${extraPlans}`.trim(), { confirmedDraft: draft, appendText: extraPlans });
      if (!parsedAddition.existingPlans.length && !parsedAddition.activityMentions.length) {
        throw new Error("AI 没有识别到可确认的活动，请补充活动名称和时间。");
      }
      updateParsed({
        ...parsedAddition,
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
      const draft = confirmedDraftFromParsed(activeSession.snapshot, activeParsed, closedPlaceIds, removedLockedIds);
      const next=await assistWithModel(activeSession.snapshot,extraPlans.trim()||activeParsed.rawText,{confirmedDraft:draft,replaceRawText:extraPlans.trim()||activeParsed.rawText});
      updateParsed(hydrateParsedPlans(activeSession.snapshot,{...next,worldOptions:activeParsed.worldOptions}));
      setRemovedLockedIds([]);setWorld(null);
    }catch(cause){setError(errorText(cause));}finally{setBusy(false);}
  }

  function promoteMention(
    mention: ParsedUserInput["activityMentions"][number],
  ) {
    if (!mention.name.trim() || !mention.startTime || !mention.location?.trim()) {
      setError("已保留这项安排，请补充具体地点和开始时间。");
      return;
    }
    let endTime = mention.endTime;
    if (!endTime && mention.durationMinutes) {
      try { endTime = addMinutesWithinDay(mention.startTime, mention.durationMinutes); }
      catch (cause) { setError(errorText(cause)); return; }
    }
    updateParsed({
      ...activeParsed,
      existingPlans: [
        ...activeParsed.existingPlans,
        {
          id: `confirmed-${crypto.randomUUID()}`,
          name: mention.name.trim(),
          startTime: mention.startTime,
          endTime,
          durationMinutes: mention.durationMinutes,
          location: mention.location.trim(),
          estimatedCost: mention.estimatedCost ?? 0,
          estimatedCostKnown: mention.estimatedCost !== null,
          locked: mention.locked === "yes",
          source: "user",
        },
      ],
      activityMentions: activeParsed.activityMentions.filter(
        (item) => item.id !== mention.id,
      ),
    });
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
        activeSession.snapshot.itinerary.length +
          normalized.existingPlans.length ===
        0
      )
        throw new Error("请先确认至少一项今天已有的安排。");
      const next = SnapshotSchema.parse({
        ...activeSession.snapshot,
        state: { ...activeSession.snapshot.state, ...normalized.context },
        stateSources: normalized.contextSources,
        itinerary: mergePlans(activeSession.snapshot, normalized),
        revision: activeSession.snapshot.revision + 1,
      });
      await saveTrip(next, activeSession.snapshot.revision);
      saveSession({
        ...loadSession(),
        snapshot: { ...next, mode: "user" },
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
      const confirmedDraft = confirmedDraftFromParsed(
        activeSession.snapshot,
        confirmed,
        confirmed.closedPlaceIds,
        removedLockedIds,
      );
      const savedConfirmation = saveSession({
        ...loadSession(),
        rawInput: confirmed.rawText,
        parsedInput: confirmed,
        flowStage: "RESCUE_CONFIRM",
      });
      setSession(savedConfirmation);
      const response = await fetch("/api/assist", {
        method: "POST",
        headers: await requestHeaders(),
        body: JSON.stringify({
          snapshot: activeSession.snapshot,
          rawText: confirmed.rawText,
          confirmedDraft,
          userAnswers: { venueSelections: confirmed.worldOptions?.selectedPois },
        }),
      });
      const body = (await response.json()) as AssistBody;
      if (!response.ok) throw new Error(body.error ?? "暂时无法生成方案。");
      if (body.status === "needs_input") {
        if (body.world) setWorld(RealWorldContextSchema.parse(body.world));
        if (body.parsedInput) setParsed(ParsedUserInputSchema.parse(body.parsedInput));
        setError(body.missingFacts?.[0]?.reason ?? "请先补充真实地点信息。");
        setBusy(false);
        return;
      }
      if (body.status !== "ready") throw new Error(body.error ?? "真实信息暂时不可用，请稍后重试。");
      const result = AgentResultSchema.parse(body.result);
      const request = ReplanningRequestSchema.parse(body.request);
      savePendingPlan({ result, base: SnapshotSchema.parse(body.base), request, accepted: false, parsedInput: ParsedUserInputSchema.parse(body.parsedInput), impactAnalysis: body.impactAnalysis }, request);
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
      <details className="advanced-details"><summary>修改原文或补充回答</summary><div className="field"><label htmlFor="rescue-sentence">告诉我今天的安排和现在发生的变化</label><textarea id="rescue-sentence" value={extraPlans||activeParsed.rawText} onChange={event=>setExtraPlans(event.target.value)}/><button type="button" className="secondary" disabled={busy} onClick={reparseSentence}>{busy?"正在解析……":"用 AI 重新理解"}</button></div></details>
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
            <p className="muted">{activeParsed.activityMentions.length ? `已识别 ${activeParsed.activityMentions.length} 项待确认安排，请补齐下方缺失信息。` : "请补充今天已有的安排。"}</p>
          )}
          {missing.has("existingPlans") && (
            <div className="field" style={{ marginTop: 18 }}>
              <label htmlFor="missing-plans">
                请补充至少一项今天已有的安排
              </label>
              <textarea
                id="missing-plans"
                value={extraPlans}
                onChange={(event) => setExtraPlans(event.target.value)}
                placeholder="例如：19 点已预订晚餐"
              />
              <button type="button" className="secondary" onClick={addPlans}>
                识别补充安排
              </button>
            </div>
          )}
          {activeParsed.existingPlans.length > 0 && (
            <details className="advanced-details" style={{ marginTop: 18 }}>
              <summary>修改从文本中识别的安排</summary>
              <div className="stop-list" style={{ marginTop: 16 }}>
                {activeParsed.existingPlans.map((item, index) => (
                  <div className="stop-editor" key={item.id}>
                    <div className="stop-editor-heading">
                      <b>识别结果 {index + 1}</b>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`删除识别结果 ${index + 1}`}
                        onClick={() =>
                          (() => {
                            const lockedEvent = activeSession.snapshot.itinerary.find((event) => event.id === item.id);
                            if (lockedEvent?.locked && !window.confirm("这是一项固定安排。确定要删除吗？")) return;
                            if (lockedEvent?.locked) setRemovedLockedIds((current) => [...new Set([...current, lockedEvent.id])]);
                            updateParsed({
                              ...activeParsed,
                              existingPlans: activeParsed.existingPlans.filter((candidate) => candidate.id !== item.id),
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
                            updateParsed({
                              ...activeParsed,
                              existingPlans: activeParsed.existingPlans.map(
                                (candidate) =>
                                  candidate.id === item.id
                                    ? { ...candidate, name: event.target.value }
                                    : candidate,
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`confirm-start-${item.id}`}>开始</label>
                        <input
                          id={`confirm-start-${item.id}`}
                          type="time"
                          value={item.startTime}
                          onChange={(event) =>
                            updateParsed({
                              ...activeParsed,
                              existingPlans: activeParsed.existingPlans.map(
                                (candidate) =>
                                  candidate.id === item.id
                                    ? {
                                        ...candidate,
                                        startTime: event.target.value,
                                      }
                                    : candidate,
                              ),
                            })
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
                            updateParsed({
                              ...activeParsed,
                              existingPlans: activeParsed.existingPlans.map(
                                (candidate) =>
                                  candidate.id === item.id
                                    ? {
                                        ...candidate,
                                        endTime: event.target.value,
                                      }
                                    : candidate,
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`confirm-location-${item.id}`}>
                          地点
                        </label>
                        <input
                          id={`confirm-location-${item.id}`}
                          value={item.location}
                          onChange={(event) =>
                            updateParsed({
                              ...activeParsed,
                              existingPlans: activeParsed.existingPlans.map(
                                (candidate) =>
                                  candidate.id === item.id
                                    ? {
                                        ...candidate,
                                        location: event.target.value,
                                      }
                                    : candidate,
                              ),
                            })
                          }
                        />
                      </div>
                      <label className="interest fixed-plan">
                        <Checkbox
                          checked={item.locked}
                          onCheckedChange={(checked) =>
                            updateParsed({
                              ...activeParsed,
                              existingPlans: activeParsed.existingPlans.map(
                                (candidate) =>
                                  candidate.id === item.id
                                    ? { ...candidate, locked: Boolean(checked) }
                                    : candidate,
                              ),
                            })
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
          {activeParsed.activityMentions.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <h2>需要你确认的活动提及</h2>
              <p className="muted">
                这些内容的角色或时间还不完整，所以没有自动写入行程。
              </p>
              <div className="stop-list" style={{ marginTop: 16 }}>
                {activeParsed.activityMentions.map((mention, index) => (
                  <div className="stop-editor" key={mention.id}>
                    <div className="stop-editor-heading">
                      <b>待确认 {index + 1} · {mention.sourceText}</b>
                      <span>{mention.locked==="yes"?"固定预约":"待确认"}</span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`忽略活动提及 ${index + 1}`}
                        onClick={() =>
                          updateParsed({
                            ...activeParsed,
                            activityMentions: activeParsed.activityMentions.filter(
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
                            updateParsed({
                              ...activeParsed,
                              activityMentions: activeParsed.activityMentions.map(
                                (item) =>
                                  item.id === mention.id
                                    ? { ...item, name: event.target.value }
                                    : item,
                              ),
                            })
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
                            updateParsed({
                              ...activeParsed,
                              activityMentions: activeParsed.activityMentions.map(
                                (item) =>
                                  item.id === mention.id
                                    ? { ...item, startTime: event.target.value || null }
                                    : item,
                              ),
                            })
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
                            updateParsed({
                              ...activeParsed,
                              activityMentions: activeParsed.activityMentions.map(
                                (item) =>
                                  item.id === mention.id
                                    ? { ...item, endTime: event.target.value || null }
                                    : item,
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`mention-location-${mention.id}`}>地点</label>
                        <input
                          id={`mention-location-${mention.id}`}
                          value={mention.location ?? ""}
                          onChange={(event) =>
                            updateParsed({
                              ...activeParsed,
                              activityMentions: activeParsed.activityMentions.map(
                                (item) =>
                                  item.id === mention.id
                                    ? { ...item, location: event.target.value || null }
                                    : item,
                              ),
                            })
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
            <input id="rescue-city" defaultValue={activeSession.snapshot.trip.destination} onBlur={event=>{
              if(event.target.value.trim())setSession(saveSession({...loadSession(),snapshot:{...loadSession().snapshot,trip:{...loadSession().snapshot.trip,destination:event.target.value.trim()}}}));
            }}/>
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
            <p className="muted">{activeParsed.activityMentions.some(x=>x.locked==="yes")?`已识别待确认预约：${activeParsed.activityMentions.filter(x=>x.locked==="yes").map(x=>`${x.startTime??"时间待补充"} ${x.name}`).join("；")}。补齐信息后会保留。`:"暂未识别到固定安排。"}</p>
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
            {parsed.existingPlans.length > 0 &&
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
              确认后查询高德地点和路线，必要时查询天气。体力、预算等个人信息未提供时保持为空。
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function ResultFlow() {
  const { session, setSession, error, setError } = useRealSession();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [analysisOpen, setAnalysisOpen] = useState(false);
  if (!session) return <Loading error={error} />;
  const pending = session.flowStage === "PLAN_READY" ? session.pendingPlan : null;
  if (!pending || pending.result.mode !== "live") return <div className="mobile-workspace empty-screen"><span className="eyebrow">方案</span><h1>还没有待确认的方案。</h1><p className="muted">先从首页告诉我今天发生了什么。</p><Link className="primary full" href="/">返回首页 <ArrowRight size={17} /></Link></div>;
  const { result, base, request } = pending;
  const activePending = pending;
  const plan = result.plan;
  const impact = pending.impactAnalysis ?? result.impactAnalysis;
  const activeSession = session;
  const currentParsed = pending.parsedInput ? ParsedUserInputSchema.parse(pending.parsedInput) : null;

  async function regenerateFromDraft(nextParsed: ParsedUserInput, removedLockedIds: string[] = [], removedEventIds: string[] = [], adjustments: ReplanningRequest["adjustments"] = []) {
    const confirmedDraft = confirmedDraftFromParsed(base, nextParsed, nextParsed.closedPlaceIds, removedLockedIds, removedEventIds);
    const response = await fetch("/api/assist", { method: "POST", headers: await requestHeaders(), body: JSON.stringify({ snapshot: base, rawText: nextParsed.rawText, confirmedDraft, adjustments, userAnswers: { venueSelections: nextParsed.worldOptions?.selectedPois } }) });
    const body = (await response.json()) as AssistBody;
    if (!response.ok) throw new Error(body.error ?? "暂时无法重新安排。");
    if (body.status !== "ready" || !body.result || !body.base || !body.request || !body.parsedInput) throw new Error(body.missingFacts?.[0]?.reason ?? "请先补充这次调整需要的信息。");
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
        setSession(saveSession({ ...activeSession, flowStage: "RESCUE_CONFIRM", pendingPlan: null }));
        window.location.assign("/rescue");
        return;
      }
      if (!currentParsed) throw new Error("当前调整草稿已过期，请返回编辑页重新确认。");
      const nextParsed = option.action === "remove_event" ? { ...currentParsed, existingPlans: currentParsed.existingPlans.filter(item => item.id !== option.eventId) } : { ...currentParsed, existingPlans: currentParsed.existingPlans.map(item => item.id === option.eventId ? { ...item, endTime: null, durationMinutes: option.suggestedDuration ?? 60 } : item) };
      const removedLockedIds = option.action === "remove_event" && base.itinerary.some(event => event.id === option.eventId && event.locked) ? [option.eventId] : [];
      await regenerateFromDraft(nextParsed, removedLockedIds, option.action === "remove_event" ? [option.eventId] : []);
    } catch (cause) { setError(errorText(cause)); setBusy(false); }
  }

  async function adjustPlan(adjustment: "less_plan" | "more_plan") {
    if (!currentParsed) { setError("当前方案草稿已过期，请重新描述变化。"); return; }
    setBusy(true); setError("");
    try { await regenerateFromDraft(currentParsed, [], [], [adjustment]); } catch (cause) { setError(errorText(cause)); setBusy(false); }
  }

  function chooseCandidate(candidate: NonNullable<typeof result.candidatePlans>[number]) {
    if (!candidate.plan || !candidate.feasible) return;
    const nextResult = AgentResultSchema.parse({ ...result, id: result.id, ok: true, plan: candidate.plan, message: candidate.tradeOff });
    const updated = saveSession({ ...activeSession, pendingPlan: { base: activePending.base, request: activePending.request, accepted: false, parsedInput: activePending.parsedInput, impactAnalysis: activePending.impactAnalysis, result: nextResult } });
    setSession(updated);
  }

  async function accept() {
    if (!plan) return;
    setBusy(true); setError("");
    try {
      const latest = loadSession();
      if (latest.snapshot.revision !== base.revision) throw new Error("原行程已发生变化，请重新生成方案。");
      if (result.context.world && Date.now() - Date.parse(result.context.world.currentTime.confirmedAt) > 300000) throw new Error("距离确认时间较久，请重新生成方案。");
      const response = await fetch("/api/validate", { method: "POST", headers: await requestHeaders(), body: JSON.stringify({ snapshot: base, request, mode: result.mode, confirmation: { status: "confirmed", confirmedAt: new Date().toISOString() }, plan }) });
      const checked = (await response.json()) as { ok?: boolean };
      if (!response.ok || !checked.ok) throw new Error("方案已不再满足当前安排，请重新生成。");
      const next = SnapshotSchema.parse({ ...base, state: request.currentState, itinerary: [...latest.snapshot.itinerary.filter(event => event.status === "completed"), ...plan.events], revision: latest.snapshot.revision + 1 });
      await saveTrip(next, latest.snapshot.revision);
      const updated = saveSession({ ...loadSession(), snapshot: { ...next, mode: "user" }, flowStage: "HAS_ITINERARY", rawInput: "", parsedInput: null, lastDisruption: request, pendingPlan: null });
      setSession(updated); await logEvent("replan_accepted", { planId: result.id, mode: "real" }); setNotice("方案已接受"); window.location.assign("/trip");
    } catch (cause) { setError(errorText(cause)); setBusy(false); }
  }

  const baseMap = new Map(base.itinerary.map(event => [event.id, event]));
  const statusOf = (event: ItineraryEvent) => {
    const original = baseMap.get(event.id);
    if (!original) return { label: "新增", tone: "new" };
    const changed = original.startTime !== event.startTime || original.endTime !== event.endTime || original.location !== event.location || original.travelTimeFromPrevious !== event.travelTimeFromPrevious;
    return changed ? { label: "调整", tone: "adjusted" } : { label: "保留", tone: "kept" };
  };
  const originalCount = base.itinerary.filter(event => event.status !== "completed").length;
  const retainedCount = plan ? plan.events.filter(event => baseMap.has(event.id)).length : 0;
  const impactLabel = !plan ? "需要再调整" : plan.removedEvents.length + plan.movedEvents.length > 2 ? "较高" : plan.removedEvents.length + plan.movedEvents.length > 0 ? "中等" : "低";
  const conflicts = result.conflicts ?? [];
  const options = result.resolutionOptions ?? [];
  const candidatePlans = (result.candidatePlans ?? []).filter(candidate => candidate.plan && candidate.feasible);

  return (
    <div className="mobile-workspace plan-screen">
      <div className="plan-heading"><span className="eyebrow">方案等待你的确认</span><h1>今天建议这样调整</h1><p>{plan?.summary ?? result.message}</p></div>
      {error && <div className="error-box" role="alert">{userFacingPlanningMessage(error)}</div>}
      {plan && <div className="plan-summary-card"><div><b>保留 {retainedCount} / {originalCount} 个原安排</b><p>{plan.summary}</p></div><span className="impact-chip">影响程度：{impactLabel}</span></div>}
      {(!result.ok || !plan || conflicts.length > 0) && <section className="conflict-panel" aria-live="polite"><div><span className="eyebrow">需要换一种安排</span><h2>有一处时间需要重新协调</h2><p>{conflicts[0]?.message ?? "当前路线或时间无法同时满足，我们保留了你的原行程。"}</p></div><div className="conflict-options">{options.map(option => <button key={option.id} type="button" disabled={busy} onClick={() => void applyResolutionOption(option)}>{option.label}<ChevronRight size={15} /></button>)}</div>{!options.length && <Link className="secondary full" href="/rescue">重新描述这次变化</Link>}</section>}
      {plan && <>
        <div className="plan-toolbar"><span>按时间顺序</span><Drawer open={analysisOpen} onOpenChange={setAnalysisOpen}><DrawerTrigger asChild><button type="button" className="text-action">查看我的情况分析 <ChevronRight size={15} /></button></DrawerTrigger><DrawerContent className="analysis-drawer"><DrawerHeader><DrawerTitle>我的情况分析</DrawerTitle><DrawerDescription>这次变化是怎么影响今天的</DrawerDescription></DrawerHeader><div className="drawer-scroll"><div className="analysis-quote">“{request.freeText}”</div><div className="analysis-block"><span className="eyebrow">识别到的变化</span><p>{result.context.disruption.freeText || request.freeText}</p></div><div className="analysis-block"><span className="eyebrow">受到影响的安排</span><p>{impact?.affectedActivities.length ? impact.affectedActivities.map(id => baseMap.get(id)?.name ?? id).join("、") : "暂未发现明确受影响的安排。"}</p></div><div className="analysis-block"><span className="eyebrow">为什么这样处理</span>{plan.removedEvents.length ? plan.removedEvents.map(item => <p className="reason-row" key={item.eventId}><b>{item.name}</b><span>{item.reason}</span></p>) : <p>尽量保留了原安排，把变化留在更有弹性的时间里。</p>}</div><div className="analysis-block"><span className="eyebrow">被留下的空白</span><p>{impact?.availableTimeWindows.length ? impact.availableTimeWindows.map(item => `${item.startTime}–${item.endTime}`).join("、") : "今天没有额外空档。"}</p></div></div><DrawerClose className="drawer-close">知道了</DrawerClose></DrawerContent></Drawer></div>
        <div className="plan-timeline">{plan.events.map(event => { const status = statusOf(event); return <div className="plan-event" key={event.id}><div className="plan-event-time"><b>{event.startTime}</b><small>{event.endTime === event.startTime ? "时间待定" : event.endTime}</small></div><div className={`plan-event-line ${status.tone}`}><span /></div><div className={`plan-event-card ${status.tone}`}><div className="plan-event-top"><h2>{displayPlace(event.name)}</h2><span className={`status-pill ${status.tone}`}>{status.label}</span></div><p><MapPin size={14} /> {displayPlace(event.location)}</p><small>{event.travelMode ? ({ WALKING: "步行", TRANSIT: "公共交通", DRIVING: "打车" } as Record<string, string>)[event.travelMode] : "路线待查询"} · {eventDurationLabel(event)}</small></div></div>; })}</div>
        {candidatePlans.length > 1 && <section className="candidate-section"><div className="section-title"><h2>其他方案</h2><span>{candidatePlans.length} 个可选</span></div><div className="candidate-list">{candidatePlans.map((candidate, index) => { const selected = candidate.plan?.summary === plan.summary && candidate.plan?.events.length === plan.events.length; return <button type="button" key={candidate.id} className={`candidate-card ${selected ? "selected" : ""}`} onClick={() => chooseCandidate(candidate)}><span><b>{candidate.title || `方案 ${index + 1}`}</b><small>{candidate.tradeOff}</small></span>{selected ? <Check size={18} /> : <ChevronRight size={18} />}</button>; })}</div></section>}
      </>}
      {!notice && plan && <div className="plan-actions"><button className="primary full" disabled={busy} onClick={() => void accept()}>{busy ? "正在确认…" : "接受方案"}<Check size={17} /></button><div className="action-pair"><button className="secondary" disabled={busy} onClick={() => void adjustPlan("less_plan")}>再少安排点</button><button className="secondary" disabled={busy} onClick={() => void adjustPlan("more_plan")}>再多安排点</button></div>{candidatePlans.length > 1 && <button className="text-action centered" type="button" onClick={() => document.querySelector<HTMLButtonElement>(".candidate-section .candidate-card")?.focus()}>看其他方案</button>}</div>}
      {notice && <div className="success-box" role="status">{notice}</div>}
    </div>
  );
}

export function MineFlow() {
  const { session, error } = useRealSession();
  const [rescueCount, setRescueCount] = useState(0);
  const [lastRescue, setLastRescue] = useState<string | null>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const events = JSON.parse(localStorage.getItem("travel-analytics") ?? "[]") as Array<{ name?: string; created_at?: string }>;
        const accepted = events.filter(event => event.name === "replan_accepted").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setRescueCount(accepted.length);
        setLastRescue(accepted[0]?.created_at ?? null);
      } catch {
        setRescueCount(0);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);
  if (!session) return <Loading error={error} />;
  const displayName = session.snapshot.profile.id === "local-traveler" ? "Ying Long" : session.snapshot.profile.id;
  const latest = lastRescue ? new Date(lastRescue).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }) : "还没有成功救援记录";
  const settings = ["默认偏好", "历史救援记录", "数据与隐私", "关于接住你"];
  return <div className="mobile-workspace mine-screen"><div className="mine-heading"><span className="eyebrow">个人设置</span><h1>我的</h1></div><section className="profile-card"><div className="avatar">{displayName.slice(0, 1).toUpperCase()}</div><div><h2>{displayName}</h2><p>已被接住 {rescueCount} 次</p></div><Sparkles size={22} /></section><section className="mine-stat"><div><span className="eyebrow">最近一次救援</span><b>{latest}</b></div><Settings2 size={20} /></section><div className="settings-list">{settings.map(label => <button type="button" className="settings-row" key={label}><span>{label}</span><ChevronRight size={18} /></button>)}</div><p className="mine-footnote">你的行程只保存在此设备的浏览器里。</p></div>;
}

export function SessionWorkflow({ page }: { page: string }) {
  if (page === "home") return <HomeFlow />;
  if (page === "onboarding") return <OnboardingFlow />;
  if (page === "trip") return <TripFlow />;
  if (page === "rescue") return <RescueFlow />;
  if (page === "result") return <ResultFlow />;
  if (page === "me") return <MineFlow />;
  return <HomeFlow />;
}

export function Workflow({ page }: { page: string }) {
  return <SessionWorkflow page={page} />;
}

export function HomeRescue() {
  return <HomeFlow />;
}
