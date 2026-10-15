"use client";

import { PlanningError } from "@/components/ui/planning-error";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Check, ChevronDown, LockKeyhole, MapPin, Plus, Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TimeField } from "@/components/ui/time-field";
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
  ActivityFactSchema,
  type ActivityFactDraft,
  type ItineraryDraft,
  type ParsedUserInput,
  type Snapshot,
} from "@/types";
import { errorText, parseWithModel } from "./assist-client";
import { Loading } from "./shared-ui";
import { useRealSession } from "./use-real-session";
import { useAuthState } from "./use-auth-state";

function snapshotFromItineraryDraft(
  base: Snapshot,
  draft: ItineraryDraft,
): Snapshot {
  return SnapshotSchema.parse({
    ...base,
    profile: draft.profile,
    trip: {
      ...base.trip,
      destination: draft.destination.trim() || base.trip.destination || "待确认城市",
      startDate: draft.currentDate || base.state.currentDate,
      endDate: draft.currentDate || base.state.currentDate,
    },
    state: {
      ...base.state,
      currentDate: draft.currentDate || base.state.currentDate,
      currentTime: draft.currentTime || base.state.currentTime,
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
  const auth = useAuthState();
  const authPreparing = auth.status === "preparing";
  const [draft, setDraft] = useState<ItineraryDraft | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
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

  function itemIncomplete(item: ActivityFactDraft) {
    return !item.name.trim() || !item.startTime || !item.placeQuery?.trim() || Boolean(item.endTime && item.startTime && minutes(item.endTime) <= minutes(item.startTime));
  }

  function addItem() {
    if (items.length >= 30) return;
    const id = crypto.randomUUID();
    const item: ActivityFactDraft = { id, placeId: "custom-" + id, origin: "message", snapshotEventId: null, role: "existing_plan", progress: "not_started", name: "", placeQuery: null, startTime: null, startTimeSource: "not_provided", endTime: null, durationMinutes: null, durationSource: "unknown", commitment: "flexible", sourceText: null };
    persistDraft({ ...activeDraft, activityFacts: [...items, item] });
    setExpandedItemId(id);
    setDescriptionOpen(false);
    setError("");
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
      persistDraft({ ...activeDraft, activityFacts: parsed.activityFacts,
        destination: parsed.destinationDraft?.trim() || activeDraft.destination,
        currentTime: parsed.context.currentTime,
        currentTimeSource: parsed.contextSources.currentTime,
        currentLocation: parsed.context.currentLocation ?? activeDraft.currentLocation,
        currentLocationSource: parsed.contextSources.currentLocation,
        stateCapturedAt: parsed.context.stateCapturedAt ?? activeDraft.stateCapturedAt,
      }, parsed);
      setExpandedItemId(parsed.activityFacts.find(itemIncomplete)?.id ?? null);
      setDescriptionOpen(false);
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
      const incomplete = items.find(itemIncomplete);
      if (incomplete) {
        setExpandedItemId(incomplete.id);
        const field = !incomplete.name.trim() ? "name" : !incomplete.startTime ? "start" : !incomplete.placeQuery?.trim() ? "location" : "end";
        requestAnimationFrame(() => document.getElementById(field + "-" + incomplete.id)?.focus());
        throw new Error(field === "end" ? "结束时间需要晚于开始时间。" : "请补全这项安排的名称、开始时间和地点。");
      }
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
      <div className="onboarding-heading"><h1>把今天的安排放进来。</h1></div>
      <form className="card form-card setup-form" onSubmit={submit} noValidate>
        <section className={items.length > 0 && !descriptionOpen ? "itinerary-entry-collapsed" : "setup-section itinerary-entry"}>
          {items.length > 0 && <div className="itinerary-entry-heading"><button type="button" className="text-action" onClick={() => setDescriptionOpen(open => !open)}>{descriptionOpen ? "收起输入" : "重新输入"}<ChevronDown size={14} className={descriptionOpen ? "entry-chevron open" : "entry-chevron"} /></button></div>}
          {(!items.length || descriptionOpen) && <div className="itinerary-input-area">
            <textarea id="itinerary-input" aria-label="你今天想怎么安排？" maxLength={MAX_RAW_INPUT_LENGTH} value={raw} rows={4} onChange={event => persistDraft({ ...activeDraft, rawInput: event.target.value })} />
            <div className="itinerary-input-actions"><button type="button" className="primary" disabled={parsing || authPreparing || !raw.trim()} onClick={parsePlans}>{authPreparing ? "正在准备会话…" : parsing ? "正在整理你的安排…" : "整理这份行程"}<ArrowRight size={16} /></button>{!items.length && <button type="button" className="text-action manual-add" disabled={parsing} onClick={addItem}><Plus size={14} />手动添加</button>}</div>
          </div>}
        </section>
        {items.length > 0 && <section className="itinerary-review" aria-label="今日安排列表">
          <div className="itinerary-review-heading"><span>{items.length} 个安排</span><button type="button" className="text-action" disabled={parsing || items.length >= 30} onClick={addItem}><Plus size={14} />添加安排</button></div>
          <div className="stop-list">{items.map((item, index) => {
            const expanded = expandedItemId === item.id;
            const incomplete = itemIncomplete(item);
            return <div className={expanded ? "stop-editor expanded" : "stop-editor"} key={item.id}>
              <div className="stop-summary-row">
                <button className="stop-summary" type="button" aria-label={`编辑安排 ${index + 1}：${item.name || "新安排"}`} aria-expanded={expanded} aria-controls={`stop-details-${item.id}`} onClick={() => setExpandedItemId(expanded ? null : item.id)}>
                  <span className="stop-time-preview"><b>{item.startTime || "待定"}</b>{item.endTime && <small>{item.endTime}</small>}</span>
                  <span className="stop-summary-copy"><span className="stop-summary-title">{item.name || "新安排"}</span><span className="stop-location-preview"><MapPin size={11} />{item.placeQuery || "补充地点"}</span><span className={incomplete ? "stop-summary-status incomplete" : "stop-summary-status"}>{incomplete ? "待补全" : item.commitment !== "flexible" ? <><LockKeyhole size={10} />固定预约</> : "时间可调整"}</span></span>
                  <ChevronDown size={15} className={expanded ? "stop-editor-chevron open" : "stop-editor-chevron"} />
                </button>
                <button type="button" className="stop-delete" aria-label={`删除安排 ${index + 1}`} onClick={() => persistDraft({ ...activeDraft, activityFacts: items.filter(candidate => candidate.id !== item.id) })}><Trash2 size={15} /></button>
              </div>
              <div className="stop-editor-body" id={`stop-details-${item.id}`} hidden={!expanded}>
                <div className="stop-grid">
                  <div className="field stop-name"><label htmlFor={`name-${item.id}`}>安排名称</label><input id={`name-${item.id}`} maxLength={160} value={item.name} onChange={event => updateItem(item.id, { name: event.target.value })} /></div>
                  <div className="field"><label htmlFor={`start-${item.id}`}>开始时间</label><TimeField id={`start-${item.id}`} value={item.startTime ?? ""} onValueChange={value => updateItem(item.id, { startTime: value || null, startTimeSource: value ? "user" : "not_provided" })} /></div>
                  <div className="field"><label htmlFor={`end-${item.id}`}>结束时间（可选）</label><TimeField id={`end-${item.id}`} value={item.endTime ?? ""} onValueChange={value => updateItem(item.id, { endTime: value || null, durationSource: value ? "user" : "unknown" })} /></div>
                  <div className="field stop-location"><label htmlFor={`location-${item.id}`}>地点</label><input id={`location-${item.id}`} maxLength={160} value={item.placeQuery ?? ""} onChange={event => updateItem(item.id, { placeQuery: event.target.value })} /></div>
                  <label className="interest fixed-plan"><Checkbox checked={item.commitment !== "flexible"} onCheckedChange={checked => updateItem(item.id, { commitment: checked ? "fixed" : "flexible" })} />固定时间或预约</label>
                </div>
                <button type="button" className="stop-edit-done" onClick={() => setExpandedItemId(null)}>完成编辑<Check size={14} /></button>
              </div>
            </div>;
          })}</div>
        </section>}
        <details className="preferences-panel"><summary>出行偏好（可选）</summary><div className="form-grid">
          <div className="field"><label htmlFor="pace">旅行节奏</label><SelectField id="pace" value={activeDraft.profile.travelPace} onValueChange={value => persistDraft({ ...activeDraft, profile: { ...activeDraft.profile, travelPace: value as Snapshot["profile"]["travelPace"] } })} options={[{"value":"relaxed","label":"轻松"},{"value":"balanced","label":"平衡"},{"value":"packed","label":"紧凑"}]} /></div>
          <div className="field"><label htmlFor="walking-tolerance">步行承受度</label><SelectField id="walking-tolerance" value={activeDraft.profile.walkingTolerance} onValueChange={value => persistDraft({ ...activeDraft, profile: { ...activeDraft.profile, walkingTolerance: value as Snapshot["profile"]["walkingTolerance"] } })} options={[{"value":"low","label":"尽量少走"},{"value":"medium","label":"适量步行"},{"value":"high","label":"可以多走"}]} /></div>
        </div></details>
        {error && <PlanningError message={error} />}
        <div className="form-actions">{items.length > 0 && <button className="primary" disabled={parsing}>开始今天的行程<ArrowRight size={18} /></button>}</div>
      </form>
    </div>
  );
}
