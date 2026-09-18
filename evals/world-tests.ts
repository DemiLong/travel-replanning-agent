import assert from "node:assert/strict";
import { createStarterSnapshot } from "../data/demo";
import { DeepSeekSemanticParser } from "../services/semantic-parser";
import { normalizeSemanticExtraction } from "../services/semantic-parser";
import { LocationService } from "../services/world/location-service";
import type { SemanticExtraction } from "../types";
import { CoordinateService } from "../services/world/coordinate-service";
import { AmapPlacesService } from "../services/world/amap-places-service";
import { clearWorldCache } from "../services/world/amap-client";
import { AmapRoutesService } from "../services/world/amap-routes-service";
import { AmapWeatherService } from "../services/world/amap-weather-service";
import { WorldContextService } from "../services/world/world-context-service";
import { event } from "../data/demo";
import { buildRealContext } from "../agents/real-context-builder";
import { CandidateSetSchema, DeepSeekPlanner, materializeCandidate, type PlanCandidate } from "../services/deepseek-planner";
import { replanReal, MAX_REPLAN_ATTEMPTS } from "../agents/real-replanning-agent";
import { validatePlan } from "../validators";
import { analyzeImpact } from "../services/impact-analysis";
import { runAgentAssist } from "../agents/agent-orchestrator";
import { runAssistResolutionTests } from "./assist-resolution-tests";

export const regressionText = "我十点要去故宫，但是我睡过头了，已经11:46了，我下午还要去故宫吗？因为我预约了下午5点的景点参观，同时下午3点需要和朋友在酒店集合去另一个景点，来得及吗？";
export const regressionExtraction: SemanticExtraction = {
  intent: "mixed",
  activities: [
    { role: "existing_plan", name: "故宫", startTime: "10:00", endTime: null, durationMinutes: null, location: "故宫", estimatedCost: null, locked: "no", sourceText: "我十点要去故宫" },
    { role: "existing_plan", name: "酒店和朋友集合", startTime: "15:00", endTime: null, durationMinutes: null, location: null, estimatedCost: null, locked: "yes", sourceText: "下午3点需要和朋友在酒店集合去另一个景点" },
    { role: "existing_plan", name: "已预约景点参观", startTime: "17:00", endTime: null, durationMinutes: null, location: null, estimatedCost: null, locked: "yes", sourceText: "我预约了下午5点的景点参观" },
  ],
  disruptions: [{ kind: "late", label: "睡过头，原计划延误", sourceText: "我睡过头了" }],
  constraints: [{ kind: "keep", value: "17:00 预约", sourceText: "我预约了下午5点的景点参观" }],
  context: { currentTime: { value: "11:46", sourceText: "已经11:46了" }, currentLocation: { value: null, sourceText: null }, weather: { value: null, sourceText: null }, energyLevel: { value: null, sourceText: null }, remainingBudget: { value: null, sourceText: null } },
  question: "是否还应该去故宫，并能赶上后续安排？",
  ambiguities: ["你住哪家酒店？", "17 点预约的是哪个景点？", "每项活动预计停留多久？"],
};

