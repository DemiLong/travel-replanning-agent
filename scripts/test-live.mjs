import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
const compile=spawnSync(process.execPath,["node_modules/typescript/bin/tsc","-p","tsconfig.evals.json"],{stdio:"inherit"});
if(compile.status!==0)process.exit(compile.status??1);
mkdirSync("work/eval-build",{recursive:true});writeFileSync("work/eval-build/package.json",'{"type":"commonjs"}');
const require=createRequire(import.meta.url);
const {createStarterSnapshot}=require("../work/eval-build/data/session-defaults.js");
const {regressionText}=require("../work/eval-build/evals/world-tests.js");
const {DeepSeekSemanticParser}=require("../work/eval-build/services/semantic-parser.js");
const {WorldContextService}=require("../work/eval-build/services/world/world-context-service.js");
const {AmapPlacesService}=require("../work/eval-build/services/world/amap-places-service.js");
const {AmapRoutesService}=require("../work/eval-build/services/world/amap-routes-service.js");
const {AmapWeatherService}=require("../work/eval-build/services/world/amap-weather-service.js");
const {CoordinateService}=require("../work/eval-build/services/world/coordinate-service.js");
const {replanReal}=require("../work/eval-build/agents/real-replanning-agent.js");
const {validatePlan}=require("../work/eval-build/validators/index.js");
const {buildRealContext}=require("../work/eval-build/agents/real-context-builder.js");
try{
  const snapshot=createStarterSnapshot();snapshot.trip.destination=process.argv.includes("--unconfirmed-city")?"待确认城市":"北京";
  const parsed=await new DeepSeekSemanticParser().parse(snapshot,regressionText);
  const activities=[...parsed.existingPlans,...parsed.activityMentions];
  assert.equal(parsed.context.currentTime,"11:46");
  assert(activities.some(a=>a.name.includes("故宫")&&a.startTime==="10:00"));
  assert(activities.some(a=>a.startTime==="15:00"));
  assert(activities.some(a=>a.startTime==="17:00"&&(a.locked===true||a.locked==="yes")));
  assert.equal(parsed.context.weather,undefined);assert.equal(parsed.context.energyLevel,undefined);
  assert(parsed.parseWarnings.length||parsed.missingFacts.length);
  const report={semantic:{model:parsed.parserModel,currentTime:parsed.context.currentTime,activities:activities.map(a=>({name:a.name,time:a.startTime,locked:a.locked})),questions:parsed.parseWarnings}};
  console.log("PASS actual DeepSeek complex semantic regression",JSON.stringify(report.semantic));
  if(!process.argv.includes("--semantic-only")){
    const places=new AmapPlacesService(),selectedPois={};
    // Explicit TEST answers only. These are not inferred answers to the user's unknown hotel/booking.
    const venues=[{id:"museum",name:"故宫博物院",start:"10:00",end:"12:00",locked:false},{id:"hotel",name:"北京饭店",start:"15:00",end:"15:15",locked:true},{id:"booking",name:"天坛公园",start:"17:00",end:"18:00",locked:true}];
    const locate=async(field,name)=>{const response=await places.search(name,"北京");const match=response.candidates.find(p=>p.name===name);assert(match,`TEST venue ${name} requires a matching returned POI`);selectedPois[field]=match.poiId;return match;};
    const origin=await locate("currentLocation","天安门广场");
    for(const v of venues){await locate(v.id,v.name);snapshot.itinerary.push({id:v.id,placeId:v.id,name:v.name,category:"user activity",startTime:v.start,endTime:v.end,location:v.name,status:v.locked?"locked":"planned",locked:v.locked,estimatedCost:0,estimatedCostKnown:false,indoorOutdoor:"mixed",openingTime:null,closingTime:null,travelTimeFromPrevious:null,reason:"测试中明确补充并确认",constraint:v.locked?"固定预约":"原安排"});}
    snapshot.state={...snapshot.state,currentTime:"11:46",currentLocation:"天安门广场"};snapshot.stateSources={...snapshot.stateSources,currentTime:"user",currentLocation:"user",disruption:"user"};
    const input={snapshot,mode:"live",confirmation:{status:"confirmed",confirmedAt:new Date().toISOString()},request:{reason:"late",freeText:regressionText+" 测试补充：酒店为北京饭店，17 点参观天坛公园；故宫预计停留 120 分钟，酒店集合 15 分钟，天坛参观 60 分钟。保留两项固定预约。",currentState:snapshot.state,stateSources:snapshot.stateSources,closedPlaceIds:[],variation:0,worldOptions:{travelMode:"WALKING",selectedPois}}};
    const world=await new WorldContextService().ground(input);assert.equal(world.status,"ready");assert.equal(world.weather.status,"not_requested");assert.equal(world.resolvedPlaces.length,3);assert(world.routes.every(r=>r.source==="amap"));
    const converted=await new CoordinateService().toGCJ02({longitude:116.4,latitude:39.9,coordinateSystem:"WGS84"});assert.equal(converted.coordinateSystem,"GCJ02");assert.notEqual(converted.longitude,116.4);
    const weather=await new AmapWeatherService().weather(origin.adcode||(await places.reverse(origin)).adcode);assert.equal(weather.status,"available");
    const result=await replanReal(input);assert("ok" in result);assert(result.candidateComparisons?.length>=1&&result.candidateComparisons.length<=3);assert(result.attempts.length<=2);
    if(result.ok){assert.deepEqual(validatePlan(result.context,result.plan),[]);const latest=await new WorldContextService().ground(input);assert.deepEqual(validatePlan(buildRealContext(input,latest),result.plan),[]);}
    report.world={poiSource:"amap",places:world.resolvedPlaces.map(p=>({id:p.poi.poiId,name:p.poi.name})),routeCount:world.routes.length,availableRoutes:world.routes.filter(r=>r.status==="available").length,coordinateConversion:converted,weather:{source:weather.source,status:weather.status,condition:weather.condition},planner:{model:result.model,ok:result.ok,attempts:result.attempts.length,candidates:result.candidateComparisons,events:result.plan?.events.map(e=>({name:e.name,start:e.startTime,end:e.endTime,locked:e.locked,travelMinutes:e.travelTimeFromPrevious}))}};
    console.log("PASS actual grounded DeepSeek planner and Validator",JSON.stringify(report.world));
    writeFileSync("work/live-confirmed-fixture.json",JSON.stringify(input,null,2));
  }
  const reportPath = process.argv.includes("--semantic-only") ? "work/live-semantic-report.json" : "work/live-provider-report.json";
  writeFileSync(reportPath,JSON.stringify({testedAt:new Date().toISOString(),...report},null,2));
}catch(error){
  // Error objects from an SDK can contain request headers. Never log them.
  let message=String(error.error?.message??error.message??"Live verification failed");
  for(const key of [process.env.DEEPSEEK_API_KEY,process.env.AMAP_API_KEY])if(key)message=message.replaceAll(key,"[REDACTED]");
  console.error(message.slice(0,1500));process.exitCode=1;
}
