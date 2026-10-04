"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { eventsFromActivityFacts } from "@/services/itinerary-domain";
import { protectionPolicyForActivity } from "@/services/protection-policy";
import { minutes } from "@/lib/time";
import {
  commitSnapshot,
  createItineraryDraft,
  loadSession,
  logEvent,
  saveItineraryDraft,
  updateSession,
} from "@/services/trip-service";
import {
  MAX_RAW_INPUT_LENGTH,
  ParsedUserInputSchema,
  RAW_INPUT_TOO_LONG_MESSAGE,
  SnapshotSchema,
  isRawInputWithinLimit,
  rawInputRemaining,
  ActivityFactSchema,
  type ActivityFactDraft,
  type ItineraryDraft,
  type ParsedUserInput,
  type Snapshot,
} from "@/types";
import { errorText, parseWithModel } from "./assist-client";
import { Loading, RawInputLimitHint } from "./shared-ui";
import { useRealSession } from "./use-real-session";

function snapshotFromItineraryDraft(
  base: Snapshot,
  draft: ItineraryDraft,
): Snapshot {
  return SnapshotSchema.parse({
    ...base,
    profile: draft.profile,
    trip: {
      ...base.trip,
      destination: draft.destination.trim(),
      startDate: draft.currentDate,
      endDate: draft.currentDate,
    },
    state: {
      ...base.state,
      currentDate: draft.currentDate,
      currentTime: draft.currentTime,
      currentLocation: draft.currentLocation.trim(),
      stateCapturedAt: draft.stateCapturedAt,
      browserLocation:
        draft.currentLocationSource === "user"
          ? undefined
          : base.state.browserLocation,
    },
    stateSources: {
      ...base.stateSources,
      currentTime: draft.currentTimeSource,
      currentLocation: draft.currentLocationSource,
    },
  });
}

