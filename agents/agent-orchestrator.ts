import { z } from "zod";
import {
  ConfirmedDraftSchema,
  MissingFactSchema,
  ParsedUserInputSchema,
  ReplanningRequestSchema,
  ResolutionStateSchema,
  SnapshotSchema,
  TimeSchema,
  MAX_RAW_INPUT_LENGTH,
  RAW_INPUT_TOO_LONG_MESSAGE,
  type AgentResult,
  type ConfirmedDraft,
  type ConditionalAdvice,
  type ImpactAnalysis,
  type MissingFact,
  type ParsedUserInput,
  type ResolutionState,
  type Snapshot,
} from "../types";
import { BrowserLocationSchema, TravelModeSchema, type RealWorldContext } from "../types/world";
import { ActivityCoverageError, DeepSeekSemanticParser } from "../services/semantic-parser";
import { confirmedDraftFromParsed, hydrateParsedPlans, planningSnapshotFromDraft, retainedFactsFromDraft } from "../services/itinerary-domain";
import { confirmedOriginals, reconcileActivityFacts, snapshotActivityFacts } from "../services/activity-facts";
import { analyzeImpact } from "../services/impact-analysis";
import { WorldContextService } from "../services/world/world-context-service";
import { allowedModes } from "../services/world/context-resolution";
import { protectionPolicyForActivity, stationLevelLocation } from "../services/protection-policy";
import { replanReal } from "./real-replanning-agent";
import type { FailureInfo, FailureStage } from "../types/failures";
import {
  failureInfo,
  failureMessage,
  failureStatus,
  modelInvalidOutput,
  normalizeFailure,
  normalizeModelFailure,
  ServiceFailure,
} from "../services/failures";
import { RequestExecution } from "../services/request-execution";

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
  rawText: z.string().trim().max(MAX_RAW_INPUT_LENGTH, RAW_INPUT_TOO_LONG_MESSAGE).optional(),
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
type ResponseContext = { parsedInput: ParsedUserInput; impactAnalysis: ImpactAnalysis; resolutionState: ResolutionState };
type AssistFailureStatus = "AUTH_REQUIRED" | "RATE_LIMITED" | "INVALID_REQUEST" | "UPSTREAM_UNAVAILABLE" | "REQUEST_TIMEOUT" | "SYSTEM_ERROR";

export type AssistResponse =
  | (ResponseContext & { status: "CONDITIONAL"; message: string; advice: ConditionalAdvice })
  | (ResponseContext & { status: "NEEDS_INPUT"; confirmedDraft: ConfirmedDraft; missingFact: MissingFact; ambiguities?: RealWorldContext["ambiguities"]; world?: RealWorldContext })
  | (ResponseContext & { status: "READY"; result: AgentResult; base: Snapshot; request: ReturnType<typeof ReplanningRequestSchema.parse> })
  | (ResponseContext & { status: "NO_SAFE_PLAN"; result?: AgentResult; base?: Snapshot; request?: ReturnType<typeof ReplanningRequestSchema.parse>; message: string })
  | (Partial<ResponseContext> & { status: "OUT_OF_SCOPE"; message: string })
  | (Partial<ResponseContext> & { status: AssistFailureStatus; message: string; failure: FailureInfo });

const emptyResolutionState = (): ResolutionState => ({ currentBlockerKey: null, sameBlockerCount: 0, roundCount: 0, answeredFields: [], questionHistory: [] });

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
    activityFacts: draft.activityFacts,
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

