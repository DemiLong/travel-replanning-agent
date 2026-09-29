import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotSchema } from "../../types/index.ts";
import { DeepSeekSemanticParser } from "../../services/semantic-parser.ts";
import { confirmedDraftFromParsed } from "../../services/itinerary-domain.ts";
import { runAgentAssist } from "../../agents/agent-orchestrator.ts";
import { WorldContextService } from "../../services/world/world-context-service.ts";
import { AmapPlacesService } from "../../services/world/amap-places-service.ts";
import { WorldServiceError } from "../../services/world/amap-client.ts";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs", stamp);
await mkdir(runDir, { recursive: true });
const cases = [
  { id: "two_unscheduled_combined", rawText: "现在13:00，我在上海人民广场。今天原计划去上海静安寺、上海自然博物馆，起晚了，请帮我重新安排。" },
  { id: "two_unscheduled", rawText: "现在13:00，我在上海人民广场。今天原计划去上海静安寺。今天还原计划去上海自然博物馆。起晚了，请帮我重新安排这两个地方。" },
  { id: "R01", rawText: "现在13:00，我在上海人民广场。现在下雨了，我原定15:00去上海国金中心商场，18:00去外滩观景平台散步，请帮我重新安排。" },
  { id: "R01_ORIGINAL", rawText: "现在13:00，我在上海人民广场。现在下雨了，我原定15:00去上海国金中心，18:00去外滩散步，请帮我重新安排。" },
  { id: "L02", rawText: "现在16:00，我刚到静安寺地铁站。因为起晚，原计划今天逛的静安寺和南京西路步行街都还没去，但18:00必须到上海展览中心7号门集合，请帮我看看怎么安排。" },
  { id: "L02_SPACE", rawText: "现在 16:00，我刚到静安寺地铁站，起晚了前面静安寺和南京西路步行街都没来得及逛，但是 18 点必须到上海展览中心集合，帮我看看怎么安排" },
  { id: "C02", rawText: "现在 17:20，我刚走到云南南路美食街，本来打算吃鲜得来排骨年糕，吃完去和平影都看 19:00 的电影，结果这家店关门了，不用给我找替代餐厅啊" },
  { id: "D04", rawText: "现在是15:30，我才到上海博物馆东馆，比我的原计划晚了60分钟，并且原计划是17:00 国金中心、19:00 外滩，还来得及么？" },
  { id: "I02", rawText: "现在 9:30，我在龙阳路地铁站，还在考虑今天去迪士尼度假区还是海昌海洋公园，还没决定，先帮我看看两个的情况？" },
  { id: "C03", rawText: "现在17:30，我在上海火车站。原定19:00到上海中心大厦一层入口和朋友集合，但现在地铁停运了，我该怎么办？" },
  { id: "fixed_unknown", rawText: "现在16:00，我在上海人民广场。因为起晚，原计划去上海自然博物馆，已经预约在上海展览中心7号门集合，但忘了预约时间，请重新安排。" },
];
const sources = { currentTime: "user", currentLocation: "user", weather: "unset", energyLevel: "unset", disruption: "user" };
const summarizeActivities = items => items.map(({ id, name, sourceText, role, placeQuery, startTime, startTimeSource, commitment }) => ({ id, name, sourceText, role, placeQuery, startTime, startTimeSource, commitment }));
const safeError = error => error instanceof WorldServiceError
  ? { category: error.code, detail: error.detail ?? null }
  : { category: error instanceof Error ? error.name : "UNKNOWN",
    marker: error instanceof Error && /^ACTIVITY_[A-Z_]+$/.test(error.message) ? error.message : null,
    status: typeof error?.status === "number" ? error.status : null,
    message: error instanceof Error ? [process.env.DEEPSEEK_API_KEY, process.env.AMAP_API_KEY]
      .filter(Boolean).reduce((message, key) => message.replaceAll(key, "[redacted]"), error.message).slice(0, 400) : null };
