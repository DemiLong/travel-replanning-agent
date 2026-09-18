"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CloudRain,
  Footprints,
  LockKeyhole,
  MapPin,
  ShieldCheck,
  Trash2,
  Wallet,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { demo } from "@/data/demo";
import {
  thailandDestinationLabels,
  thailandDestinations,
} from "@/data/thailand";
import { LocationService } from "@/services/world/location-service";
import { RealWorldContextSchema, type RealWorldContext, type TravelMode } from "@/types/world";
import { confirmParsedInput } from "@/services/input-parser";
import {
  loadSession,
  logEvent,
  recordResult,
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
import type { MissingFact } from "@/types";

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

const quickReasons: Array<{
  reason?: ReplanningRequest["reason"];
  label: string;
  text: string;
  create?: boolean;
}> = [
  { reason: "weather", label: "下雨了", text: "现在下雨了。" },
  { reason: "late", label: "我快迟到了", text: "我现在快迟到了。" },
  { reason: "tired", label: "我太累了", text: "我现在太累了。" },
  { reason: "closed", label: "有个地方关门了", text: "有个地方关门了。" },
  { label: "我还没有安排今天", text: "", create: true },
];

const placeLabels: Record<string, string> = {
  Siam: "暹罗",
  "Old Town": "老城",
  Riverside: "河畔",
  Chinatown: "唐人街",
  Sukhumvit: "素坤逸",
  Silom: "是隆",
  "Grand Palace": "大皇宫",
  "Wat Arun": "郑王庙",
  "Wat Pho": "卧佛寺",
  ICONSIAM: "暹罗天地",
  "Dinner Reservation": "晚餐预约",
  "Siam lunch stop": "暹罗午餐",
  "Hotel rest": "酒店休息",
  "Siam unwind massage": "暹罗舒缓按摩",
};

const displayPlace = (value: string) => placeLabels[value] ?? value;
const displayDestination = (value: string) =>
  thailandDestinationLabels[value] ?? value;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请再试一次。";

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
            <small>{event.durationSource === "unknown" ? "结束时间未提供" : event.endTime}</small>
          </div>
          <div className="event-marker">
            {event.locked ? <LockKeyhole size={14} /> : <span />}
          </div>
          <div className="event-body">
            <div className="event-title">
              <h3>{displayPlace(event.name)}</h3>
              <span className={`badge ${event.locked ? "locked" : ""}`}>
                {event.locked ? "已锁定" : "待进行"}
              </span>
            </div>
            <p>
              <MapPin size={13} /> {displayPlace(event.location)} · {" "}
              {event.estimatedCostKnown === false
                ? "费用未提供"
                : `฿${event.estimatedCost}`}
            </p>
            {event.travelMode && <p>{({WALKING:"步行",TRANSIT:"公共交通",DRIVING:"驾车 / 打车建议"})[event.travelMode]} · 预计 {event.travelTimeFromPrevious} 分钟</p>}
            {event.durationSource === "suggested" && <small>停留时长为方案建议</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

function parsedToEvent(
  item: ParsedUserInput["existingPlans"][number],
  snapshot: Snapshot,
): ItineraryEvent {
  const existing = snapshot.itinerary.find(
    (event) =>
      event.startTime === item.startTime &&
      event.name.trim().toLowerCase() === item.name.trim().toLowerCase(),
  );
  if (existing)
    return {
      ...existing,
      endTime: item.endTime,
      location: item.location,
      estimatedCost: item.estimatedCost,
      estimatedCostKnown: item.estimatedCostKnown,
      locked: item.locked,
      status: item.locked ? "locked" : existing.status,
    };
  return {
    id: `event-${item.id}`,
    placeId: `custom-${item.id}`,
    name: item.name,
    category: "user activity",
    startTime: item.startTime,
    endTime: item.endTime,
    location: item.location,
    status: item.locked ? "locked" : "planned",
    locked: item.locked,
    estimatedCost: item.estimatedCost,
    estimatedCostKnown: item.estimatedCostKnown,
    indoorOutdoor: "mixed",
    openingTime: null,
    closingTime: null,
    travelTimeFromPrevious: null,
    reason: item.locked
      ? "这是用户确认需要保留的固定安排。"
      : "这是用户确认的原有安排。",
    constraint: item.locked ? "Locked plan" : "Original itinerary",
  };
}

function mergePlans(
  snapshot: Snapshot,
  parsed: ParsedUserInput,
): ItineraryEvent[] {
  const next = [...snapshot.itinerary];
  for (const item of parsed.existingPlans) {
    const converted = parsedToEvent(item, snapshot);
    const index = next.findIndex((event) => event.id === converted.id);
    if (index >= 0) next[index] = converted;
    else next.push(converted);
  }
  return next.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

function normalizeParsed(
  parsed: ParsedUserInput,
  baseItineraryCount: number,
  closedPlaceIds: string[] = [],
) {
  const missing = parsed.missingFacts.filter(
    (field) =>
      !field.startsWith("activity:") && ![
        "existingPlans",
        "disruptionOrOptimize",
        "currentLocation",
        "closedPlace",
        "activityDecision",
        "activityDetails",
      ].includes(field),
  );
  if (baseItineraryCount + parsed.existingPlans.length + parsed.activityMentions.length === 0)
    missing.push("existingPlans");
  if (!parsed.disruptions.length && parsed.intent!=="optimize") missing.push("disruptionOrOptimize");
  if (!parsed.context.currentLocation?.trim()) missing.push("currentLocation");
  if (
    parsed.disruptions.some((item) => item.kind === "closed") &&
    closedPlaceIds.length === 0
  )
    missing.push("closedPlace");
  if (parsed.activityMentions.length) missing.push("activityDecision");
  for(const mention of parsed.activityMentions){
    if(!mention.location)missing.push(`activity:${mention.id}:location`);
    if(!mention.startTime)missing.push(`activity:${mention.id}:startTime`);
    if(!mention.endTime&&!mention.durationMinutes)missing.push(`activity:${mention.id}:duration`);
  }
  if (parsed.existingPlans.some((item) => !item.location.trim()))
    missing.push("activityDetails");
  return ParsedUserInputSchema.parse({
    ...parsed,
    missingFacts: [...new Set(missing)],
    status: missing.length ? "needs_input" : "draft",
  });
}

export function HomeFlow() {
  const { session, error, setError } = useRealSession();
  const [raw, setRaw] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [missingFacts, setMissingFacts] = useState<MissingFact[]>([]);
  const [assistAnswers, setAssistAnswers] = useState<{ destination?: string; currentLocation?: string; travelMode?: TravelMode; venueSelections?:Record<string,string> }>({});
  const [followUp, setFollowUp] = useState("");
  const [ambiguities, setAmbiguities] = useState<RealWorldContext["ambiguities"]>([]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (session && !ready) {
        setRaw(session.rawInput);
        setAssistAnswers({venueSelections:session.parsedInput?.worldOptions?.selectedPois??{},travelMode:session.lastDisruption?.worldOptions?.travelMode});
        setReady(true);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [session, ready]);
  if (!session) return <Loading error={error} />;
  const activeSession = session;
  if (session.flowStage === "PLAN_READY" && session.pendingPlan)
    return (
      <div className="workspace rescue-workspace">
        <div className="rescue-intro">
          <span className="eyebrow">上次操作尚未完成</span>
          <h1>调整方案正在等你确认。</h1>
          <p>你的原行程和输入都还在，可以继续查看，也可以重新描述变化。</p>
        </div>
        <div className="card rescue-card">
          <div className="form-actions">
            <Link className="primary" href="/result">
              继续确认上次方案 <ArrowRight size={18} />
            </Link>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                saveSession({
                  ...activeSession,
                  flowStage: "RESCUE_INPUT",
                  pendingPlan: null,
                });
                location.reload();
              }}
            >
              重新描述变化
            </button>
          </div>
          <div className="form-actions home-secondary-actions">
            <Link className="secondary" href="/onboarding">
              创建今天的行程
            </Link>
            <Link className="text-button" href="/demo">
              查看示例
            </Link>
          </div>
        </div>
      </div>
    );
  const hasItinerary = session.snapshot.itinerary.length > 0;
  const hasDraft =
    Boolean(session.rawInput.trim()) &&
    ["RESCUE_INPUT", "RESCUE_CONFIRM"].includes(session.flowStage);

  function chooseQuick(item: (typeof quickReasons)[number]) {
    if (item.create) {
      window.location.assign("/onboarding");
      return;
    }
    setRaw(item.text);
    saveFlowDraft(item.text, null, "RESCUE_INPUT");
  }

  async function submitAssist(event?: FormEvent, selection?:{field:string;poiId:string}) {
    event?.preventDefault();
    if (!raw.trim()) {
      setError("请先写下今天原本的安排、当前变化，或选择一个快捷场景。");
      return;
    }
    setBusy(true);
    setError("");
    const text=followUp.trim() ? `${raw}\n补充回答（${missingFacts[0]?.reason??"补充说明"}）：${followUp.trim()}` : raw;
    const answers=selection?{...assistAnswers,venueSelections:{...assistAnswers.venueSelections,[selection.field]:selection.poiId}}:assistAnswers;
    setRaw(text);setFollowUp("");setAssistAnswers(answers);
    saveFlowDraft(text,activeSession.parsedInput,"RESCUE_INPUT");
    try {
      let browserLocation: Awaited<ReturnType<LocationService["getCurrentPosition"]>> | undefined;
      // Parse and resolve text first. Request GPS once only if the server
      // cannot establish an origin, before asking the traveler to type one.
      let response = await fetch("/api/assist", {
        method: "POST",
        headers: await requestHeaders(),
        body: JSON.stringify({ snapshot: activeSession.snapshot, rawText: text, userAnswers: answers, ...(browserLocation ? { browserLocation } : {}) }),
      });
      let body = (await response.json()) as any;
      if(response.ok && body.status==="needs_input" && body.missingFacts?.[0]?.field==="currentLocation" && !body.ambiguities?.length && !browserLocation){
        try{browserLocation=await new LocationService().getCurrentPosition();}catch{/* Show the single question if location cannot be obtained. */}
        if(browserLocation){
          response=await fetch("/api/assist",{method:"POST",headers:await requestHeaders(),body:JSON.stringify({snapshot:activeSession.snapshot,rawText:text,userAnswers:answers,browserLocation})});
          body=await response.json();
        }
      }
      if (!response.ok) throw new Error(body.error ?? "暂时无法接住这次变化，请稍后重试。");
      if (body.status === "needs_input") {
        setMissingFacts(body.missingFacts ?? []);
        setAmbiguities(body.ambiguities ?? []);
        setAssistAnswers(current=>({...current,venueSelections:body.parsedInput?.worldOptions?.selectedPois??current.venueSelections}));
        saveFlowDraft(text, body.parsedInput, "RESCUE_INPUT");
        setBusy(false);
        return;
      }
      if (body.status !== "ready") throw new Error(body.error ?? "真实信息暂时不可用，请稍后重试。");
      const result = AgentResultSchema.parse(body.result);
      savePendingPlan({ result, base: SnapshotSchema.parse(body.base), request: ReplanningRequestSchema.parse(body.request), accepted: false, parsedInput: ParsedUserInputSchema.parse(body.parsedInput), impactAnalysis: body.impactAnalysis }, ReplanningRequestSchema.parse(body.request));
      window.location.assign("/result");
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  return (
    <div className="workspace rescue-workspace">
      <div className="rescue-intro">
        <span className="eyebrow">
          {hasItinerary ? "从你真实的今日行程出发" : "先说今天，再说变化"}
        </span>
        <h1>告诉我今天发生了什么？</h1>
        <p>把原计划和现在发生的情况直接告诉我，不需要整理。</p>
      </div>
      <form className="card rescue-card" onSubmit={submitAssist}>
        {hasDraft && (
          <div className="success-box" role="status">
            上次输入已保存在本浏览器，可以继续确认。
          </div>
        )}
        <div className="quick-reasons" aria-label="常见场景">
          {quickReasons.map((item) => (
            <button
              key={item.label}
              type="button"
              className="quick-reason"
              onClick={() => chooseQuick(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="field rescue-field">
          <label htmlFor="home-input">告诉我今天的安排和现在发生的变化</label>
          <small className="input-hint">
            例如：10 点大皇宫，19 点已预订晚餐。现在下雨了，我在暹罗，希望保留晚餐。
          </small>
          <textarea
            id="home-input"
            value={raw}
            maxLength={4000}
            onChange={(event) => {
              setRaw(event.target.value);
              saveFlowDraft(event.target.value, null, "RESCUE_INPUT");
            }}
            placeholder="写下今天已有的安排、当前变化、想保留的事项或当前位置"
          />
          <small className="muted">
            系统会结合真实地点和路线安排今天；只有关键信息无法确定时才补问。
          </small>
        </div>
        {error && (
          <div className="error-box" role="alert">
            <p>{error}</p>
            <button type="button" className="secondary" disabled={busy} onClick={() => void submitAssist()}>
              重新尝试
            </button>
          </div>
        )}
        {missingFacts.length > 0 && (
          <div className="card" role="dialog" aria-label="补充必要信息">
            <h2>还需要确认这一点</h2>
            <div className="field"><label htmlFor="assist-follow-up">{missingFacts[0].reason}</label><input id="assist-follow-up" value={followUp} onChange={event=>setFollowUp(event.target.value)} placeholder="直接用自己的话回答即可" /></div>
            {ambiguities.filter(a=>a.field===missingFacts[0].field).flatMap(a=>a.candidates.map(p=><button key={p.poiId} type="button" className="secondary" disabled={busy} onClick={()=>void submitAssist(undefined,{field:a.field,poiId:p.poiId})}>{p.name} · {p.address}</button>))}
            <button type="button" className="primary" disabled={busy} onClick={() => submitAssist()}>{busy ? "正在接住你的行程……" : "继续安排今天"}</button>
          </div>
        )}
        <div className="form-actions rescue-actions">
          <button className="primary" disabled={busy}>
            {busy
              ? "AI 正在拆解事实……"
              : hasDraft
              ? "继续完成上次操作"
              : "帮我重新安排今天"}
            <ArrowRight size={18} />
          </button>
        </div>
        <div className="form-actions home-secondary-actions">
          <Link className="secondary" href="/onboarding">
            创建今天的行程
          </Link>
          <Link className="text-button" href="/demo">
            查看示例
          </Link>
        </div>
        <p className="small-note">
          当前行程保存在本浏览器。登录后跨设备同步将在后续版本提供。
        </p>
      </form>
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
  }, [session, initialized]);
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
      if (
        items.some(
          (item) => !item.name.trim() || item.endTime <= item.startTime,
        )
      )
        throw new Error("请检查活动名称和起止时间。");
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
    <div className="workspace setup-workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">首次创建今日行程</span>
          <h1>把已有安排放进今天。</h1>
          <p>只填写当前任务需要的信息；预算与偏好都可以跳过。</p>
        </div>
      </div>
      <form className="card form-card setup-form" onSubmit={submit}>
        <section className="setup-section">
          <div className="section-heading">
            <span>1</span>
            <div>
              <h2>今天在哪里？</h2>
              <p>目的地、日期、当前时间和地点用于判断可执行性。</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="destination">所在城市（必填）</label>
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
              <label htmlFor="day-date">日期（必填）</label>
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
              <label htmlFor="current-time">当前时间（必填）</label>
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
              <label htmlFor="current-location">当前位置（必填）</label>
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
                placeholder="例如：暹罗、酒店或车站"
              />
            </div>
          </div>
        </section>
        <section className="setup-section">
          <div className="section-heading">
            <span>2</span>
            <div>
              <h2>今天已有的安排</h2>
              <p>每项以时间开头，解析后可以逐项修改。</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="itinerary-input">粘贴或输入行程（必填）</label>
            <textarea
              id="itinerary-input"
              value={raw}
              onChange={(event) => {
                setRaw(event.target.value);
                persist(snapshot, event.target.value);
              }}
              placeholder="10 点大皇宫，12:30 午餐，19 点已预订晚餐"
            />
          </div>
          <button
            type="button"
            className="secondary"
            disabled={parsing}
            onClick={parsePlans}
          >
            {parsing ? "AI 正在解析……" : "解析这份行程"}
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
                        required
                        value={item.endTime}
                        onChange={(event) =>
                          setItems((current) =>
                            current.map((candidate) =>
                              candidate.id === item.id
                                ? { ...candidate, endTime: event.target.value }
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
          <summary>预算与偏好（可选）</summary>
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
            创建今天的行程 <ArrowRight size={18} />
          </button>
          <Link className="secondary" href="/">
            返回首页
          </Link>
        </div>
        <p className="small-note">
          当前行程保存在本浏览器。登录后跨设备同步将在后续版本提供。
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
      <div className="workspace narrow">
        <h1>今天还没有行程。</h1>
        <p className="muted">直接告诉我原计划和今天发生的变化，就能开始安排。</p>
        <Link className="primary" href="/">
          告诉我今天发生了什么 <ArrowRight size={17} />
        </Link>
      </div>
    );
  const currentMinutes = snapshot.state.currentTime.split(":").map(Number).reduce((h, m) => h * 60 + m, 0);
  const nextEvent = snapshot.itinerary.find((event) => event.status !== "completed" && event.startTime.split(":").map(Number).reduce((h, m) => h * 60 + m, 0) >= currentMinutes);
  return (
    <div className="workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {snapshot.state.currentDate} ·{" "}
            {displayDestination(snapshot.trip.destination)}
          </span>
          <h1>我的今日行程</h1>
          <p>计划可以改变，固定安排会在调整前明确确认。</p>
        </div>
        <Link className="secondary" href="/onboarding">
          编辑行程
        </Link>
      </div>
      <div className="trip-grid">
        <section className="card itinerary-card">
          <div className="card-heading">
            <h2>今天的安排</h2>
            <span>{snapshot.itinerary.length} 项</span>
          </div>
          <Timeline events={snapshot.itinerary} />
        </section>
        <aside>
          <div className="state-card">
            <span className="eyebrow">此时此地</span>
            <h2>{snapshot.state.currentTime}</h2>
            <div className="state-location">
              <MapPin size={16} />{" "}
              {displayPlace(snapshot.state.currentLocation)}
            </div>
            <div className="state-tiles">
              <div>
                <CloudRain />
                <b>{snapshot.state.weather ?? "未提供"}</b>
                <small>天气</small>
              </div>
              <div>
                <Footprints />
                <b>{snapshot.state.energyLevel ?? "未提供"}</b>
                <small>体力</small>
              </div>
            </div>
            <div className="budget-line">
              <Wallet size={17} />
              <span>剩余预算</span>
              <b>
                {snapshot.state.remainingBudget === undefined
                  ? "未提供"
                  : `฿${snapshot.state.remainingBudget}`}
              </b>
            </div>
            <div className="next-step" style={{ marginTop: 18 }}>
              <span className="eyebrow">下一步去哪里</span>
              {nextEvent ? <><h3>{displayPlace(nextEvent.location || nextEvent.name)}</h3><p>{nextEvent.startTime} · {nextEvent.travelTimeFromPrevious == null ? "路线待查询" : `预计 ${nextEvent.travelTimeFromPrevious} 分钟`}</p></> : <p className="muted">今天没有待执行安排。</p>}
            </div>
            <Link className="primary full" href="/rescue">
              今天发生了变化 <ArrowRight size={18} />
            </Link>
          </div>
          <p className="small-note">
            当前行程保存在本浏览器。登录后跨设备同步将在后续版本提供。
          </p>
        </aside>
      </div>
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
    setLocationTried(true);
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
  const [busy, setBusy] = useState(false);
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(async () => {
      if (session && !initialized) {
        const blank=ParsedUserInputSchema.parse({rawText:session.rawInput,intent:"rescue",existingPlans:[],disruptions:[],constraints:[],context:session.snapshot.state,contextSources:session.snapshot.stateSources,missingFacts:[],status:"draft",parser:"manual"});
        let initial=blank;
        try {
          initial=session.parsedInput?.parser!=="deterministic_fallback" && session.parsedInput ? session.parsedInput : session.rawInput.trim()?await parseWithModel(session.snapshot,session.rawInput):blank;
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
        setParsed({ ...initial, closedPlaceIds: restoredClosed });
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
      const parsedAddition = await parseWithModel(
        activeSession.snapshot,
        extraPlans,
      );
      if (!parsedAddition.existingPlans.length && !parsedAddition.activityMentions.length) {
        throw new Error("AI 没有识别到可确认的活动，请补充活动名称和时间。");
      }
      updateParsed({
        ...activeParsed,
        rawText: `${activeParsed.rawText}\n${extraPlans}`.trim(),
        existingPlans: [
          ...activeParsed.existingPlans,
          ...parsedAddition.existingPlans,
        ],
        activityMentions: [
          ...activeParsed.activityMentions,
          ...parsedAddition.activityMentions,
        ],
        parseWarnings: [
          ...activeParsed.parseWarnings,
          ...parsedAddition.parseWarnings,
        ],
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
      updateParsed({...next,worldOptions:activeParsed.worldOptions});setWorld(null);
    }catch(cause){setError(errorText(cause));}finally{setBusy(false);}
  }

  function promoteMention(
    mention: ParsedUserInput["activityMentions"][number],
  ) {
    if (!mention.name.trim() || !mention.startTime || !mention.location?.trim() || (!mention.endTime && !mention.durationMinutes)) {
      setError("已保留这项安排，请补充具体地点和结束时间（或时长）。");
      return;
    }
    const [hours, minutes] = mention.startTime.split(":").map(Number);
    const total = Math.min(
      23 * 60 + 59,
      hours * 60 + minutes + (mention.durationMinutes ?? 0),
    );
    const endTime =
      mention.endTime ??
      `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    updateParsed({
      ...activeParsed,
      existingPlans: [
        ...activeParsed.existingPlans,
        {
          id: `confirmed-${crypto.randomUUID()}`,
          name: mention.name.trim(),
          startTime: mention.startTime,
          endTime,
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
      const nextSnapshot = SnapshotSchema.parse({
        ...activeSession.snapshot,
        state: { ...activeSession.snapshot.state, ...confirmed.context },
        stateSources: confirmed.contextSources,
        itinerary: mergePlans(activeSession.snapshot, confirmed),
        revision: activeSession.snapshot.revision,
      });
      const savedConfirmation = saveSession({
        ...loadSession(),
        rawInput: confirmed.rawText,
        parsedInput: confirmed,
        flowStage: "RESCUE_CONFIRM",
      });
      setSession(savedConfirmation);
      const reason = confirmed.disruptions[0]?.kind ?? "optimize";
      const request = ReplanningRequestSchema.parse({
        reason,
        freeText: confirmed.rawText,
        currentState: nextSnapshot.state,
        closedPlaceIds: confirmed.closedPlaceIds,
        variation: 0,
        adjustments: [
          ...(/少走|减少步行|less walking/i.test(confirmed.rawText)
            ? (["less_walking"] as const)
            : []),
          ...(/省钱|降低花费|便宜|cheaper/i.test(confirmed.rawText)
            ? (["cheaper"] as const)
            : []),
          ...(/早点|提早结束|earlier/i.test(confirmed.rawText)
            ? (["earlier"] as const)
            : []),
          ...(/保留|别动|keep/i.test(confirmed.rawText)
            ? (["keep_stop"] as const)
            : []),
        ],
        stateSources: confirmed.contextSources,
        worldOptions: confirmed.worldOptions,
      });
      const grounding = await fetch("/api/world/context", {
        method: "POST", headers: await requestHeaders(),
        body: JSON.stringify({snapshot:nextSnapshot,request,mode:"live",confirmation:{status:"confirmed",confirmedAt:new Date().toISOString()}}),
      });
      const groundBody = await grounding.json();
      if (!grounding.ok) throw new Error((groundBody as {error?:string}).error ?? "真实世界数据不可用。");
      const grounded = RealWorldContextSchema.parse(groundBody);
      setWorld(grounded);
      if (grounded.status !== "ready") throw new Error("请确认下面的地点候选或补充信息。原文与安排已保留。");
      const response = await fetch("/api/replan", {
        method: "POST",
        headers: await requestHeaders(),
        body: JSON.stringify({
          snapshot: nextSnapshot,
          request,
          mode: "live",
          confirmation: {
            status: "confirmed",
            confirmedAt: new Date().toISOString(),
          },
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "暂时无法生成方案。");
      const result = AgentResultSchema.parse(body);
      await recordResult(result);
      savePendingPlan(
        { result, base: nextSnapshot, request, accepted: false },
        request,
      );
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
            ? "DeepSeek 已提取事实；确认后查询高德，由 AI 提出候选，代码检查时间与硬约束。"
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
                          updateParsed({
                            ...activeParsed,
                            existingPlans: activeParsed.existingPlans.filter(
                              (candidate) => candidate.id !== item.id,
                            ),
                          })
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
                          value={item.endTime}
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
                        <label htmlFor={`mention-end-${mention.id}`}>结束时间（未提供时长时必填）</label>
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
  if (!session) return <Loading error={error} />;
  const pending =
    session.flowStage === "PLAN_READY" ? session.pendingPlan : null;
  if (!pending || pending.result.mode!=="live")
    return (
      <div className="workspace narrow">
        <h1>还没有待确认的方案。</h1>
        <p className="muted">请先确认系统对行程和变化的理解。</p>
        <Link
          className="primary"
          href={session.snapshot.itinerary.length ? "/rescue" : "/onboarding"}
        >
          返回正确入口 <ArrowRight size={17} />
        </Link>
      </div>
    );
  const { result, base, request } = pending;
  const plan = result.plan;
  if (!result.ok || !plan)
    return (
      <div className="workspace narrow">
        <h1>{result.message}</h1>
        <p className="muted">原行程和输入都已保留，可以返回修改后重试。</p>
        <ul>{[...new Set(result.attempts.flatMap(a=>a.violations.map(v=>v.message)))].map(message=><li key={message}>{message}</li>)}</ul>
        <Link className="primary" href="/rescue">
          修改理解 <ArrowRight size={17} />
        </Link>
      </div>
    );
  const activeSession = session;
  const activePlan = plan;
  const baseIds = new Set(base.itinerary.map((event) => event.id));
  const retained = plan.events.filter((event) => baseIds.has(event.id));
  const added = plan.events.filter((event) => !baseIds.has(event.id));
  const impact = pending.impactAnalysis ?? result.impactAnalysis;
  const trace = result.decisionTrace;
  const unconfirmed = [
    "路线耗时来自高德查询，仍可能受出发时间、交通变化及入口选择影响。",
    "POI 基础数据不等于已核实营业状态；新增停留时长为建议。",
    ...(result.context.world?.weather.status!=="available"?["本次未取得或未请求高德天气，没有使用默认天气替代。"]:[]),
    ...(request.currentState.remainingBudget === undefined
      ? ["未提供预算，因此预算未检查。"]
      : []),
    ...(plan.events.some((event) => event.estimatedCostKnown === false)
      ? ["至少一项活动的费用未提供，因此预算未完整检查。"]
      : []),
  ];

  async function accept() {
    setBusy(true);
    setError("");
    try {
      const latest = loadSession();
      if (latest.snapshot.revision !== base.revision)
        throw new Error("原行程已发生变化，请重新生成方案。");
      if(result.context.world && Date.now()-Date.parse(result.context.world.currentTime.confirmedAt)>300000)throw new Error("距离确认时间已超过 5 分钟，请更新当前时间后重新生成。");
      const response = await fetch("/api/validate", {
        method: "POST",
        headers: await requestHeaders(),
        body: JSON.stringify({
          snapshot: base,
          request,
          mode: result.mode,
          confirmation: {
            status: "confirmed",
            confirmedAt: new Date().toISOString(),
          },
          plan,
        }),
      });
      const checked = (await response.json()) as { ok?: boolean };
      if (!response.ok || !checked.ok)
        throw new Error("方案已不再满足可验证规则，请重新生成。");
      const next = SnapshotSchema.parse({
        ...base,
        state: request.currentState,
        itinerary: [
          ...latest.snapshot.itinerary.filter(
            (event) => event.status === "completed",
          ),
          ...activePlan.events,
        ],
        revision: latest.snapshot.revision + 1,
      });
      await saveTrip(next, latest.snapshot.revision);
      const updated = saveSession({
        ...loadSession(),
        snapshot: { ...next, mode: "user" },
        flowStage: "HAS_ITINERARY",
        rawInput: "",
        parsedInput: null,
        lastDisruption: request,
        pendingPlan: null,
      });
      setSession(updated);
      await logEvent("replan_accepted", { planId: result.id, mode: "real" });
      setNotice("方案已接受，今日行程已经更新。");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function editPlan(adjustment: string) {
    setBusy(true);
    setError("");
    try {
      const rawInput = `${activeSession.rawInput} ${adjustment}`.trim();
      const parsedInput = await parseWithModel(activeSession.snapshot, rawInput);
      const updated = saveSession({
        ...activeSession,
        rawInput,
        parsedInput,
        flowStage: "RESCUE_CONFIRM",
      });
      setSession(updated);
      window.location.assign("/rescue");
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  return (
    <div className="workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">方案等待你的确认</span>
          <h1>今天建议这样调整</h1>
          <p>{plan.summary}。先看方案，再决定是否更新今日行程。</p>
        </div>
      </div>
      {notice && (
        <div className="success-box" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {!notice && (
        <div className="success-box">
          <ShieldCheck size={22} />
          <div>
            <b>
              {result.verificationLevel === "complete"
                ? "所有硬性约束均已通过"
                : "已通过当前可验证规则"}
            </b>
            <p>估算和未提供的信息单独列在下方。</p>
          </div>
        </div>
      )}
      {impact && (
        <details className="audit" style={{ marginBottom: 18 }}>
          <summary>查看我的情况分析</summary>
          <div className="change-list">
            <p><b>你告诉我的：</b>{request.freeText}</p>
            <p><b>受到影响：</b>{impact.affectedActivities.length ? impact.affectedActivities.map((id) => base.itinerary.find((event) => event.id === id)?.name ?? id).join("、") : "暂未发现明确受影响的安排。"}</p>
            <p><b>已经完成：</b>{impact.completedActivities.length ? impact.completedActivities.map((id) => base.itinerary.find((event) => event.id === id)?.name ?? id).join("、") : "暂无。"}</p>
            <p><b>必须保留：</b>{impact.lockedActivities.length ? impact.lockedActivities.map((id) => base.itinerary.find((event) => event.id === id)?.name ?? id).join("、") : "暂无固定安排。"}</p>
            <p><b>空档：</b>{impact.availableTimeWindows.length ? impact.availableTimeWindows.map((window) => `${window.startTime}–${window.endTime}`).join("、") : "没有可重新安排的时间窗。"}</p>
          </div>
        </details>
      )}
      <div className="result-sections">
        {result.candidateComparisons && <details className="audit"><summary>查看候选方案比较</summary>{result.candidateComparisons.map((candidate,i)=><div className="card" key={i}><b>{candidate.title} · {candidate.feasible?"通过当前校验":"存在冲突"}</b><p>{candidate.tradeOff}</p>{candidate.conflicts.map((c,i)=><p key={i}>{c}</p>)}</div>)}</details>}
        <section className="card">
          <h2>1. 当前变化</h2>
          <p>{request.freeText}</p>
        </section>
        <section className="card">
          <h2>2. 保留的安排</h2>
          <Timeline events={retained} />
        </section>
        <section className="card">
          <h2>3. 被替换或移动的安排</h2>
          {[...plan.removedEvents, ...plan.movedEvents].length ? (
            <div className="change-list">
              {plan.removedEvents.map((item) => (
                <div key={item.eventId}>
                  <b>{displayPlace(item.name)} · 已移除</b>
                  <p>{item.reason}</p>
                </div>
              ))}
              {plan.movedEvents.map((item) => (
                <div key={item.eventId}>
                  <b>
                    {displayPlace(item.name)} · 建议移动到 {item.suggestedDate}{" "}
                    {item.suggestedStart}
                  </b>
                  <p>{item.reason}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">没有活动被移除或移到其他日期。</p>
          )}
        </section>
        <section className="card">
          <h2>4. 新增推荐</h2>
          <Timeline events={added} />
        </section>
        <section className="card">
          <h2>5. 时间、路程和预算影响</h2>
          <p>
            新方案从 {request.currentState.currentTime} 之后开始，共{" "}
            {plan.events.length} 项安排。
          </p>
          <p>
            {request.currentState.remainingBudget === undefined
              ? "预算未提供，未执行预算检查。"
              : plan.events.some((event) => event.estimatedCostKnown === false)
                ? "部分活动费用未提供，未执行完整预算检查。"
              : `计划活动估算费用 ฿${plan.events.reduce((sum, event) => sum + event.estimatedCost, 0)}，可用预算 ฿${request.currentState.remainingBudget}。`}
          </p>
        </section>
        <section className="card">
          <h2>6. 未确认或仅为估算的信息</h2>
          <ul>
            {unconfirmed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <details className="audit">
          <summary>查看决策与校验证据</summary>
          <div className="change-list">
            {trace?.decisions.map((item, index) => (
              <div key={`${item.eventId}-${index}`}>
                <b>{item.decision}</b>
                <p>理由：{item.reason}</p>
                <p>证据：{item.evidence.join("；")}</p>
              </div>
            ))}
            {trace?.validationEvidence.map((item) => (
              <div key={item.check}>
                <b>
                  {item.status === "passed"
                    ? "通过"
                    : item.status === "failed"
                      ? "未通过"
                      : "未检查"}{" "}
                  · {item.check}
                </b>
                <p>{item.detail}</p>
              </div>
            ))}
          </div>
        </details>
      </div>
      {!notice ? (
        <div className="form-actions">
          <button className="primary" disabled={busy} onClick={accept}>
            {busy ? "正在确认……" : "接受并更新今日行程"}
            <Check size={17} />
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void editPlan("请减少步行。")}
          >
            少走一点路
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void editPlan("请降低花费。")}
          >
            更省钱
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void editPlan("请早点结束。")}
          >
            早点回去
          </button>
        </div>
      ) : (
        <Link className="primary" href="/trip">
          查看更新后的今日行程 <ArrowRight size={17} />
        </Link>
      )}
    </div>
  );
}

export function DemoFlow() {
  const [accepted, setAccepted] = useState(false);
  const [lighter, setLighter] = useState(false);
  const proposal = demo.itinerary.filter(
    (event) => event.id === "e-mall" || event.locked,
  );
  return (
    <div className="workspace">
      <div className="demo-note" role="status">
        <b>示例模式</b>
        <p>
          下列内容只用于展示“下雨后如何调整今天的行程”，不会读取、覆盖或更新你的真实行程。
        </p>
      </div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">示例：曼谷雨天救援</span>
          <h1>保留晚餐，把下午移到室内。</h1>
          <p>15:00，暹罗，下雨且体力较低；19:00 晚餐保持不变。</p>
        </div>
      </div>
      <div className="compare-grid">
        <section className="card">
          <h2>原计划</h2>
          <Timeline
            events={demo.itinerary.filter(
              (event) => event.status !== "completed",
            )}
          />
        </section>
        <section className="card">
          <h2>{lighter ? "更轻松的示例方案" : "示例调整方案"}</h2>
          <Timeline
            events={
              lighter ? proposal.filter((event) => event.locked) : proposal
            }
          />
        </section>
      </div>
      {accepted && (
        <div className="success-box">
          已在示例页面中接受。真实行程没有发生变化。
        </div>
      )}
      <div className="form-actions">
        <button className="primary" onClick={() => setAccepted(true)}>
          接受示例方案
        </button>
        <button className="secondary" onClick={() => setLighter(true)}>
          示例：少走一点路
        </button>
        <Link className="secondary" href="/">
          开始使用我的真实行程
        </Link>
      </div>
    </div>
  );
}

export function SessionWorkflow({ page }: { page: string }) {
  if (page === "home") return <HomeFlow />;
  if (page === "onboarding") return <OnboardingFlow />;
  if (page === "trip") return <TripFlow />;
  if (page === "rescue") return <RescueFlow />;
  if (page === "result") return <ResultFlow />;
  if (page === "demo") return <DemoFlow />;
  return <HomeFlow />;
}

export function Workflow({ page }: { page: string }) {
  return <SessionWorkflow page={page} />;
}

export function HomeRescue() {
  return <HomeFlow />;
}