export function OnboardingFlow() {
  const { session, setSession, error, setError } = useRealSession();
  const [draft, setDraft] = useState<ItineraryDraft | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [parsing, setParsing] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (session && !initialized) {
        setInitialized(true);
        setDraft(
          session.itineraryDraft?.baseRevision === session.snapshot.revision
            ? session.itineraryDraft
            : createItineraryDraft(session),
        );
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [session, initialized, setError]);
  if (!session || !draft) return <Loading error={error} />;
  const activeSession = session;
  const activeDraft = draft;
  const raw = activeDraft.rawInput;
  const items = activeDraft.activityFacts;

  function persistDraft(
    nextDraft: ItineraryDraft,
    parsedInput: ParsedUserInput | null = null,
  ) {
    const updated = saveItineraryDraft(nextDraft, parsedInput);
    setDraft(updated.itineraryDraft ?? nextDraft);
    setSession(updated);
  }

  function updateItem(
    id: string,
    patch: Partial<ActivityFactDraft>,
  ) {
    persistDraft({
      ...activeDraft,
      activityFacts: activeDraft.activityFacts.map((item) => {
        if(item.id!==id)return item;
        const next={...item,...patch};
        if(patch.startTime!==undefined||patch.endTime!==undefined){
          const duration=next.startTime&&next.endTime?minutes(next.endTime)-minutes(next.startTime):0;
          next.durationMinutes=duration>0?duration:null;
          next.durationSource=next.endTime?"user":"unknown";
        }
        return {...next,protectionPolicy:protectionPolicyForActivity({name:next.name,location:next.placeQuery,sourceText:next.sourceText??"",startTime:next.startTime,endTime:next.endTime,durationMinutes:next.durationMinutes,commitment:next.commitment})};
      }),
    });
  }

  async function parsePlans() {
    if (!raw.trim()) {
      setError("请先粘贴或输入今天已有的安排。");
      return;
    }
    if (!activeDraft.destination.trim()) {
      setError("请先填写所在城市。");
      return;
    }
    if (!activeDraft.currentDate || !activeDraft.currentTime) {
      setError("请先填写今天的日期和当前时间。");
      return;
    }
    if (!isRawInputWithinLimit(raw)) {
      setError(RAW_INPUT_TOO_LONG_MESSAGE);
      return;
    }
    setParsing(true);
    setError("");
    try {
      const editableSnapshot = snapshotFromItineraryDraft(
        activeSession.snapshot,
        activeDraft,
      );
      const parsed = await parseWithModel(editableSnapshot, raw);
      persistDraft({ ...activeDraft, activityFacts: parsed.activityFacts }, parsed);
      if (parsed.activityFacts.some(fact=>fact.role!=="existing_plan")) window.location.assign("/rescue");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setParsing(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (!isRawInputWithinLimit(raw))
        throw new Error(RAW_INPUT_TOO_LONG_MESSAGE);
      if (!items.length)
        throw new Error("请先解析并确认至少一项今天已有的安排。");
      if (!activeDraft.destination.trim()) throw new Error("请填写所在城市。");
      if (!activeDraft.currentDate || !activeDraft.currentTime)
        throw new Error("请填写今天的日期和当前时间。");
      if (!activeDraft.currentLocation.trim())
        throw new Error("请填写当前地点。");
      if (items.some((item) => !item.name.trim()))
        throw new Error("请检查活动名称。");
      if (items.some((item) => !item.startTime || !item.placeQuery?.trim()))
        throw new Error("请检查活动开始时间。");
      const latest = loadSession();
      if (latest.snapshot.revision !== activeDraft.baseRevision)
        throw new Error("行程已在其他页面更新，请刷新后重新编辑。");
      const editableSnapshot = snapshotFromItineraryDraft(
        latest.snapshot,
        activeDraft,
      );
      const parsed = ParsedUserInputSchema.parse({
        rawText: raw,
        intent: "create",
        activityFacts: items.map(item=>ActivityFactSchema.parse({...item,role:"existing_plan"})),
        disruptions: [],
        constraints: items
          .filter((item) => item.commitment !== "flexible")
          .map((item) => ({
            kind: "keep",
            value: `${item.startTime} ${item.name}`,
            source: "user",
          })),
        context: editableSnapshot.state,
        contextSources: editableSnapshot.stateSources,
        closedPlaceIds: [],
        missingFacts: [],
        status: "confirmed",
      });
      const next = SnapshotSchema.parse({
        ...editableSnapshot,
        itinerary: eventsFromActivityFacts({ ...editableSnapshot, itinerary: [] }, parsed.activityFacts),
        revision: activeDraft.baseRevision + 1,
      });
      commitSnapshot(next, activeDraft.baseRevision);
      const updated = updateSession({
        itineraryDraft: null,
        rawInput: "",
        parsedInput: null,
        pendingInput: null,
        pendingPlan: null,
        conditionalAdvice: null,
        flowStage: next.itinerary.length ? "HAS_ITINERARY" : "NO_ITINERARY",
      });
      setSession(updated);
      await logEvent("trip_created", { tripId: next.trip.id, mode: "real" });
      window.location.assign("/trip");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <div className="mobile-workspace onboarding-screen">
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
                maxLength={80}
                value={activeDraft.destination}
                onChange={(event) =>
                  persistDraft({
                    ...activeDraft,
                    destination: event.target.value,
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
                value={activeDraft.currentDate}
                onChange={(event) => {
                  persistDraft({
                    ...activeDraft,
                    currentDate: event.target.value,
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
                value={activeDraft.currentTime}
                onChange={(event) =>
                  persistDraft({
                    ...activeDraft,
                    currentTime: event.target.value,
                    currentTimeSource: "user",
                    stateCapturedAt: new Date().toISOString(),
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="current-location">现在在哪儿</label>
              <input
                id="current-location"
                required
                maxLength={100}
                value={activeDraft.currentLocation}
                onChange={(event) =>
                  persistDraft({
                    ...activeDraft,
                    currentLocation: event.target.value,
                    currentLocationSource: "user",
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
              maxLength={MAX_RAW_INPUT_LENGTH}
              value={raw}
              onChange={(event) =>
                persistDraft({ ...activeDraft, rawInput: event.target.value })
              }
              placeholder="10 点去城市博物馆，12:30 午餐，19 点已预订晚餐"
              aria-describedby="itinerary-input-limit"
            />
            <RawInputLimitHint id="itinerary-input-limit" remaining={rawInputRemaining(raw)} />
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
                        persistDraft({
                          ...activeDraft,
                          activityFacts: activeDraft.activityFacts.filter(
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
                      <label htmlFor={`name-${item.id}`}>活动</label>
                      <input
                        id={`name-${item.id}`}
                        required
                        maxLength={160}
                        value={item.name}
                        onChange={(event) =>
                          updateItem(item.id, { name: event.target.value })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`start-${item.id}`}>开始</label>
                      <input
                        id={`start-${item.id}`}
                        type="time"
                        required
                        value={item.startTime ?? ""}
                        onChange={(event) =>
                          updateItem(item.id, { startTime: event.target.value||null,startTimeSource:event.target.value?"user":"not_provided" })
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
                          updateItem(item.id, {
                            endTime: event.target.value || null,
                            durationSource:event.target.value?"user":"unknown",
                          })
                        }
                      />
                    </div>
                    <div className="field stop-location">
                      <label htmlFor={`location-${item.id}`}>地点</label>
                      <input
                        id={`location-${item.id}`}
                        required
                        maxLength={160}
                        value={item.placeQuery ?? ""}
                        onChange={(event) =>
                          updateItem(item.id, { placeQuery: event.target.value })
                        }
                      />
                    </div>
                    <label className="interest fixed-plan">
                      <Checkbox
                        checked={item.commitment !== "flexible"}
                        onCheckedChange={(checked) =>
                          updateItem(item.id, {
                            commitment: checked?"fixed":"flexible",
                          })
                        }
                      />
                      固定时间或预约（按类型保护关键字段）
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <details className="preferences-panel">
          <summary>想补充更多？节奏与步行承受度（可选）</summary>
          <div className="form-grid" style={{ marginTop: 16 }}>
            <div className="field">
              <label htmlFor="pace">旅行节奏（可选）</label>
              <select
                id="pace"
                value={activeDraft.profile.travelPace}
                onChange={(event) =>
                  persistDraft({
                    ...activeDraft,
                    profile: {
                      ...activeDraft.profile,
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
            <div className="field">
              <label htmlFor="walking-tolerance">步行承受度（可选）</label>
              <select id="walking-tolerance" value={activeDraft.profile.walkingTolerance} onChange={(event) => persistDraft({ ...activeDraft, profile: { ...activeDraft.profile, walkingTolerance: event.target.value as Snapshot["profile"]["walkingTolerance"] } })}>
                <option value="low">尽量少走</option>
                <option value="medium">适量步行</option>
                <option value="high">可以多走</option>
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