const records = [];
const selectedCase = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
for (const item of cases.filter(value => !selectedCase || value.id === selectedCase)) {
  const record = { caseId: item.id, rawText: item.rawText, stages: [], amapQueries: [] };
  records.push(record);
  const base = SnapshotSchema.parse({ mode: "user", profile: { id: "qa", travelPace: "balanced", walkingTolerance: "medium" },
    trip: { id: "qa", destination: "上海", startDate: "2026-09-28", endDate: "2026-09-28" },
    state: { currentDate: "2026-09-28", currentTime: "13:00", stateCapturedAt: new Date().toISOString(), currentLocation: "上海人民广场" },
    stateSources: sources, itinerary: [], revision: 0 });
  try {
    const parsed = await new DeepSeekSemanticParser().parse(base, item.rawText, undefined, undefined,
      (stage, value) => record.stages.push({ stage, value }));
    record.stages.push({ stage: "activityFacts", value: summarizeActivities(parsed.activityFacts) });
    const draft = confirmedDraftFromParsed(base, parsed);
    record.stages.push({ stage: "confirmedDraft", value: summarizeActivities(draft.activityFacts) });
    const places = new AmapPlacesService();
    for (const query of ["上海人民广场", ...draft.activityFacts.filter(fact => fact.role === "existing_plan").map(fact => fact.placeQuery ?? fact.name)]) {
      for (const city of ["", "上海"]) {
        try {
          const answer = await places.search(query, city);
          record.amapQueries.push({ query, city, candidateCount: answer.candidates.length,
            candidates: answer.candidates.map(poi => ({ id: poi.poiId, name: poi.name, city: poi.city })) });
        } catch (error) { record.amapQueries.push({ query, city, candidateCount: null, error: safeError(error) }); }
      }
    }
    const worldService = new WorldContextService();
    const dependencies = {
      parse: async () => parsed,
      ground: async (input, signal) => {
        record.stages.push({ stage: "planningRequest", value: {
          originalActivityIds: input.request.originalActivityIds,
          originals: (input.request.originalActivityIds ?? []).map(id => draft.activityFacts.find(fact => fact.id === id)).filter(Boolean).map(({ id, name, sourceText }) => ({ id, name, sourceText })),
          unscheduledOriginals: summarizeActivities(input.request.unscheduledOriginals ?? []),
          currentLocation: input.request.currentState.currentLocation,
          allowedTravelModes: input.request.worldOptions?.allowedTravelModes ?? null,
        } });
        const world = await worldService.ground(input, signal);
        record.stages.push({ stage: "grounding", value: {
          status: world.status,
          candidatePlaceIds: world.candidatePlaceIds,
          ambiguities: world.ambiguities.map(ambiguity => ({ field: ambiguity.field, label: ambiguity.label, candidateCount: ambiguity.candidates.length })),
          missingWorldFacts: world.missingWorldFacts,
          resolutionEvidence: world.resolutionEvidence,
          routes: world.routes.map(route => ({ origin: route.origin.id, destination: route.destination.id,
            travelMode: route.travelMode, status: route.status, durationSeconds: route.durationSeconds })),
        } });
        return world;
      },
    };
    let result = await runAgentAssist({ snapshot: base, rawText: item.rawText }, undefined, dependencies);
    for (let round = 0; round < 5 && result.status === "NEEDS_INPUT"; round++) {
      const blocker = result.missingFact;
      record.stages.push({ stage: "followUp", value: { key: blocker.key, answerType: blocker.answerType,
        candidates: blocker.candidates?.map(candidate => ({ value: candidate.value, label: candidate.label })) ?? [] } });
      if (!blocker.candidates?.length) break;
      const first = blocker.candidates[0].value;
      const answer = blocker.answerType === "poi" ? { kind: "poi", field: blocker.key, poiId: first }
        : blocker.answerType === "text" ? { kind: "text", field: blocker.key, value: first } : null;
      if (!answer) break;
      result = await runAgentAssist({ snapshot: base, confirmedDraft: result.confirmedDraft,
        resolutionState: result.resolutionState, answer }, undefined, dependencies);
    }
    const sourceById = new Map((result.parsedInput?.activityFacts ?? []).map(fact => [fact.id, fact.sourceText]));
    record.stages.push({ stage: "assistResult", value: { status: result.status, error: result.error ?? null,
      advice: result.advice ?? null,
      attempts: result.result?.attempts ?? null, candidateComparisons: result.result?.candidateComparisons ?? null,
      parsedFacts: summarizeActivities(result.parsedInput?.activityFacts ?? []),
      plan: result.status === "READY" ? { summary: result.result.plan?.summary,
        explanation: result.result.plan?.explanation,
        events: result.result.plan?.events.map(({ id, name, startTime, travelMode, reason }) => ({ id, name, sourceText: sourceById.get(id) ?? null, startTime, travelMode, reason })),
        removedEvents: result.result.plan?.removedEvents.map(({ eventId, name, reason }) => ({ eventId, name, sourceText: sourceById.get(eventId) ?? null, reason })) } : null } });
  } catch (error) { record.stages.push({ stage: "failure", value: safeError(error) }); }
  await writeFile(path.join(runDir, `${item.id}.json`), JSON.stringify(record, null, 2), "utf8");
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>真实链路诊断</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7f5;padding:16px;border-radius:8px}section{margin:30px 0}</style><h1>真实模型／高德诊断 · ${stamp}</h1><p>查询记录不含密钥与原始 URL；本报告是诊断，不是通过证明。</p>${records.map(record => `<section><h2>${record.caseId}</h2><pre>${escape(JSON.stringify(record, null, 2))}</pre></section>`).join("")}</html>`;
await writeFile(path.join(runDir, "diagnosis.html"), html, "utf8");
console.log(path.join(runDir, "diagnosis.html"));