function refreshMessageFactPolicy(fact: ConfirmedDraft["activityFacts"][number]) {
  if (fact.origin !== "message") return fact;
  if (fact.commitment === "flexible") return { ...fact, protectionPolicy: undefined };
  return {
    ...fact,
    protectionPolicy: protectionPolicyForActivity({
      name: fact.name,
      location: fact.placeQuery,
      sourceText: fact.sourceText ?? fact.name,
      startTime: fact.startTime,
      endTime: fact.endTime,
      durationMinutes: fact.durationMinutes,
      commitment: fact.commitment,
    }),
  };
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
    const fact = next.activityFacts.find(item => item.id === answer.eventId || item.placeId === answer.eventId);
    if (!fact || fact.role !== "existing_plan") throw new Error("所选活动不属于本次已确认行程。");
    if (answer.field === "closedPlace") next.closedPlaceIds = [fact.placeId];
    else throw new Error("当前问题不接受活动选择。");
  } else if (answer.kind === "time") {
    if (answer.field === "currentTime") {
      next.context.currentTime = answer.value;
      next.context.stateCapturedAt = new Date().toISOString();
      next.contextSources.currentTime = "user";
    } else {
      const match = /^activity:(.+):startTime$/.exec(answer.field);
      const id = match?.[1];
      const fact = id && next.activityFacts.find((item) => item.id === id);
      if (!fact) throw new Error("当前时间回答没有对应到已确认活动。");
      fact.startTime = answer.value;
      fact.startTimeSource = "user";
      Object.assign(fact, refreshMessageFactPolicy(fact));
    }
  } else if (answer.kind === "text") {
    if (answer.field === "currentLocation") {
      next.context.currentLocation = answer.value;
      next.contextSources.currentLocation = "user";
    } else if (answer.field === "destination") {
      next.destination = answer.value;
    } else if (/^activity:.+:role$/.test(answer.field)) {
      const id = /^activity:(.+):role$/.exec(answer.field)?.[1];
      const fact = next.activityFacts.find(item => item.id === id);
      if (!fact || fact.role !== "uncertain" || !["existing_plan", "considering", "reference"].includes(answer.value)) {
        throw new Error("当前分类回答没有对应到待确认活动。");
      }
      fact.role = answer.value as typeof fact.role;
    } else {
      const match = /^activity:(.+):location$/.exec(answer.field);
      const id = match?.[1];
      const fact = id && next.activityFacts.find((item) => item.id === id);
      if (!fact) throw new Error("当前文本回答没有对应到已确认字段。");
      const stationLocation = stationLevelLocation(answer.value).location;
      fact.placeQuery = stationLocation;
      Object.assign(fact, refreshMessageFactPolicy(fact));
    }
  }
  return ConfirmedDraftSchema.parse(next);
}

