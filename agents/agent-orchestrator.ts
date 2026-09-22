import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ConfirmedDraftSchema,
  EventSchema,
  MissingFactSchema,
  ParsedUserInputSchema,
  ReplanningRequestSchema,
  ResolutionStateSchema,
  SnapshotSchema,
  TimeSchema,
  type AgentResult,
  type ConfirmedDraft,
  type ImpactAnalysis,
  type MissingFact,
  type ParsedUserInput,
  type ResolutionState,
  type Snapshot,
} from "../types";
import { BrowserLocationSchema, TravelModeSchema, type RealWorldContext } from "../types/world";
import { addMinutesWithinDay } from "../lib/time";
import { DeepSeekSemanticParser } from "../services/semantic-parser";
import { analyzeImpact } from "../services/impact-analysis";
import { WorldContextService } from "../services/world/world-context-service";
import { allowedModes, genericLocation } from "../services/world/context-resolution";
import { replanReal } from "./real-replanning-agent";

const FieldAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), field: z.string().min(1), value: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal("time"), field: z.string().min(1), value: TimeSchema }),
  z.object({ kind: z.literal("poi"), field: z.string().min(1), poiId: z.string().min(1) }),
  z.object({ kind: z.literal("browser_location"), field: z.literal("currentLocation"), location: BrowserLocationSchema }),
  z.object({ kind: z.literal("event_selection"), field: z.string().min(1), eventId: z.string().min(1) }),
  z.object({ kind: z.literal("travel_mode"), field: z.literal("travelMode"), value: TravelModeSchema }),
]);

const AssistRequestBaseSchema = z.object({
  snapshot: SnapshotSchema,
  rawText: z.string().trim().max(4000).optional(),
  confirmedDraft: ConfirmedDraftSchema.optional(),
  answer: FieldAnswerSchema.optional(),
  resolutionState: ResolutionStateSchema.optional(),
});

export const AssistRequestSchema = AssistRequestBaseSchema.superRefine((input, context) => {
  if (!input.confirmedDraft && !input.rawText) {
    context.addIssue({ code: "custom", path: ["rawText"], message: "首次请求需要输入本次变化。" });
  }
  if (input.confirmedDraft && input.resolutionState?.currentBlockerKey && !input.answer) {
    context.addIssue({ code: "custom", path: ["answer"], message: "当前补充问题需要提供对应字段答案。" });
  }
});

export type AssistRequest = z.infer<typeof AssistRequestSchema>;
export type AssistDependencies = {
  parse?: (snapshot: Snapshot, rawText: string, signal?: AbortSignal) => Promise<ParsedUserInput>;
  ground?: (raw: unknown, signal?: AbortSignal) => Promise<RealWorldContext>;
  replan?: typeof replanReal;
};
type FailureStage = "PARSER" | "GROUNDING" | "PLANNER" | "VALIDATOR";
type ResponseContext = { parsedInput: ParsedUserInput; impactAnalysis: ImpactAnalysis; resolutionState: ResolutionState };

export type AssistResponse =
  | (ResponseContext & { status: "NEEDS_INPUT"; confirmedDraft: ConfirmedDraft; missingFact: MissingFact; ambiguities?: RealWorldContext["ambiguities"]; world?: RealWorldContext })
  | (ResponseContext & { status: "READY"; result: AgentResult; base: Snapshot; request: ReturnType<typeof ReplanningRequestSchema.parse> })
  | (ResponseContext & { status: "NO_SAFE_PLAN"; result?: AgentResult; base?: Snapshot; request?: ReturnType<typeof ReplanningRequestSchema.parse>; error: string; retryable: false; failedStage: "PLANNER" | "VALIDATOR" })
  | (Partial<ResponseContext> & { status: "OUT_OF_SCOPE"; error: string; retryable: false })
  | (Partial<ResponseContext> & { status: "UPSTREAM_UNAVAILABLE"; error: string; retryable: true; failedStage: FailureStage });

const emptyResolutionState = (): ResolutionState => ({ currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] });
const related = (a: string, b: string) => a.includes(b) || b.includes(a) || (/美术馆/.test(a) && /美术馆/.test(b)) || (/晚餐|餐厅/.test(a) && /晚餐|餐厅/.test(b));