export async function runWorldTests() {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-placeholder";
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "https://api.deepseek.com/responses");
      const body = JSON.parse(String(options?.body));
      assert.equal(body.text.format.type, "json_schema");
      assert(body.input[1].content.includes(regressionText));
      calls++;
      return Response.json({ id: "resp_test", object: "response", status: "completed", output: [{ type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(regressionExtraction), annotations: [] }] }] });
    };
    const result = await new DeepSeekSemanticParser().parse(createStarterSnapshot(), regressionText);
    assert.equal(calls, 1);
    assert.equal(result.activityMentions.length + result.existingPlans.length, 3);
    assert.equal(result.context.currentTime, "11:46");
    assert.equal(result.context.weather, undefined);
    assert.equal(result.context.energyLevel, undefined);
    assert.equal(result.disruptions[0].kind, "late");
    assert(!result.missingFacts.includes("existingPlans"));
    assert(result.missingFacts.some(x=>x.endsWith(":location")));
    const repeated=normalizeSemanticExtraction(createStarterSnapshot(),regressionText,{...regressionExtraction,activities:[...regressionExtraction.activities,{...regressionExtraction.activities[0],role:"considering",name:"下午去故宫",startTime:null,sourceText:"我下午还要去故宫吗"}]},"fixture");
    assert.equal(repeated.activityMentions.length,3);
    assert(result.parseWarnings.some(x => x.includes("酒店")));
    assert.deepEqual(result.activityMentions.map(x => x.startTime), ["10:00", "15:00", "17:00"]);
    const validFetch=globalThis.fetch;let repairs=0;
    globalThis.fetch=async (...args)=>{
      repairs++;
      if(repairs===1)return Response.json({id:"incomplete-json",object:"response",status:"completed",output:[{type:"message",id:"m",role:"assistant",status:"completed",content:[{type:"output_text",text:"{",annotations:[]}]}]});
      return validFetch(...args);
    };
    const repaired=await new DeepSeekSemanticParser().parse(createStarterSnapshot(),regressionText);
    assert.equal(repairs,2);assert.equal(repaired.context.currentTime,"11:46");
    repairs=0;globalThis.fetch=async()=>{repairs++;return Response.json({id:"bad",object:"response",status:"completed",output:[{type:"message",id:"m",role:"assistant",status:"completed",content:[{type:"output_text",text:"{",annotations:[]}]}]});};
    await assert.rejects(()=>new DeepSeekSemanticParser().parse(createStarterSnapshot(),regressionText));assert.equal(repairs,2);
    console.log("PASS malformed provider JSON repairs once then fails explicitly, never using regex fallback");
    delete process.env.DEEPSEEK_API_KEY;
    assert.throws(() => new DeepSeekSemanticParser(), /MODEL_NOT_CONFIGURED/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
  console.log("PASS DeepSeek HTTP structured parser: complex Chinese, three partial activities, provenance and no missing-key fallback");
  const amapKey = process.env.AMAP_API_KEY;
  process.env.AMAP_API_KEY = "test-amap";
  clearWorldCache();
  let conversions = 0;
  try {
    globalThis.fetch = async url => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/convert")) {
        conversions++; assert.equal(u.searchParams.get("coordsys"), "gps");
        assert.equal(u.searchParams.get("locations"), "116.400000,39.900000");
        return Response.json({ status:"1", locations:"116.406242,39.901403" });
      }
      if (u.pathname.endsWith("/around")) assert.equal(u.searchParams.get("location"), "116.406242,39.901403");
      return Response.json({ status:"1", pois:[{id:"p1",name:"故宫博物院",location:"116.397,39.918",cityname:"北京市",adname:"东城区",adcode:"110101"},{id:"p2",name:"故宫南门",location:"116.397,39.915"}] });
    };
    const coordinate = new CoordinateService();
    const raw = {latitude:39.9,longitude:116.4,coordinateSystem:"WGS84" as const};
    const converted = await coordinate.toGCJ02(raw);
    assert.equal(converted.coordinateSystem,"GCJ02");
    assert.equal(converted.longitude,116.406242);
    assert.deepEqual(await coordinate.toGCJ02(converted),converted);
    const pois = await new AmapPlacesService().around("故宫",raw);
    assert.equal(conversions,1);
    assert.equal(pois.status,"ambiguous");
    assert(pois.candidates.every(x=>x.coordinateSystem==="GCJ02"));
    let routeCalls = 0;
    globalThis.fetch = async url => {
      const u = new URL(String(url)); routeCalls++;
      assert.equal(u.searchParams.get("origin"),"116.406242,39.901403");
      return Response.json({status:"1",route: u.pathname.includes("transit") ? {transits:[{distance:"3000",duration:"1000",cost:"4"}]} : {paths:[{distance:"1000",duration:"600"}]}});
    };
    const from = {...converted,id:"from",city:"北京"};
    const to = {...converted,longitude:116.42,id:"to",city:"北京"};
    const routes = new AmapRoutesService();
    const batch = await routes.batch([{origin:from,destination:to},{origin:from,destination:to}],"WALKING");
    assert.equal(batch.length,1); assert.equal(batch[0].durationSeconds,600);
    await routes.route(from,to,"WALKING"); assert.equal(routeCalls,1);
    assert.equal((await routes.route(from,to,"DRIVING")).status,"available");
    assert.equal((await routes.route(from,to,"TRANSIT")).fare,4);
    clearWorldCache(); globalThis.fetch = async ()=>Response.json({status:"0"});
    assert.equal((await routes.route(from,to,"WALKING")).status,"unavailable");
    console.log("PASS three Amap route modes, seconds, deduplication, bounded requests, no unavailable fallback");
    clearWorldCache();
    globalThis.fetch = async url => new URL(String(url)).searchParams.get("extensions")==="base" ? Response.json({status:"1",lives:[{weather:"小雨",temperature:"22",humidity:"80",winddirection:"北",windpower:"3",reporttime:"2026-09-13 12:00:00"}]}) : Response.json({status:"1",forecasts:[{casts:[{date:"2026-09-13",dayweather:"雨",nightweather:"阴",daytemp:"22",nighttemp:"18"}]}]});
    const weather = await new AmapWeatherService().weather("110101");
    assert.equal(weather.temperature,22); assert.equal(weather.condition,"小雨");assert.equal(weather.forecast.length,1);
    clearWorldCache(); globalThis.fetch = async ()=>Response.json({status:"0"});
    assert.equal((await new AmapWeatherService().weather("110101")).status,"unavailable");
    console.log("PASS compact Amap live/forecast and unavailable weather without fabricated rain");
    clearWorldCache();let weatherCalls=0;
    globalThis.fetch = async url=>{
      const u=new URL(String(url));
      if(u.pathname.includes("weather"))weatherCalls++;
      if(u.pathname.includes("/direction"))return Response.json({status:"1",route:{paths:[{distance:"300",duration:"180"}]}});
      return Response.json({status:"1",pois:[{id:"real-"+u.searchParams.get("keywords"),name:u.searchParams.get("keywords"),location:"116.4,39.9",cityname:"北京",adcode:"110101"}]});
    };
    const snapshot=createStarterSnapshot();snapshot.trip.destination="北京";
    snapshot.itinerary=[{...event("palace","palace-event","12:00","13:00"),name:"故宫",location:"故宫",estimatedCostKnown:false}];
    const request={reason:"late",freeText:"我睡过头了",currentState:{...snapshot.state,currentTime:"11:46",currentLocation:"天安门"},closedPlaceIds:[],variation:0,worldOptions:{selectedPois:{},travelMode:"WALKING"}};
    const input={snapshot,request,mode:"live",confirmation:{status:"confirmed",confirmedAt:new Date().toISOString()}};
    const grounded=await new WorldContextService().ground(input);
    assert.equal(grounded.status,"ready");assert.equal(grounded.currentTime.value,"11:46");
    assert.equal(grounded.weather.status,"not_requested");assert.equal(weatherCalls,0);
    assert.equal(grounded.routes[0].source,"amap");
    const ctx=buildRealContext(input,grounded);
    const candidate:PlanCandidate={title:"保留故宫",tradeOff:"按真实路程出发，营业状态待核实",steps:[{eventId:"palace-event",poiId:null,durationMinutes:null,reason:"保留原活动"}],removed:[]};
    const materialized=materializeCandidate(ctx,candidate);
    assert.equal(materialized.events[0].startTime,"12:00");
    assert.equal(materialized.events[0].travelTimeFromPrevious,3);
    assert.throws(()=>materializeCandidate(ctx,{...candidate,steps:[{...candidate.steps[0],eventId:"invented"}]}));
    process.env.DEEPSEEK_API_KEY="test-planner";
    const restoreFetch=globalThis.fetch;
    globalThis.fetch=async (url,options)=>{
      assert.equal(String(url),"https://api.deepseek.com/responses");
      const body=JSON.parse(String(options?.body));assert(body.input[0].content.includes("distinct from the semantic parser"));
      assert(!body.input[1].content.includes("test-planner"));
      return Response.json({id:"planner-test",object:"response",status:"completed",output:[{type:"message",role:"assistant",id:"msg",status:"completed",content:[{type:"output_text",text:JSON.stringify({candidates:[candidate,{...candidate,title:"取消故宫",steps:[],removed:[{eventId:"palace-event",reason:"早点休息"}]}]}),annotations:[]}]}]});
    };
    const candidates=await new DeepSeekPlanner().generateCandidates(ctx,[],0);assert.equal(candidates.length,2);
    assert.equal(CandidateSetSchema.parse({candidates:[candidate]}).candidates.length,1);
    globalThis.fetch=restoreFetch;
    if(originalKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=originalKey;
    console.log("PASS separate DeepSeek planner HTTP prompt, grounded candidates and code-owned scheduling");
    assert.deepEqual(validatePlan(ctx,materialized),[]);
    const lockedInput=structuredClone(input);lockedInput.snapshot.itinerary[0].locked=true;lockedInput.snapshot.itinerary[0].status="locked";
    const lockedCtx=buildRealContext(lockedInput,grounded);
    const removed={...candidate,steps:[],removed:[{eventId:"palace-event",reason:"移除"}]};
    assert(validatePlan(lockedCtx,materializeCandidate(lockedCtx,removed)).some(v=>v.code==="locked_event"));
    let attempts=0;
    const recovered=await replanReal(lockedInput,{name:"fixture-planner",generateCandidates:async (_c,feedback)=>{attempts++;if(attempts>1)assert(feedback.length);return attempts===1?[removed,removed]:[candidate,candidate];}},{ground:async()=>grounded});
    assert("ok" in recovered&&recovered.ok);assert.equal(attempts,2);
    assert(recovered.decisionTrace?.validationEvidence.some(e=>e.check==="营业时间"&&e.status==="not_checked"));
    attempts=0;
    const failed=await replanReal(lockedInput,{name:"fixture-planner",generateCandidates:async()=>{attempts++;return [removed,removed];}},{ground:async()=>grounded});
    assert("ok" in failed&&!failed.ok);assert.equal(attempts,MAX_REPLAN_ATTEMPTS);
    const unavailableCtx=structuredClone(ctx);unavailableCtx.world!.routes[0].status="unavailable";
    assert(validatePlan(unavailableCtx,materialized).some(v=>v.code==="travel_time"));
    const impossible=structuredClone(lockedCtx);impossible.world!.routes[0].durationSeconds=7200;
    assert(validatePlan(impossible,materializeCandidate(impossible,candidate)).some(v=>v.code==="travel_time"));
    console.log("PASS real validator: locked event, route arithmetic, no unavailable feasibility, bounded feedback repair and trace");
    snapshot.itinerary[0].location="酒店";
    const incomplete=await new WorldContextService().ground(input);
    assert.equal(incomplete.status,"needs_input");assert(incomplete.missingWorldFacts.some(x=>x.kind==="user"&&x.message.includes("酒店")));
    await assert.rejects(()=>new WorldContextService().ground({...input,confirmation:undefined}));
    console.log("PASS unified world grounding, explicit user location, optional weather, user/world missing facts and confirmation guard");
    await assert.rejects(()=>coordinate.toGCJ02({...raw,latitude:100}));
    delete process.env.AMAP_API_KEY;
    await assert.rejects(()=>new AmapPlacesService().search("故宫","北京"),/AMAP_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch; clearWorldCache();
    if (amapKey === undefined) delete process.env.AMAP_API_KEY; else process.env.AMAP_API_KEY = amapKey;
  }
  console.log("PASS WGS84 official conversion, coordinate validation, cache reuse, ambiguous POI and configuration errors");
  const navDescriptor=Object.getOwnPropertyDescriptor(globalThis,"navigator");
  try{
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{geolocation:{getCurrentPosition:(success:(p:unknown)=>void)=>success({coords:{latitude:39.9,longitude:116.4,accuracy:10},timestamp:Date.now()})}}});
    const location=await new LocationService().getCurrentPosition();assert.equal(location.coordinateSystem,"WGS84");assert.equal(location.source,"browser_geolocation");assert.equal(location.accuracy,10);
    Object.defineProperty(globalThis,"navigator",{configurable:true,value:{geolocation:{getCurrentPosition:(_s:unknown,fail:()=>void)=>fail()}}});
    await assert.rejects(()=>new LocationService().getCurrentPosition(),/填写/);
  }finally{if(navDescriptor)Object.defineProperty(globalThis,"navigator",navDescriptor);else Reflect.deleteProperty(globalThis,"navigator");}
  console.log("PASS Browser Geolocation captures WGS84 provenance and asks location after refusal");
  const impactSnapshot = createStarterSnapshot();
  impactSnapshot.state.currentTime = "13:00";
  impactSnapshot.itinerary = [
    { ...event("palace", "done-event", "10:00", "12:00"), status: "completed" },
    { ...event("dinner", "fixed-event", "18:00", "19:00"), locked: true, status: "locked" },
  ];
  const impact = analyzeImpact(impactSnapshot, { reason: "weather", freeText: "现在下雨了", currentState: impactSnapshot.state, closedPlaceIds: [], variation: 0, stateSources: impactSnapshot.stateSources, worldOptions: { selectedPois: {}, travelMode: "WALKING" } });
  assert.deepEqual(impact.completedActivities, ["done-event"]);
  assert.deepEqual(impact.lockedActivities, ["fixed-event"]);
  assert(impact.availableTimeWindows.some((window) => window.startTime === "13:00" && window.endTime === "18:00"));
  console.log("PASS impact analysis preserves completed/locked facts and leaves experience choice to Planner");
  const assistKey = process.env.DEEPSEEK_API_KEY;
  const assistAmap = process.env.AMAP_API_KEY;
  const assistFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-assist";
  process.env.AMAP_API_KEY = "test-assist-ground";
  let assistCalls = 0;
  globalThis.fetch = async (url) => {
    if(String(url).includes("restapi.amap.com"))return Response.json({status:"1",pois:[]});
    assistCalls++;
    return Response.json({ id: "assist-parser", object: "response", status: "completed", output: [{ type: "message", id: "assist-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(regressionExtraction), annotations: [] }] }] });
  };
  try {
    const assist = await runAgentAssist({ snapshot: createStarterSnapshot(), rawText: regressionText });
    assert.equal(assist.status, "needs_input");
    assert.equal(assist.missingFacts.length,1);
    assert(!assist.missingFacts.some((item) => item.field === "travelMode"||item.field === "destination"));
    assert.equal(assistCalls, 1);
  } finally {
    globalThis.fetch = assistFetch;
    if (assistKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = assistKey;
    if (assistAmap === undefined) delete process.env.AMAP_API_KEY; else process.env.AMAP_API_KEY = assistAmap;
  }
  console.log("PASS unified Agent Orchestrator returns only material blocking facts before planning");
  const readyKey = process.env.DEEPSEEK_API_KEY;
  const readyAmapKey = process.env.AMAP_API_KEY;
  const readyFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-assist-ready";
  process.env.AMAP_API_KEY = "test-assist-amap";
  globalThis.fetch = async (url, options) => {
    const address = String(url);
    if (address === "https://api.deepseek.com/responses") {
      const body = JSON.parse(String(options?.body));
      if (body.input[0].content.includes("itinerary rescue planner")) {
        const plannerInput = JSON.parse(body.input[1].content);
        const steps = plannerInput.confirmedItinerary.map((item: { id: string }) => ({ eventId: item.id, poiId: null, durationMinutes: null, reason: "保留确认后的安排" }));
        return Response.json({ id: "assist-planner", object: "response", status: "completed", output: [{ type: "message", id: "planner-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ candidates: [{ title: "保留固定预约，减少变动", tradeOff: "保留原计划，空档不强行新增活动。", steps, removed: [] }] }), annotations: [] }] }] });
      }
      const readyExtraction: SemanticExtraction = { intent: "mixed", activities: [{ role: "existing_plan", name: "故宫", startTime: "10:00", endTime: "11:00", durationMinutes: null, location: "故宫", estimatedCost: null, locked: "no", sourceText: "10点去故宫游览1小时" }, { role: "existing_plan", name: "天安门", startTime: "18:00", endTime: "19:00", durationMinutes: null, location: "天安门", estimatedCost: null, locked: "yes", sourceText: "18点预约天安门参观1小时" }], disruptions: [{ kind: "weather", label: "现在下雨了", sourceText: "现在下雨了" }], constraints: [{ kind: "keep", value: "天安门预约", sourceText: "必须保留天安门预约" }], context: { currentTime: { value: "11:00", sourceText: "10点去故宫游览1小时，18点预约天安门参观1小时" }, currentLocation: { value: "天安门", sourceText: "我在天安门" }, weather: { value: "rain", sourceText: "现在下雨了" }, energyLevel: { value: null, sourceText: null }, remainingBudget: { value: null, sourceText: null } }, question: null, ambiguities: [] };
      return Response.json({ id: "assist-parser", object: "response", status: "completed", output: [{ type: "message", id: "assist-message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(readyExtraction), annotations: [] }] }] });
    }
    const parsedUrl = new URL(address);
    if (parsedUrl.pathname.includes("/place/")) return Response.json({ status: "1", pois: [{ id: `poi-${parsedUrl.searchParams.get("keywords") ?? "place"}`, name: parsedUrl.searchParams.get("keywords") ?? "地点", location: "116.397,39.918", cityname: "北京市", adname: "东城区", adcode: "110101", type: "景点" }] });
    if (parsedUrl.pathname.includes("/direction/")) return Response.json({ status: "1", route: { paths: [{ distance: "1000", duration: "600" }] } });
    if (parsedUrl.pathname.includes("/weather/")) return Response.json({ status: "1", lives: [{ weather: "小雨", temperature: "22", humidity: "80", winddirection: "北", windpower: "3", reporttime: "2026-09-16 11:00:00" }] });
    return Response.json({ status: "1", pois: [{ id: "poi-place", name: "地点", location: "116.397,39.918", cityname: "北京市", adname: "东城区", adcode: "110101", type: "景点" }] });
  };
  try {
    const readySnapshot = createStarterSnapshot();
    readySnapshot.trip.destination = "北京";
    const ready = await runAgentAssist({ snapshot: readySnapshot, rawText: "10点去故宫游览1小时，18点预约天安门参观1小时。现在下雨了，我在天安门，必须保留天安门预约。", userAnswers: { destination: "北京", currentLocation: "天安门", travelMode: "WALKING" } });
    assert.equal(ready.status, "ready");
    assert(ready.result.ok);
    assert(ready.result.impactAnalysis);
    assert.equal(ready.result.candidateComparisons?.length, 1);
    assert(ready.result.plan?.events.some((event) => event.locked && event.name === "天安门"));
  } finally {
    globalThis.fetch = readyFetch;
    if (readyKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = readyKey;
    if (readyAmapKey === undefined) delete process.env.AMAP_API_KEY; else process.env.AMAP_API_KEY = readyAmapKey;
  }
  console.log("PASS unified Agent Orchestrator completes mocked parse → impact → world → planner → validator with one candidate");
  await runAssistResolutionTests();
}