function normalizePlanningFacts(snapshot: Snapshot, parsed: ParsedUserInput) {
  if (parsed.parser === "llm" && !parsed.activityFacts.length) {
    const activityFacts = reconcileActivityFacts(snapshot, []);
    parsed = ParsedUserInputSchema.parse({ ...parsed, activityFacts });
  }
  const modes = allowedModes(parsed.rawText, parsed.worldOptions?.travelMode, undefined, parsed.constraints.map((constraint) => constraint.value));
  parsed.worldOptions = { selectedPois: { ...parsed.worldOptions?.selectedPois }, ...(modes.length ? { allowedTravelModes: modes } : {}), ...(parsed.worldOptions?.travelMode ? { travelMode: parsed.worldOptions.travelMode } : {}) };
  return hydrateParsedPlans(snapshot, parsed);
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

function buildRequest(snapshot: Snapshot, parsed: ParsedUserInput, draft: ConfirmedDraft) {
  const activityFacts = retainedFactsFromDraft(snapshot, draft);
  return ReplanningRequestSchema.parse({ reason: requestReason(parsed), freeText: parsed.rawText, currentState: snapshot.state, closedPlaceIds: parsed.closedPlaceIds, variation: 0, stateSources: parsed.contextSources, worldOptions: parsed.worldOptions,
    activityFacts,
    ...(draft.removedLockedIds.length ? { confirmedDraftChanges: { removedLockedIds: draft.removedLockedIds } } : {}) });
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
  return analyzeImpact(snapshot, ReplanningRequestSchema.parse({ reason: "other", freeText: "", currentState: snapshot.state, closedPlaceIds: [], variation: 0, stateSources: snapshot.stateSources, activityFacts: snapshotActivityFacts(snapshot) }));
}

function assistFailure(
  error: unknown,
  stage: FailureStage,
  traceId: string,
  context: Partial<ResponseContext> = {},
  message?: string,
): AssistResponse {
  const failure = normalizeFailure(error, stage);
  if (failure.code === "REQUEST_CANCELLED") throw failure;
  return {
    ...context,
    status: failureStatus(failure.code),
    message: message ?? failureMessage(failure.code),
    failure: failureInfo(failure, traceId),
  };
}

export async function runAgentAssist(raw: unknown, execution: RequestExecution = new RequestExecution({ deadlineMs: null }), dependencies: AssistDependencies = {}): Promise<AssistResponse> {
  const signal = execution.signal;
  const traceId = execution.traceId;
  const input = AssistRequestSchema.parse(raw);
  if (input.snapshot.mode !== "user" || Object.values(input.snapshot.stateSources).includes("demo")) throw new ServiceFailure("INVALID_REQUEST", "REQUEST", { retryable: false, detail: "DEMO_CONTEXT_REJECTED" });
  const base = refreshSystemTime(input.snapshot);
  let resolutionState = input.resolutionState ?? emptyResolutionState();
  let parsed: ParsedUserInput;
  let draft: ConfirmedDraft;
  let snapshot: Snapshot;

  if (input.confirmedDraft) {
    draft = input.answer ? applyAnswer(input.confirmedDraft, input.answer, resolutionState) : input.confirmedDraft;
    if (input.answer) resolutionState = answeredResolutionState(resolutionState, input.answer.field);
    parsed = draftToParsed(draft);
    snapshot = planningSnapshotFromDraft(base, draft);
  } else {
    try {
      parsed = await execution.measure("PARSER", () => dependencies.parse
        ? dependencies.parse(base, input.rawText!, signal)
        : new DeepSeekSemanticParser().parse(base, input.rawText!, undefined, signal, undefined, execution));
    } catch (error) {
      if (error instanceof ActivityCoverageError) {
        return assistFailure(modelInvalidOutput("PARSER", 2, error), "PARSER", traceId, {}, "原文中的部分原安排仍未能可靠识别。请把每项安排分别写清楚后重新分析；本次不会生成缺项方案。");
      }
      return assistFailure(normalizeModelFailure(error,"PARSER",{externalSignal:signal}), "PARSER", traceId);
    }
    parsed = normalizePlanningFacts(base, parsed);
    if (parsed.missingFacts.some(field => field.startsWith("activityMatch:"))) {
      return {
        status: "OUT_OF_SCOPE",
        message: "存在多个同名原安排，无法确定你要修改哪一项。请在描述中补充它原来的时间或地点后重新分析。",
        parsedInput: parsed,
        impactAnalysis: noImpact(base),
        resolutionState,
      };
    }
    draft = confirmedDraftFromParsed(base, parsed);
    snapshot = planningSnapshotFromDraft(base, draft);
  }

  const retainedFacts = retainedFactsFromDraft(base, draft);
  const confirmedActivities = confirmedOriginals(retainedFacts);
  if (!confirmedActivities.length &&
      draft.activityFacts.some(fact => fact.role === "considering")) {
    return { status: "OUT_OF_SCOPE", message: "我只能帮助你救回已确定的行程，暂时不支持对比多个备选目的地哟", parsedInput: parsed, impactAnalysis: noImpact(snapshot), resolutionState };
  }
  const uncertainActivity = draft.activityFacts.find(fact => fact.role === "uncertain");
  if (uncertainActivity) {
    const blocker = missingFact(`activity:${uncertainActivity.id}:role`, `“${uncertainActivity.name}”是已经决定的原安排，还是仍在考虑？`, "text", [
      { value: "existing_plan", label: "已经决定的原安排" },
      { value: "considering", label: "还在考虑" },
      { value: "reference", label: "仅作背景" },
    ]);
    const nextState = nextResolutionState(resolutionState, blocker);
    if (!nextState) return { status: "OUT_OF_SCOPE", message: "这项安排仍未能确认，请修改描述后重新分析。", parsedInput: parsed, impactAnalysis: noImpact(snapshot), resolutionState };
    parsed.missingFacts = [blocker.key];
    parsed.status = "needs_input";
    return { status: "NEEDS_INPUT", parsedInput: ParsedUserInputSchema.parse(parsed), confirmedDraft: draft, impactAnalysis: noImpact(snapshot), resolutionState: nextState, missingFact: blocker };
  }

  if (!hasActionableIntent(parsed, parsed.rawText)) {
    return { status: "OUT_OF_SCOPE", message: "我只处理已有单日行程中的明确变化或明确优化请求。请说明发生了什么变化，例如“下雨了，把下午的户外行程调一下”。", parsedInput: parsed, impactAnalysis: noImpact(snapshot), resolutionState };
  }
  if (!confirmedActivities.length) {
    const message = draft.activityFacts.some(fact => fact.role === "considering")
      ? "你提到的是尚未决定的备选活动。请先告诉我最终想安排哪一项，以及大致时间和地点。"
      : "请告诉我接下来想做什么，以及大致时间和地点；也可以先到创建页整理今天的行程。";
    return { status: "OUT_OF_SCOPE", message, parsedInput: parsed, impactAnalysis: noImpact(snapshot), resolutionState };
  }

  const unknownFixed = confirmedActivities.filter(fact => fact.commitment !== "flexible" && fact.startTime === null);
  if (unknownFixed.length) {
    const flexible = confirmedActivities.filter(fact => fact.commitment === "flexible");
    const advice: ConditionalAdvice = {
      heading: "可以先考虑的调整（尚未验证）",
      suggestions: [
        ...flexible.map(fact => fact.startTime
          ? `“${fact.name}”原定 ${fact.startTime}。若不与预约冲突，可先保留这段；若时间冲突，则考虑顺延或舍弃，需补充预约时间和核对路线后决定。`
          : `“${fact.name}”没有原定开始时间。若预约尚有余量，可先安排这项活动；若预约较近，则先赴预约、把这项活动顺延或舍弃。`),
        ...unknownFixed.map(fact => `“${fact.name}”仍按固定安排保留，预约时间尚未提供，暂不填写或猜测到达时间。`),
      ],
      warning: "预约时间未提供，无法验证是否赶上；地点和路线也尚未完成校验。这些是条件性建议，不能直接接受为最终方案。",
    };
    return { status: "CONDITIONAL", message: advice.warning, advice, parsedInput: parsed, impactAnalysis: noImpact(snapshot), resolutionState };
  }
  const request = buildRequest(snapshot, parsed, draft);
  let impact = analyzeImpact(snapshot, request);
  const blockers: MissingFact[] = [];
  const add = (fact: MissingFact) => { if (!blockers.some((item) => item.key === fact.key)) blockers.push(fact); };
  const respondWithBlocker = (world?: RealWorldContext): AssistResponse => {
    const priority = (fact: MissingFact) => confirmedActivities.some(activity => activity.placeId === fact.field && activity.commitment !== "flexible") ? 0 : fact.field === "currentLocation" ? 1 : 2;
    const blocker = [...blockers].sort((a, b) => priority(a) - priority(b))[0];
    const nextState = nextResolutionState(resolutionState, blocker);
    if (!nextState) return { status: "OUT_OF_SCOPE", message: "同一个关键信息仍未能确认。本次调整已安全结束，原行程没有改变；请修改正式行程后重新发起。", parsedInput: parsed, impactAnalysis: impact, resolutionState };
    parsed.missingFacts = [blocker.key];
    parsed.status = "needs_input";
    return { status: "NEEDS_INPUT", parsedInput: ParsedUserInputSchema.parse(parsed), confirmedDraft: draft, impactAnalysis: impact, resolutionState: nextState, missingFact: blocker, ambiguities: world?.ambiguities.filter((item) => item.field === blocker.field) ?? [], world };
  };

  for (const fact of confirmedActivities) {
    if (!fact.placeQuery?.trim()) add(missingFact(`activity:${fact.id}:location`, `“${fact.name}”具体是哪个地点？`));
  }
  if (blockers.length) return respondWithBlocker();

  let world: RealWorldContext;
  try {
    const ground = dependencies.ground ?? ((value: unknown, abortSignal?: AbortSignal) => new WorldContextService().ground(value, abortSignal, execution));
    world = await execution.measure("GROUNDING", () => ground({ snapshot, request, mode: "live", confirmation: { status: "confirmed", confirmedAt: new Date().toISOString() } }, signal));
  } catch (error) {
    return assistFailure(error, "GROUNDING", traceId, { parsedInput: parsed, impactAnalysis: impact, resolutionState });
  }
  impact = analyzeImpact(snapshot, request, world);
  parsed.resolutionEvidence = world.resolutionEvidence;
  for (const fact of world.missingWorldFacts.filter((item) => item.kind === "user")) {
    if (["currentLocation", "currentTime", "destination", "travelMode"].includes(fact.field)) {
      add(missingFact(fact.field, fact.message, fact.field === "currentTime" ? "time" : "text"));
      continue;
    }
    const matchingActivities = request.activityFacts.filter(activity => activity.placeId === fact.field);
    if (matchingActivities.length !== 1) {
      return assistFailure(new ServiceFailure("INTERNAL_ERROR", "GROUNDING", { retryable: true, detail: "AMBIGUITY_MAPPING_FAILED" }), "GROUNDING", traceId, { parsedInput: parsed, impactAnalysis: impact, resolutionState }, "地点补充问题无法安全对应到唯一活动，原行程没有改变。请核对正式行程后重试。");
    }
    add(missingFact(`activity:${matchingActivities[0].id}:location`, fact.message));
  }
  for (const ambiguity of world.ambiguities) {
    add(missingFact(ambiguity.field, `“${ambiguity.label}”有多个地点，请选择一个。`, "poi", ambiguity.candidates.map((candidate) => ({ value: candidate.poiId, label: candidate.displayName ?? candidate.name, description: candidate.address }))));
  }
  if (parsed.disruptions.some((item) => item.kind === "closed") && !parsed.closedPlaceIds.length) {
    const closedLabels = parsed.disruptions.filter(item => item.kind === "closed").map(item => item.label);
    const matches = request.activityFacts.filter(fact => fact.role === "existing_plan" && fact.progress !== "completed")
      .map(fact => ({ id: fact.id, placeId: fact.placeId, name: fact.name, location: fact.placeQuery ?? "" }))
      .filter(event => closedLabels.some(label => [event.name, event.name.replace(/^(?:去|到|吃|前往|参观|游览)/, ""), event.location]
        .some(value => value.length >= 2 && label.includes(value))));
    if (matches.length === 1) {
      parsed.closedPlaceIds = [matches[0].placeId];
      draft.closedPlaceIds = parsed.closedPlaceIds;
      request.closedPlaceIds = parsed.closedPlaceIds;
    } else {
      add(missingFact("closedPlace", "是哪个原计划地点关门了？", "event_selection", [
        ...request.activityFacts.filter(fact => fact.role === "existing_plan" && fact.progress !== "completed")
          .map(fact => ({ value: fact.id, label: fact.name, description: fact.placeQuery ?? "" })),
      ]));
    }
  }
  if (blockers.length) return respondWithBlocker(world);
  if (world.status !== "ready") {
    return assistFailure(new ServiceFailure("MAP_PROVIDER_ERROR", "GROUNDING", { retryable: true, provider: "amap", detail: "WORLD_CONTEXT_UNAVAILABLE" }), "GROUNDING", traceId, { parsedInput: parsed, impactAnalysis: impact, resolutionState }, world.missingWorldFacts.find((item) => item.kind === "world")?.message ?? "真实地点或路线数据暂时不可用，请稍后重试。");
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
    const result = await replan({ snapshot, request, mode: "live", confirmation: { status: "confirmed", confirmedAt: new Date().toISOString() } }, undefined, { ground: async () => world }, impact, signal, execution);
    if ("world" in result) return assistFailure(new ServiceFailure("MAP_PROVIDER_ERROR", "GROUNDING", { retryable: true, provider: "amap", detail: "REPLAN_WORLD_CONTEXT_UNAVAILABLE" }), "GROUNDING", traceId, { parsedInput: parsed, impactAnalysis: impact, resolutionState }, result.message);
    if (!result.ok || !result.plan) return { status: "NO_SAFE_PLAN", message: result.message, parsedInput: parsed, impactAnalysis: impact, resolutionState, result, base: snapshot, request };
    return { status: "READY", parsedInput: ParsedUserInputSchema.parse(parsed), impactAnalysis: impact, resolutionState, result, base: snapshot, request };
  } catch (error) {
    return assistFailure(error, "PLANNER", traceId, { parsedInput: parsed, impactAnalysis: impact, resolutionState });
  }
}
