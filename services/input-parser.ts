import {
  ParsedUserInputSchema,
  type ParsedUserInput,
  type ReplanningRequest,
  type Snapshot,
} from "../types";
import { parseItineraryText } from "./itinerary-parser";
import { inferRescueRequest } from "./rescue-intent";

const disruptionRules: Array<{
  kind: ReplanningRequest["reason"];
  label: string;
  pattern: RegExp;
}> = [
  { kind: "weather", label: "下雨", pattern: /下雨|暴雨|rain|storm/i },
  {
    kind: "late",
    label: "晚点或迟到",
    pattern: /晚点|迟到|来不及|late|delay/i,
  },
  {
    kind: "tired",
    label: "体力较低",
    pattern: /太累|有点累|疲惫|没力气|tired|exhausted/i,
  },
  { kind: "closed", label: "地点关闭", pattern: /关门|关闭|歇业|closed|shut/i },
  {
    kind: "discovery",
    label: "发现新去处",
    pattern: /新去处|想去|发现了|discovered/i,
  },
  {
    kind: "changed_mind",
    label: "改变主意",
    pattern: /改变主意|不想去|换一个|changed my mind/i,
  },
  {
    kind: "optimize",
    label: "优化路线",
    pattern: /帮我优化|优化路线|优化行程|optimize/i,
  },
];

function hasExplicitCurrentTime(text: string) {
  return /(?:现在|当前|此刻|now|currently)\s*(?:是|为|已经|已|都|at)?\s*\d{1,2}/i.test(
    text,
  );
}

export function parseUnifiedInput(
  snapshot: Snapshot,
  rawText: string,
  hint?: ReplanningRequest["reason"],
): ParsedUserInput {
  const text = rawText.trim();
  const inferred = inferRescueRequest(snapshot, text, hint);
  const unsafeMultiClause =
    /\d{1,2}(?:(?::|：)[0-5]\d|点)[\s\S]*\d{1,2}(?:(?::|：)[0-5]\d|点)/.test(text) ||
    (/[吗么？?]/.test(text) && /(?:现在|当前|此刻).*(?:预订|预约|固定)/.test(text));
  const plans = parseItineraryText(
    text,
    snapshot.trip.destination,
    inferred.currentState.currentLocation,
  ).map((item) => ({ ...item, source: "user" as const }));
  const disruptions = disruptionRules
    .filter((rule) => rule.pattern.test(text) || hint === rule.kind)
    .map((rule) => ({
      kind: rule.kind,
      label: rule.label,
      source: "user" as const,
    }));
  if (hint && !disruptions.some((item) => item.kind === hint))
    disruptions.push({
      kind: hint,
      label: hint === "other" ? "其他变化" : hint,
      source: "user",
    });

  const optimize = disruptions.some((item) => item.kind === "optimize");
  const hasChange = disruptions.some((item) => item.kind !== "optimize");
  const intent = plans.length
    ? hasChange || optimize
      ? "mixed"
      : "create"
    : optimize
      ? "optimize"
      : "rescue";
  const allPlans = [...snapshot.itinerary, ...plans];
  const keepConstraints = allPlans
    .filter(
      (event) =>
        event.locked ||
        (/保留|别动|不要改|keep/i.test(text) &&
          text.toLowerCase().includes(event.name.toLowerCase())) ||
        (/保留.*晚餐|晚餐.*别动/.test(text) && /dinner|晚餐/i.test(event.name)),
    )
    .map((event) => ({
      kind: "keep" as const,
      value: `${event.startTime} ${event.name}`,
      source: "user" as const,
    }));
  const contextSources = {
    ...snapshot.stateSources,
    currentTime: hasExplicitCurrentTime(text)
      ? ("user" as const)
      : snapshot.stateSources.currentTime,
    currentLocation:
      inferred.currentState.currentLocation !== snapshot.state.currentLocation
        ? ("user" as const)
        : snapshot.stateSources.currentLocation,
    weather:
      inferred.currentState.weather !== snapshot.state.weather
        ? ("user" as const)
        : snapshot.stateSources.weather,
    energyLevel:
      inferred.currentState.energyLevel !== snapshot.state.energyLevel
        ? ("user" as const)
        : snapshot.stateSources.energyLevel,
    disruption: disruptions.length ? ("user" as const) : ("unset" as const),
  };
  const context = {
    currentDate: inferred.currentState.currentDate,
    currentTime: inferred.currentState.currentTime,
    ...(inferred.currentState.currentLocation
      ? { currentLocation: inferred.currentState.currentLocation }
      : {}),
    ...(inferred.currentState.weather
      ? { weather: inferred.currentState.weather }
      : {}),
    ...(inferred.currentState.energyLevel
      ? { energyLevel: inferred.currentState.energyLevel }
      : {}),
    ...(inferred.currentState.remainingBudget !== undefined
      ? { remainingBudget: inferred.currentState.remainingBudget }
      : {}),
  };
  const hasItinerary = snapshot.itinerary.length > 0 || plans.length > 0;
  const missingFacts: string[] = [];
  if (!hasItinerary) missingFacts.push("existingPlans");
  if (!hasChange && !optimize) missingFacts.push("disruptionOrOptimize");
  if (!context.currentLocation) missingFacts.push("currentLocation");
  if (
    disruptions.some((item) => item.kind === "closed") &&
    !allPlans.some(
      (event) =>
        text.toLowerCase().includes(event.name.toLowerCase()) ||
        text.toLowerCase().includes(event.location.toLowerCase()),
    )
  )
    missingFacts.push("closedPlace");

  return ParsedUserInputSchema.parse({
    rawText: text,
    intent,
    existingPlans: plans,
    disruptions,
    constraints: keepConstraints,
    context,
    contextSources,
    missingFacts: [...new Set(missingFacts)],
    status: missingFacts.length ? "needs_input" : "draft",
    parser: "deterministic_fallback",
    parserModel: null,
    parseWarnings: unsafeMultiClause
      ? [
          "这段话包含多个时间或问句关系，本地规则不会猜测它们分别属于哪个活动；请使用 AI 解析或在确认页逐项补充。",
        ]
      : [],
    activityMentions: [],
  });
}

export function confirmParsedInput(input: ParsedUserInput): ParsedUserInput {
  if (input.missingFacts.length) return { ...input, status: "needs_input" };
  return ParsedUserInputSchema.parse({ ...input, status: "confirmed" });
}