function systemClock() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return { currentTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`, stateCapturedAt: now.toISOString() };
}

function refreshSystemTime(snapshot: Snapshot): Snapshot {
  if (snapshot.stateSources.currentTime === "user") return snapshot;
  return SnapshotSchema.parse({ ...snapshot, state: { ...snapshot.state, ...systemClock() }, stateSources: { ...snapshot.stateSources, currentTime: "system" } });
}

function draftToParsed(draft: ConfirmedDraft): ParsedUserInput {
  return ParsedUserInputSchema.parse({
    rawText: draft.rawText,
    intent: draft.intent,
    existingPlans: draft.existingPlans.map((item) => ({ ...item, source: "user" as const })),
    activityMentions: draft.activityMentions,
    disruptions: draft.disruptions,
    constraints: draft.constraints,
    context: draft.context,
    contextSources: draft.contextSources,
    closedPlaceIds: draft.closedPlaceIds,
    missingFacts: [],
    status: "confirmed",
    parser: "manual",
    parserModel: null,
    parseWarnings: [],
    question: draft.question,
    worldOptions: draft.worldOptions ?? { selectedPois: {} },
  });
}

function parsedToDraft(parsed: ParsedUserInput, baseRevision: number): ConfirmedDraft {
  return ConfirmedDraftSchema.parse({
    rawText: parsed.rawText,
    intent: parsed.intent,
    existingPlans: parsed.existingPlans.map((item) => ({ id: item.id, name: item.name, startTime: item.startTime, endTime: item.endTime, durationMinutes: item.durationMinutes, location: item.location, locked: item.locked })),
    activityMentions: parsed.activityMentions,
    disruptions: parsed.disruptions,
    constraints: parsed.constraints,
    context: parsed.context,
    contextSources: parsed.contextSources,
    closedPlaceIds: parsed.closedPlaceIds,
    question: parsed.question,
    worldOptions: parsed.worldOptions ?? { selectedPois: {} },
    destination: undefined,
    removedLockedIds: [],
    baseRevision,
  });
}

function materializeDraftTime(item: ConfirmedDraft["existingPlans"][number]) {
  if (item.endTime) return { endTime: item.endTime, durationSource: "user" as const };
  if (item.durationMinutes !== null) return { endTime: addMinutesWithinDay(item.startTime, item.durationMinutes), durationSource: "user" as const };
  return { endTime: item.startTime, durationSource: "unknown" as const };
}

function applyAnswer(draft: ConfirmedDraft, answer: NonNullable<AssistRequest["answer"]>, state: ResolutionState): ConfirmedDraft {
  if (!state.currentBlockerKey || answer.field !== state.currentBlockerKey) throw new Error("这条回答不属于当前补充问题，请重新打开当前问题后再提交。");
  const next = structuredClone(draft);
  if (answer.kind === "poi") {
    next.worldOptions = { ...(next.worldOptions ?? { selectedPois: {} }), selectedPois: { ...next.worldOptions?.selectedPois, [answer.field]: answer.poiId } };
  } else if (answer.kind === "browser_location") {
    next.context.browserLocation = answer.location;
    next.context.currentLocation = "浏览器定位";
    next.contextSources.currentLocation = "user";
  } else if (answer.kind === "travel_mode") {
    next.worldOptions = { ...(next.worldOptions ?? { selectedPois: {} }), travelMode: answer.value, allowedTravelModes: [answer.value] };
  } else if (answer.kind === "event_selection") {
    const event = next.existingPlans.find((item) => item.id === answer.eventId || item.placeId === answer.eventId);
    if (!event) throw new Error("所选活动不属于本次已确认行程。");
    if (answer.field === "closedPlace") next.closedPlaceIds = [event.placeId ?? event.id];
    else throw new Error("当前问题不接受活动选择。");
  } else if (answer.kind === "time") {
    if (answer.field === "currentTime") {
      next.context.currentTime = answer.value;
      next.context.stateCapturedAt = new Date().toISOString();
      next.contextSources.currentTime = "user";
    } else {
      const match = /^activity:(.+):startTime$/.exec(answer.field);
      const event = match && next.existingPlans.find((item) => item.id === match[1]);
      if (!event) throw new Error("当前时间回答没有对应到已确认活动。");
      event.startTime = answer.value;
    }
  } else if (answer.kind === "text") {
    if (answer.field === "currentLocation") {
      next.context.currentLocation = answer.value;
      next.contextSources.currentLocation = "user";
    } else if (answer.field === "destination") {
      next.destination = answer.value;
    } else {
      const match = /^activity:(.+):location$/.exec(answer.field);
      const event = match && next.existingPlans.find((item) => item.id === match[1]);
      if (!event) throw new Error("当前文本回答没有对应到已确认字段。");
      event.location = answer.value;
    }
  }
  return ConfirmedDraftSchema.parse(next);
}

function mergeConfirmedDraft(base: Snapshot, draft: ConfirmedDraft): Snapshot {
  if (draft.baseRevision !== base.revision) throw new Error("原行程版本已变化，请重新确认后再生成方案。");
  const removedLocked = new Set(draft.removedLockedIds);
  const incomingIds = new Set(draft.existingPlans.map((item) => item.id));
  for (const id of removedLocked) {
    const event = base.itinerary.find((item) => item.id === id);
    if (!event?.locked) throw new Error("removedLockedIds 只能包含当前行程中的固定安排。");
    if (incomingIds.has(id)) throw new Error("固定安排不能同时保留并标记为删除。");
  }
  const next = base.itinerary.filter((event) => event.status === "completed");
  for (const old of base.itinerary.filter((event) => event.status !== "completed")) {
    if (incomingIds.has(old.id)) continue;
    if (old.locked && !removedLocked.has(old.id)) throw new Error(`固定安排“${old.name}”不能被静默删除，请先明确确认。`);
  }
  for (const item of draft.existingPlans) {
    const old = base.itinerary.find((event) => event.id === item.id);
    if (old?.status === "completed") throw new Error(`已完成安排“${old.name}”不能重新编辑。`);
    const timing = materializeDraftTime(item);
    if (old?.locked && (!item.locked || item.name !== old.name || item.startTime !== old.startTime || timing.endTime !== old.endTime || item.placeId !== old.placeId || item.location !== old.location)) {
      throw new Error(`固定安排“${old.name}”的时间、地点、名称和锁定状态不能修改。`);
    }
    const changedLocation = Boolean(old && item.location.trim() !== old.location.trim());
    next.push(EventSchema.parse({
      ...(old ?? { category: "user activity", indoorOutdoor: "mixed", openingTime: null, closingTime: null, travelTimeFromPrevious: null, reason: item.locked ? "这是用户确认需要保留的固定安排。" : "这是用户确认的原有安排。", constraint: item.locked ? "Locked plan" : "Original plan" }),
      id: item.id,
      placeId: item.placeId ?? (changedLocation ? `draft-place-${item.id}` : old?.placeId ?? `custom-${item.id}`),
      name: item.name,
      startTime: item.startTime,
      endTime: timing.endTime,
      durationSource: timing.durationSource,
      location: item.location,
      locked: old?.locked ?? item.locked,
      status: old?.locked ?? item.locked ? "locked" : "planned",
    }));
  }
  return SnapshotSchema.parse({ ...base, state: { ...base.state, ...draft.context }, stateSources: { ...base.stateSources, ...draft.contextSources }, trip: { ...base.trip, destination: draft.destination || base.trip.destination }, itinerary: next.sort((a, b) => a.startTime.localeCompare(b.startTime)) });
}

function mergeParsedFacts(snapshot: Snapshot, parsed: ParsedUserInput): Snapshot {
  const next = structuredClone(snapshot.itinerary);
  const plans = [...parsed.existingPlans.map((plan) => ({ ...plan, locked: plan.locked ? "yes" as const : "no" as const })), ...parsed.activityMentions.filter((plan) => plan.role === "existing_plan")];
  const timeOccurrences = new Map<string, number>();
  plans.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.name.localeCompare(b.name));
  for (const plan of plans) {
    if (!plan.startTime) continue;
    const matches = next.filter((event) => event.startTime === plan.startTime && related(event.name, plan.name));
    const old = matches.length === 1 ? matches[0] : undefined;
    if (old?.status === "completed") continue;
    const occurrence = timeOccurrences.get(plan.startTime) ?? 0;
    timeOccurrences.set(plan.startTime, occurrence + 1);
    const id = old?.id ?? `assist-${createHash("sha256").update(`${plan.startTime}:${occurrence}`).digest("hex").slice(0, 16)}`;
    const end = plan.endTime ?? (plan.durationMinutes ? addMinutesWithinDay(plan.startTime, plan.durationMinutes) : old?.endTime ?? plan.startTime);
    const explicitLocation = plan.location && !genericLocation(plan.location) ? plan.location : undefined;
    const locked = old?.locked || plan.locked === "yes";
    const event = EventSchema.parse({ id, placeId: old?.placeId ?? id, name: old?.name ?? plan.name, category: old?.category ?? "user activity", startTime: plan.startTime, endTime: end, durationSource: plan.endTime || plan.durationMinutes ? "user" : old?.durationSource ?? (old ? "user" : "unknown"), location: explicitLocation ?? old?.location ?? plan.location ?? plan.name, locked, status: locked ? "locked" : "planned", indoorOutdoor: old?.indoorOutdoor ?? "mixed", openingTime: old?.openingTime ?? null, closingTime: old?.closingTime ?? null, travelTimeFromPrevious: old?.travelTimeFromPrevious ?? null, reason: "来自用户原文或已保存行程。", constraint: old?.constraint ?? (locked ? "保留固定预约" : "原计划；未知时长仅可作为建议") });
    const index = next.findIndex((item) => item.id === id);
    if (index >= 0) next[index] = event;
    else next.push(event);
  }
  const modes = allowedModes(parsed.rawText, parsed.worldOptions?.travelMode, undefined, parsed.constraints.map((constraint) => constraint.value));
  parsed.worldOptions = { selectedPois: { ...parsed.worldOptions?.selectedPois }, ...(modes.length ? { allowedTravelModes: modes } : {}), ...(parsed.worldOptions?.travelMode ? { travelMode: parsed.worldOptions.travelMode } : {}) };
  return SnapshotSchema.parse({ ...snapshot, state: { ...snapshot.state, ...parsed.context }, stateSources: { ...snapshot.stateSources, ...parsed.contextSources }, itinerary: next.sort((a, b) => a.startTime.localeCompare(b.startTime)) });
}

function hasActionableIntent(parsed: ParsedUserInput, rawText: string) {
  if (parsed.disruptions.length) return true;
  if (parsed.intent === "optimize" && /优化|调整|重排|重新安排|少一点|多一点|轻松一点|紧凑一点/.test(rawText)) return true;
  return (parsed.intent === "rescue" || parsed.intent === "mixed") && /改|换|取消|删除|挪到|提前|推迟|延后/.test(rawText);
}

function requestReason(parsed: ParsedUserInput) {
  if (parsed.disruptions[0]) return parsed.disruptions[0].kind;
  if (parsed.intent === "optimize") return "optimize" as const;
  return "changed_mind" as const;
}

function buildRequest(snapshot: Snapshot, parsed: ParsedUserInput, removedLockedIds: string[] = []) {
  return ReplanningRequestSchema.parse({ reason: requestReason(parsed), freeText: parsed.rawText, currentState: snapshot.state, closedPlaceIds: parsed.closedPlaceIds, variation: 0, stateSources: parsed.contextSources, worldOptions: parsed.worldOptions, ...(removedLockedIds.length ? { confirmedDraftChanges: { removedLockedIds } } : {}) });
}

function missingFact(key: string, question: string, answerType: MissingFact["answerType"] = "text", candidates?: MissingFact["candidates"]): MissingFact {
  return MissingFactSchema.parse({ key, field: key, importance: "blocking", reason: question, question, answerType, ...(candidates?.length ? { candidates } : {}) });
}

function nextResolutionState(previous: ResolutionState, blocker: MissingFact): ResolutionState | null {
  const sameBlockerCount = previous.currentBlockerKey === blocker.key ? previous.sameBlockerCount + 1 : 1;
  const roundCount = previous.roundCount + 1;
  if (sameBlockerCount > 2 || roundCount > 3) return null;
  return ResolutionStateSchema.parse({ currentBlockerKey: blocker.key, sameBlockerCount, roundCount, answeredFields: previous.answeredFields, questionHistory: [...previous.questionHistory, blocker.key].slice(-12) });
}

function answeredResolutionState(previous: ResolutionState, field: string): ResolutionState {
  return ResolutionStateSchema.parse({ ...previous, answeredFields: [...new Set([...previous.answeredFields, field])] });
}

function noImpact(snapshot: Snapshot) {
  return analyzeImpact(snapshot, ReplanningRequestSchema.parse({ reason: "other", freeText: "", currentState: snapshot.state, closedPlaceIds: [], variation: 0, stateSources: snapshot.stateSources }));
}

export async function runAgentAssist(raw: unknown, signal?: AbortSignal, dependencies: AssistDependencies = {}): Promise<AssistResponse> {
  const input = AssistRequestSchema.parse(raw);
  if (input.snapshot.mode !== "user" || Object.values(input.snapshot.stateSources).includes("demo")) throw new Error("真实流程不接受示例状态。");
  const base = refreshSystemTime(input.snapshot);
  let resolutionState = input.resolutionState ?? emptyResolutionState();
  let parsed: ParsedUserInput;
  let draft: ConfirmedDraft;
  let snapshot: Snapshot;

  if (input.confirmedDraft) {
    draft = input.answer ? applyAnswer(input.confirmedDraft, input.answer, resolutionState) : input.confirmedDraft;
    if (input.answer) resolutionState = answeredResolutionState(resolutionState, input.answer.field);
    parsed = draftToParsed(draft);
    snapshot = mergeConfirmedDraft(base, draft);
  } else {
    try {
      parsed = dependencies.parse
        ? await dependencies.parse(base, input.rawText!, signal)
        : await new DeepSeekSemanticParser().parse(base, input.rawText!, undefined, signal);
    } catch (error) {
      return { status: "UPSTREAM_UNAVAILABLE", error: error instanceof Error ? error.message : "AI 解析暂时不可用，请稍后重试。", retryable: true, failedStage: "PARSER" };
    }
    snapshot = mergeParsedFacts(base, parsed);
    draft = parsedToDraft(parsed, snapshot.revision);
  }

  if (!hasActionableIntent(parsed, parsed.rawText)) {
    return { status: "OUT_OF_SCOPE", error: "我只处理已有单日行程中的明确变化或明确优化请求。请说明发生了什么变化，例如“下雨了，把下午的户外行程调一下”。", retryable: false, parsedInput: parsed, impactAnalysis: noImpact(snapshot), resolutionState };
  }
  if (!snapshot.itinerary.some((event) => event.status !== "completed")) {
    return { status: "OUT_OF_SCOPE", error: "当前没有可调整的正式行程。请先到创建页建立今天的行程，再回来处理变化。", retryable: false, parsedInput: parsed, impactAnalysis: noImpact(snapshot), resolutionState };
  }

  const request = buildRequest(snapshot, parsed, draft.removedLockedIds);
  let impact = analyzeImpact(snapshot, request);
  const blockers: MissingFact[] = [];
  const add = (fact: MissingFact) => { if (!blockers.some((item) => item.key === fact.key)) blockers.push(fact); };
  const respondWithBlocker = (world?: RealWorldContext): AssistResponse => {
    const priority = (fact: MissingFact) => snapshot.itinerary.some((event) => event.placeId === fact.field && event.locked) ? 0 : fact.field === "currentLocation" ? 1 : 2;
    const blocker = [...blockers].sort((a, b) => priority(a) - priority(b))[0];
    const nextState = nextResolutionState(resolutionState, blocker);
    if (!nextState) return { status: "OUT_OF_SCOPE", error: "同一个关键信息仍未能确认。本次调整已安全结束，原行程没有改变；请修改正式行程后重新发起。", retryable: false, parsedInput: parsed, impactAnalysis: impact, resolutionState };
    parsed.missingFacts = [blocker.key];
    parsed.status = "needs_input";
    return { status: "NEEDS_INPUT", parsedInput: ParsedUserInputSchema.parse(parsed), confirmedDraft: draft, impactAnalysis: impact, resolutionState: nextState, missingFact: blocker, ambiguities: world?.ambiguities.filter((item) => item.field === blocker.field) ?? [], world };
  };

  let world: RealWorldContext;
  try {
    const ground = dependencies.ground ?? ((value: unknown, abortSignal?: AbortSignal) => new WorldContextService().ground(value, abortSignal));
    world = await ground({ snapshot, request, mode: "live", confirmation: { status: "confirmed", confirmedAt: new Date().toISOString() } }, signal);
  } catch (error) {
    return { status: "UPSTREAM_UNAVAILABLE", error: error instanceof Error ? error.message : "地点与路线服务暂时不可用，请稍后重试。", retryable: true, failedStage: "GROUNDING", parsedInput: parsed, impactAnalysis: impact, resolutionState };
  }
  impact = analyzeImpact(snapshot, request, world);
  parsed.resolutionEvidence = world.resolutionEvidence;
  for (const fact of world.missingWorldFacts.filter((item) => item.kind === "user")) {
    add(missingFact(fact.field, fact.message, fact.field === "currentTime" ? "time" : "text"));
  }
  for (const ambiguity of world.ambiguities) {
    add(missingFact(ambiguity.field, `“${ambiguity.label}”有多个地点，请选择一个。`, "poi", ambiguity.candidates.map((candidate) => ({ value: candidate.poiId, label: candidate.name, description: candidate.address }))));
  }
  for (const mention of parsed.activityMentions.filter((item) => item.role === "existing_plan" && !item.startTime)) {
    if (!snapshot.itinerary.some((event) => related(event.name, mention.name))) add(missingFact(`activity:${mention.id}:startTime`, `“${mention.name}”安排在几点？`, "time"));
  }
  if (parsed.disruptions.some((item) => item.kind === "closed") && !parsed.closedPlaceIds.length) {
    const matches = snapshot.itinerary.filter((event) => parsed.disruptions.filter((item) => item.kind === "closed").some((item) => item.label.includes(event.name) || item.label.includes(event.location)));
    if (matches.length === 1) {
      parsed.closedPlaceIds = [matches[0].placeId];
      draft.closedPlaceIds = parsed.closedPlaceIds;
      request.closedPlaceIds = parsed.closedPlaceIds;
    } else {
      add(missingFact("closedPlace", "是哪个原计划地点关门了？", "event_selection", snapshot.itinerary.filter((event) => event.status !== "completed").map((event) => ({ value: event.id, label: event.name, description: event.location }))));
    }
  }
  if (blockers.length) return respondWithBlocker(world);
  if (world.status !== "ready") {
    return { status: "UPSTREAM_UNAVAILABLE", error: world.missingWorldFacts.find((item) => item.kind === "world")?.message ?? "真实地点或路线数据暂时不可用，请稍后重试。", retryable: true, failedStage: "GROUNDING", parsedInput: parsed, impactAnalysis: impact, resolutionState };
  }

  if (world.currentLocation?.city) snapshot.trip.destination = world.currentLocation.city;
  for (const resolved of world.resolvedPlaces) parsed.worldOptions!.selectedPois[resolved.placeId] = resolved.poi.poiId;
  const current = [...(world.resolutionEvidence ?? [])].reverse().find((item) => item.field === "currentLocation" && item.poiId);
  if (current?.poiId) parsed.worldOptions!.selectedPois.currentLocation = current.poiId;
  request.worldOptions = parsed.worldOptions;
  parsed.status = "confirmed";
  parsed.missingFacts = [];

  try {
    const replan = dependencies.replan ?? replanReal;
    const result = await replan({ snapshot, request, mode: "live", confirmation: { status: "confirmed", confirmedAt: new Date().toISOString() } }, undefined, { ground: async () => world }, impact, signal);
    if ("error" in result) return { status: "NO_SAFE_PLAN", error: result.error, retryable: false, failedStage: "VALIDATOR", parsedInput: parsed, impactAnalysis: impact, resolutionState, base: snapshot, request };
    return { status: "READY", parsedInput: ParsedUserInputSchema.parse(parsed), impactAnalysis: impact, resolutionState, result, base: snapshot, request };
  } catch (error) {
    return { status: "UPSTREAM_UNAVAILABLE", error: error instanceof Error ? error.message : "规划服务暂时不可用，请稍后重试。", retryable: true, failedStage: "PLANNER", parsedInput: parsed, impactAnalysis: impact, resolutionState };
  }
}
