import { minutes } from "../lib/time";
import {
  ProtectionPolicySchema,
  type ActivityFact,
  type ProtectionPolicy,
} from "../types";

type PolicyInput = {
  name: string;
  location: string | null;
  sourceText: string;
  startTime: string | null;
  endTime?: string | null;
  durationMinutes?: number | null;
  commitment: "fixed" | "flexible" | "uncertain";
};

const stationExitSuffix =
  /\s*[（(]?\s*(?:[A-Za-z]|\d+|[一二三四五六七八九十]+)\s*号?\s*(?:出入口|出口|口)\s*[）)]?\s*$/u;

export const TRANSPORT_BUFFER_POLICY = {
  trainMinutes: 45,
  domesticFlightMinutes: 120,
  checkedBaggageFlightMinutes: 150,
  internationalFlightMinutes: 180,
} as const;

export function stationLevelLocation(value: string) {
  const trimmed = value.trim();
  if (!/(?:地铁站|火车站|高铁站|客运站|机场|航站楼|站)/u.test(trimmed)) {
    return { location: trimmed, note: null as string | null };
  }
  const location = trimmed.replace(stationExitSuffix, "").trim();
  return {
    location: location || trimmed,
    note: location && location !== trimmed ? trimmed : null,
  };
}

function explicitTimes(text: string, primary: string | null) {
  const values = new Set<string>();
  if (primary) values.add(primary);
  for (const match of text.matchAll(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?=\D|$)/g)) {
    values.add(`${match[1].padStart(2, "0")}:${match[2]}`);
  }
  for (const match of text.matchAll(/(?:(上午|下午|晚上|中午|凌晨)\s*)?(\d{1,2})\s*[点時时](?:\s*(\d{1,2})\s*分?)?/g)) {
    let hour = Number(match[2]);
    const minute = Number(match[3] ?? 0);
    if (["下午", "晚上"].includes(match[1] ?? "") && hour < 12) hour += 12;
    if (match[1] === "中午" && hour < 11) hour += 12;
    if (match[1] === "凌晨" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) {
      values.add(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  return [...values].sort();
}

function transportBuffer(text: string, kind: "train" | "flight") {
  const explicit = /提前\s*(\d{1,3})\s*分钟/u.exec(text);
  if (explicit) {
    return {
      mode: "dynamic" as const,
      recommendedMinutes: Math.min(360, Number(explicit[1])),
      basis: "采用用户明确提供的提前到达时间。",
    };
  }
  if (kind === "flight") {
    if (/国际|出境/u.test(text)) {
      return { mode: "dynamic" as const, recommendedMinutes: TRANSPORT_BUFFER_POLICY.internationalFlightMinutes, basis: "国际航班按较长值机与安检缓冲估算。" };
    }
    if (/托运/u.test(text)) {
      return { mode: "dynamic" as const, recommendedMinutes: TRANSPORT_BUFFER_POLICY.checkedBaggageFlightMinutes, basis: "航班包含托运行李，按较长值机与安检缓冲估算。" };
    }
    return { mode: "dynamic" as const, recommendedMinutes: TRANSPORT_BUFFER_POLICY.domesticFlightMinutes, basis: "航班按值机、安检和登机缓冲估算。" };
  }
  return { mode: "dynamic" as const, recommendedMinutes: TRANSPORT_BUFFER_POLICY.trainMinutes, basis: "火车按进站、安检和候车缓冲估算。" };
}

function allExtractedFields(input: PolicyInput) {
  const fields: ProtectionPolicy["lockedFields"] = ["name"];
  if (input.startTime) fields.push("startTime");
  if (input.endTime) fields.push("endTime");
  if (input.durationMinutes) fields.push("duration");
  if (input.location?.trim()) fields.push("location");
  return fields;
}

export function protectionPolicyForActivity(input: PolicyInput): ProtectionPolicy | undefined {
  if (input.commitment === "flexible") return undefined;
  const evidence = `${input.name} ${input.location ?? ""} ${input.sourceText}`;
  const source = input.commitment === "uncertain" ? "possible" as const : "confirmed" as const;
  const location = stationLevelLocation(input.location ?? "");
  const locationGranularity = /地铁站/u.test(location.location)
    ? "station" as const
    : /火车站|高铁站|机场|航站楼|客运站|[\p{Script=Han}A-Za-z0-9]{2,}站$/u.test(location.location)
      ? "transport_hub" as const
      : "venue" as const;
  const hasKnownDuration = Boolean(input.endTime || input.durationMinutes);
  const base = {
    source,
    timeAnchor: "starts_at" as const,
    allowedStartTimes: input.startTime ? [input.startTime] : [],
    locationGranularity,
    transportKind: null,
    arrivalBuffer: null,
    locationNote: location.note,
  };

  if (/可改签|可以改签|可改约|可以改约|允许改签|允许改约/u.test(evidence)) {
    return ProtectionPolicySchema.parse({
      ...base,
      kind: "rebookable",
      lockedFields: allExtractedFields(input).filter((field) => field !== "endTime"),
      allowedStartTimes: explicitTimes(input.sourceText, input.startTime),
      durationPolicy: {
        mode: hasKnownDuration ? "fixed" : "unknown",
        defaultMinutes: input.durationMinutes ?? null,
        minMinutes: input.durationMinutes ?? null,
        maxMinutes: input.durationMinutes ?? null,
      },
    });
  }

  if (/电影|影票|演出|演唱会|音乐会|话剧|歌剧|门票|票务/u.test(evidence)) {
    return ProtectionPolicySchema.parse({
      ...base,
      kind: "ticketed_event",
      lockedFields: allExtractedFields(input),
      durationPolicy: {
        mode: hasKnownDuration ? "fixed" : "unknown",
        defaultMinutes: input.durationMinutes ?? null,
        minMinutes: input.durationMinutes ?? null,
        maxMinutes: input.durationMinutes ?? null,
      },
    });
  }

  if (/预约|预订|订位/u.test(evidence) && /餐厅|饭店|午餐|晚餐|用餐|吃饭|餐/u.test(evidence)) {
    return ProtectionPolicySchema.parse({
      ...base,
      kind: "restaurant_reservation",
      lockedFields: ["startTime", "location"],
      durationPolicy: {
        mode: hasKnownDuration ? "fixed" : "suggested",
        defaultMinutes: input.durationMinutes ?? 90,
        minMinutes: hasKnownDuration ? input.durationMinutes ?? null : 60,
        maxMinutes: hasKnownDuration ? input.durationMinutes ?? null : 150,
      },
    });
  }

  if (/集合|会合|碰面|见面|汇合/u.test(evidence)) {
    return ProtectionPolicySchema.parse({
      ...base,
      kind: "meeting",
      lockedFields: ["startTime", "location"],
      timeAnchor: "arrive_by",
      durationPolicy: {
        mode: hasKnownDuration ? "fixed" : "suggested",
        defaultMinutes: input.durationMinutes ?? 60,
        minMinutes: hasKnownDuration ? input.durationMinutes ?? null : 30,
        maxMinutes: hasKnownDuration ? input.durationMinutes ?? null : 120,
      },
    });
  }

  if (/航班|飞机|机票|机场|火车|高铁|动车|列车|车票|火车站|高铁站/u.test(evidence)) {
    const transportKind = /航班|飞机|机票|机场/u.test(evidence) ? "flight" as const : "train" as const;
    const arriveBy = /(?:抵达|到达|赶到|前到|之前到|点\s*到)/u.test(input.sourceText);
    return ProtectionPolicySchema.parse({
      ...base,
      kind: "transport",
      lockedFields: ["startTime", "location"],
      timeAnchor: arriveBy ? "arrive_by" : "departs_at",
      locationGranularity: "transport_hub",
      transportKind,
      arrivalBuffer: arriveBy ? null : transportBuffer(input.sourceText, transportKind),
      durationPolicy: {
        mode: "unknown",
        defaultMinutes: null,
        minMinutes: null,
        maxMinutes: null,
      },
    });
  }

  return ProtectionPolicySchema.parse({
    ...base,
    kind: "generic",
    lockedFields: allExtractedFields(input),
    timeAnchor: /(?:抵达|到达|赶到|点\s*到)/u.test(input.sourceText) ? "arrive_by" : "starts_at",
    durationPolicy: {
      mode: hasKnownDuration ? "fixed" : "unknown",
      defaultMinutes: input.durationMinutes ?? null,
      minMinutes: input.durationMinutes ?? null,
      maxMinutes: input.durationMinutes ?? null,
    },
  });
}

export function protectedArrivalDeadline(fact: ActivityFact) {
  if (!fact.startTime) return 0;
  const policy = fact.protectionPolicy;
  const buffer = policy?.timeAnchor === "departs_at"
    ? policy.arrivalBuffer?.recommendedMinutes ?? 0
    : 0;
  return Math.max(0, minutes(fact.startTime) - buffer);
}

export function protectionSummary(fact: ActivityFact) {
  const policy = fact.protectionPolicy;
  if (!policy) return "非固定安排";
  if (policy.kind === "restaurant_reservation") return "保护预约开始时间和餐厅地点；用餐结束时间是系统建议。";
  if (policy.kind === "ticketed_event") return "票务活动的已提取时间、地点和活动身份全部保护。";
  if (policy.kind === "meeting") return "保护按时抵达集合地点；集合后的时长由系统建议。";
  if (policy.kind === "transport") {
    const buffer = policy.arrivalBuffer?.recommendedMinutes;
    return policy.timeAnchor === "departs_at" && buffer
      ? `保护出发时间和交通枢纽，并预留 ${buffer} 分钟提前到达缓冲。`
      : "保护抵达时间和交通枢纽，不要求检票口或地铁出口。";
  }
  if (policy.kind === "rebookable") return `只允许改到明确可改签时间：${policy.allowedStartTimes.join("、")}。`;
  return policy.source === "possible"
    ? "固定性不明确，按可能固定安排保护已提取字段。"
    : "保护用户已确认的固定字段。";
}
