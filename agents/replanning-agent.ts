import { buildContext } from "./context-builder";
import { validatePlan } from "../validators";
import { ProposedPlanSchema, type AgentResult, type Violation } from "../types";
import type { Planner } from "../services/openai";
export type AgentLogger = (
  name: string,
  properties: Record<string, unknown>,
) => Promise<void>;

const validationChecks: Array<[Violation["code"], string]> = [
  ["locked_event", "锁定安排"],
  ["time_conflict", "时间不重叠"],
  ["travel_time", "区域路程"],
  ["opening_hours", "营业时间"],
  ["budget", "预算"],
  ["past_event", "当前时间后的安排"],
  ["duration", "活动时长"],
  ["place_data", "地点数据"],
  ["change_accounting", "变更完整性"],
];

export function decisionTrace(
  context: Awaited<ReturnType<typeof buildContext>>,
  plan: ReturnType<typeof ProposedPlanSchema.parse> | null,
  violations: Violation[],
): NonNullable<AgentResult["decisionTrace"]> {
  const inputFacts: NonNullable<AgentResult["decisionTrace"]>["inputFacts"] = [
    {
      field: "当前时间",
      value: context.state.currentTime,
      source: context.stateSources.currentTime,
    },
    ...(context.state.currentLocation
      ? [
          {
            field: "当前地点",
            value: context.state.currentLocation,
            source: context.stateSources.currentLocation,
          },
        ]
      : []),
    ...(context.state.weather
      ? [
          {
            field: "天气",
            value: context.state.weather,
            source: context.stateSources.weather,
          },
        ]
      : []),
    ...(context.state.energyLevel
      ? [
          {
            field: "体力状态",
            value: context.state.energyLevel,
            source: context.stateSources.energyLevel,
          },
        ]
      : []),
    ...(context.disruption.freeText.trim()
      ? [
          {
            field: "用户报告的变化",
            value: context.disruption.freeText.trim(),
            source: context.stateSources.disruption,
          },
        ]
      : []),
    ...context.lockedEvents.map((event) => ({
      field: "锁定安排",
      value: `${event.startTime} ${event.name}`,
      source: "user" as const,
    })),
    ...(context.removedLockedIds??[]).map((id) => ({
      field: "用户明确删除的固定安排",
      value: id,
      source: "user" as const,
    })),
  ];
  const decisions: NonNullable<AgentResult["decisionTrace"]>["decisions"] = plan
    ? [
        ...(context.removedLockedIds??[]).map((id) => ({
          eventId: id,
          decision: "按用户明确指令移除固定安排",
          reason: "该删除动作由确认草稿中的 removedLockedIds 明确表达，并非列表合并时静默丢失。",
          evidence: ["用户在确认界面明确确认删除。"],
        })),
        ...context.lockedEvents.map((event) => ({
          eventId: event.id,
          decision: `保留 ${event.name}`,
          reason: "该活动是锁定安排，系统不会自动删除或改动时间地点。",
          evidence: plan.events.some(
            (next) =>
              next.id === event.id &&
              next.startTime === event.startTime &&
              next.location === event.location,
          )
            ? [`新行程保留在 ${event.startTime}，地点为 ${event.location}。`]
            : ["锁定安排未被完整保留。"],
        })),
        ...plan.removedEvents.map((change) => ({
          eventId: change.eventId,
          decision: `移除 ${change.name}`,
          reason: change.reason,
          evidence: [
            `该活动未出现在新的可执行行程中。`,
            `约束：${change.constraint}。`,
          ],
        })),
        ...plan.movedEvents.map((change) => ({
          eventId: change.eventId,
          decision: `建议改到 ${change.suggestedDate} ${change.suggestedStart}`,
          reason: change.reason,
          evidence: [change.note, `约束：${change.constraint}。`],
        })),
        ...plan.events
          .filter(event=>context.existingItinerary.some(old=>old.id===event.id&&!old.locked&&(old.startTime!==event.startTime||old.endTime!==event.endTime)))
          .map(event=>({eventId:event.id,decision:`调整 ${event.name} 到 ${event.startTime}–${event.endTime}`,reason:event.reason,evidence:[`输入变化：${context.disruption.freeText}`,`路程校验：${violations.some(v=>v.code==="travel_time"&&v.eventId===event.id)?"未通过":"通过"}`]})),
        ...plan.events
          .filter(
            (event) =>
              !context.existingItinerary.some((old) => old.id === event.id),
          )
          .map((event) => ({
            eventId: event.id,
            decision: `新增 ${event.name}`,
            reason: event.reason,
            evidence: [
              `安排在 ${event.startTime}–${event.endTime}。`,
              event.constraint,
            ],
          })),
      ]
    : [];
  const validationEvidence: NonNullable<
    AgentResult["decisionTrace"]
  >["validationEvidence"] = validationChecks.map(([code, check]) => {
    const failures = violations.filter((item) => item.code === code);
    const hasUnknownCost = context.existingItinerary.some(
      (event) => event.estimatedCostKnown === false,
    );
    const unavailable =
      (Boolean(context.world) && code === "opening_hours") ||
      (code === "budget" &&
        (context.state.remainingBudget === undefined || hasUnknownCost)) ||
      (code === "travel_time" && (!context.state.currentLocation || Boolean(context.world && (!plan || !context.world.routes.length)))) ||
      (Boolean(context.world) && code === "budget" && (plan?.events.some(e=>e.estimatedCostKnown===false) || context.world!.routes.some(r=>r.fare===undefined)));
    return {
      check,
      status: unavailable
        ? ("not_checked" as const)
        : failures.length
          ? ("failed" as const)
          : ("passed" as const),
      detail: unavailable
        ? code === "opening_hours" ? "高德基础 POI 数据未验证实时营业状态和营业时间。" : code === "budget" && hasUnknownCost
          ? "至少一项活动的费用未提供，预算未完整检查。"
          : "用户尚未提供完成这项检查所需的信息。"
        : failures.length
          ? failures.map((item) => item.message).join("；")
          : context.world && code==="travel_time" ? "使用高德路线秒数并向上取整到分钟，检查逐段到达时间。" : "已通过。",
      source:
        code === "budget"
          ? context.state.remainingBudget === undefined
            ? ("unset" as const)
            : ("user" as const)
          : ("system" as const),
    };
  });
  validationEvidence.push(
    {
      check: "天气条件",
      status: context.world ? context.world.weather.status==="available"?"passed":"not_checked" : context.state.weather ? "passed" : "not_checked",
      detail: context.world ? context.world.weather.status==="available"?`高德天气：${context.world.weather.condition}；抓取于 ${context.world.weather.fetchedAt}。`:`高德天气：${context.world.weather.status}。未用示例天气替代。` : context.state.weather
        ? "已使用用户明确提供的天气状态。"
        : "未提供天气，规划没有假设天气状态。",
      source: context.stateSources.weather,
    },
    {
      check: "当前位置",
      status: context.state.currentLocation ? "passed" : "not_checked",
      detail: context.state.currentLocation
        ? "已使用用户确认的当前位置。"
        : "未提供当前位置，无法检查首次出发路程。",
      source: context.stateSources.currentLocation,
    },
  );
  if(context.world){
    for(const evidence of context.world.resolutionEvidence??[])inputFacts.push({field:`地点解析 ${evidence.field}`,value:`${evidence.query} / ${evidence.reason} / ${evidence.poiId??"尚未确定"}`,source:"system"});
    for(const event of plan?.events??[])if(event.durationSource==="unknown"||event.durationSource==="suggested")validationEvidence.push({check:`${event.name}停留时长`,status:"not_checked",detail:event.durationSource==="unknown"?"只核验固定到达时刻，结束时间未知；系统没有强制用户补充时长。":"本方案使用了建议停留时长，非用户提供事实。",source:"unset"});
    inputFacts.push(...context.world.resolvedPlaces.map(p=>({field:"高德地点",value:`${p.poi.name} / ${p.poi.poiId} / GCJ02 / ${p.poi.fetchedAt}`,source:"system" as const})));
    for(const route of context.world.routes.filter(r=>plan?.events.some(e=>e.placeId===r.destination.id)))inputFacts.push({field:"高德路线",value:`${route.origin.id} → ${route.destination.id} / ${route.travelMode} / ${route.durationSeconds??"不可用"} 秒 / ${route.fetchedAt}`,source:"system"});
    if(context.world.currentLocation)inputFacts.push({field:"位置来源",value:`${context.world.currentLocation.source} / GCJ02 / ${context.world.currentLocation.capturedAt}`,source:"system"});
  }
  return { inputFacts, decisions, validationEvidence };
}

export async function replan(
  input: unknown,
  planner: Planner,
  mode: "demo" | "local" | "live",
  log: AgentLogger = async () => {},
): Promise<AgentResult> {
  const context = buildContext(input),
    id = crypto.randomUUID();
  const attempts: AgentResult["attempts"] = [];
  let feedback: Violation[] = [];
  const record = async (name: string, properties: Record<string, unknown>) => {
    try {
      await log(name, { planId: id, mode, model: planner.name, ...properties });
    } catch {
      /* Analytics must not interrupt planning. */
    }
  };
  await record("replan_started", {});
  // One original attempt + at most two regenerations. No hidden SDK retries.
  for (let i = 0; i < 3; i++) {
    if (i > 0) await record("replan_regenerated", { regenerationCount: i });
    const started = Date.now();
    let candidate: unknown;
    try {
      candidate = await planner.generate(context, feedback, i);
      feedback = validatePlan(context, candidate);
    } catch {
      feedback = [
        {
          code: "schema",
          message:
            "规划服务未能生成完整且有效的方案结构，请重试或切换到模拟模式。",
        },
      ];
    }
    attempts.push({
      attempt: i + 1,
      violations: feedback,
      durationMs: Date.now() - started,
    });
    if (!feedback.length) {
      const plan = ProposedPlanSchema.parse(candidate);
      await record("replan_generated", {
        regenerationCount: i,
        attemptCount: i + 1,
      });
      return {
        id,
        ok: true,
        plan,
        attempts,
        mode,
        model: planner.name,
        message: "已通过当前数据可执行的规则检查。",
        verificationLevel: "partial",
        context,
        decisionTrace: decisionTrace(context, plan, feedback),
      };
    }
    await record("replan_validation_failed", {
      attempt: i + 1,
      violations: feedback,
    });
  }
  return {
    id,
    ok: false,
    plan: null,
    attempts,
    mode,
    model: planner.name,
    message: "暂时无法生成完全有效的方案，请调整其中一项约束后再试。",
    verificationLevel: "partial",
    context,
    decisionTrace: decisionTrace(context, null, feedback),
  };
}
