import assert from "node:assert/strict";
import { createStarterSnapshot } from "../data/session-defaults";
import { EventSchema, type SemanticExtraction, type Snapshot } from "../types";
import { runAgentAssist } from "../agents/agent-orchestrator";
import { clearWorldCache } from "../services/world/amap-client";
import { WorldContextService } from "../services/world/world-context-service";
import { validatePlan } from "../validators";
import { uniquePlace, allowedModes, freshBrowserLocation } from "../services/world/context-resolution";

const text="我原本 10:00 去美术馆，现在航班晚点了 2 小时，刚到虹桥。下午 6 点的预约晚餐必须保留。";
const extraction:SemanticExtraction={intent:"rescue",activities:[
 {role:"existing_plan",name:"美术馆",startTime:"10:00",endTime:null,durationMinutes:null,location:"美术馆",estimatedCost:null,locked:"no",sourceText:"10:00 去美术馆"},
 {role:"existing_plan",name:"晚餐",startTime:"18:00",endTime:null,durationMinutes:null,location:null,estimatedCost:null,locked:"yes",sourceText:"下午 6 点的预约晚餐必须保留"},
],disruptions:[{kind:"late",label:"航班晚点",sourceText:"航班晚点了 2 小时"}],constraints:[{kind:"keep",value:"晚餐",sourceText:"预约晚餐必须保留"}],context:{currentTime:{value:null,sourceText:null},currentLocation:{value:"虹桥",sourceText:"刚到虹桥"},weather:{value:null,sourceText:null},energyLevel:{value:null,sourceText:null},remainingBudget:{value:null,sourceText:null}},question:null,ambiguities:[]};
const poi=(id:string,name:string)=>({id,name,location:"121.33,31.20",cityname:"上海市",adname:"闵行区",adcode:"310112",type:"交通设施服务"});
function base():Snapshot{const s=createStarterSnapshot();s.trip.destination="待确认城市";s.state.currentTime="12:00";return s;}
const saved=(id:string,name:string,location:string,start:string,end:string,locked:boolean)=>EventSchema.parse({id,placeId:id,name,location,startTime:start,endTime:end,locked,status:locked?"locked":"planned",category:"user activity",estimatedCost:0,estimatedCostKnown:false,indoorOutdoor:"mixed",openingTime:null,closingTime:null,travelTimeFromPrevious:null,reason:"用户已保存",constraint:"用户原安排"});

export async function runAssistResolutionTests(){
 const oldFetch=globalThis.fetch, key=process.env.DEEPSEEK_API_KEY, amap=process.env.AMAP_API_KEY;
 process.env.DEEPSEEK_API_KEY="test-resolution";process.env.AMAP_API_KEY="test-resolution";
 let active=structuredClone(extraction), plannerCalls=0, queries:URL[]=[], failRoutes=false, ambiguousMuseum=false;
 const pois=[poi("airport","上海虹桥国际机场"),poi("art","龙美术馆"),poi("dinner","和平饭店"),poi("hotel","虹桥酒店")];
 globalThis.fetch=async(url,options)=>{
  const u=new URL(String(url));
  if(u.hostname==="api.deepseek.com"){
   const body=JSON.parse(String(options?.body));let output:unknown=active;
   if(body.input[0].content.includes("itinerary rescue planner")){
    plannerCalls++;const ctx=JSON.parse(body.input[1].content);
    output={candidates:[{title:"保留晚餐，按路程调整",tradeOff:"空档不强行填满",steps:ctx.confirmedItinerary.map((e:any)=>({eventId:e.id,poiId:null,durationMinutes:e.durationSource==="unknown"&&!e.locked?60:null,travelMode:ctx.world.routes.some((r:any)=>r.travelMode==="TRANSIT"&&r.status==="available")?"TRANSIT":"WALKING",reason:"保留原计划"})),removed:[]}]};
   }
   return Response.json({id:"response",object:"response",status:"completed",output:[{id:"msg",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(output),annotations:[]}]}]});
  }
  queries.push(u);
  if(u.pathname.includes("/place/")){
   const q=u.searchParams.get("keywords")??"";
   let found=u.pathname.endsWith("detail")?pois.filter(p=>p.id===u.searchParams.get("id")):q.includes("虹桥国际机场")?[pois[0],poi("terminal","上海虹桥国际机场T2航站楼")]:q==="美术馆"?(ambiguousMuseum?[pois[1],poi("other-art","上海美术馆")]:[pois[1]]):pois.filter(p=>p.name===q);
   return Response.json({status:"1",pois:found});
  }
  if(u.pathname.includes("/direction/"))return Response.json({status:"1",route:failRoutes?{}:u.pathname.includes("transit")?{transits:[{duration:"1200",distance:"5000",cost:"6"}]}:{paths:[{duration:"1800",distance:"5000"}]}});
  if(u.pathname.endsWith("/regeo"))return Response.json({status:"1",regeocode:{addressComponent:{city:"上海市",adcode:"310112"},formatted_address:"上海"}});
  if(u.pathname.endsWith("/convert"))return Response.json({status:"1",locations:"121.334,31.203"});
  throw new Error("Unexpected test HTTP path");
 };
 const reset=()=>{clearWorldCache();queries=[];plannerCalls=0;active=structuredClone(extraction);};
 try{
  reset();const s=base();s.itinerary=[saved("art","龙美术馆","龙美术馆","10:00","11:00",false),saved("dinner","预约晚餐","和平饭店","18:00","19:00",true)];
  const ready=await runAgentAssist({snapshot:s,rawText:text,browserLocation:{latitude:39.9,longitude:116.4,coordinateSystem:"WGS84",accuracy:10,capturedAt:new Date().toISOString(),source:"browser_geolocation"}});
  assert.equal(ready.status,"ready");assert(ready.result.ok);assert(plannerCalls>0);
  assert.equal(ready.base.trip.destination,"上海市");assert.equal(ready.base.state.currentLocation,"虹桥");
  assert(!queries.some(q=>q.pathname.endsWith("/convert")),"explicit location wins over GPS");
  assert(queries.some(q=>q.searchParams.get("keywords")==="上海虹桥国际机场"&&!q.searchParams.has("city")));
  assert(!queries.some(q=>q.searchParams.get("city")==="待确认城市"));
  for(const mode of ["walking","driving","transit"])assert(queries.some(q=>q.pathname.includes(mode)));
  assert(queries.filter(q=>q.pathname.includes("/direction/")).length<=40);
  assert.deepEqual(validatePlan(ready.result.context,ready.result.plan),[]);
  const forged=structuredClone(ready.result.plan!);forged.events[0].travelMode="DRIVING";
  assert(validatePlan(ready.result.context,forged).some(v=>v.code==="travel_time"),"per-leg time must match selected mode");
  const refreshed=await new WorldContextService().ground({snapshot:ready.base,request:ready.request,mode:"live",confirmation:{status:"confirmed",confirmedAt:new Date().toISOString()}});
  assert.equal(refreshed.status,"ready");assert.deepEqual(validatePlan({...ready.result.context,world:refreshed},ready.result.plan),[]);
  console.log("PASS Hongqiao with saved dinner: city grounded, three modes compared, explicit text wins, acceptance revalidates");

  reset();const question=await runAgentAssist({snapshot:base(),rawText:text});
  assert.equal(question.status,"needs_input");assert.equal(question.missingFacts.length,1);assert(question.missingFacts[0].reason.includes("晚餐"));assert.equal(plannerCalls,0);
  assert(queries.some(q=>q.searchParams.get("keywords")==="上海虹桥国际机场"));
  const rawFollow=text+"\n补充回答：晚餐在和平饭店。";
  active.activities[1].location="和平饭店";active.activities[1].sourceText="下午 6 点的预约晚餐必须保留";
  const follow=await runAgentAssist({snapshot:base(),rawText:rawFollow});
  assert.equal(follow.status,"ready");assert(follow.result.ok);assert.equal(follow.result.plan!.events.length,2);
  assert.equal(follow.result.plan!.events[0].durationSource,"suggested");assert.equal(follow.result.plan!.events[1].durationSource,"unknown");assert.equal(follow.result.plan!.events[1].startTime,"18:00");assert.equal(follow.result.plan!.events[1].endTime,"18:00");
  assert(!follow.impactAnalysis.availableTimeWindows.some(w=>w.startTime>="18:00"));
  assert(follow.result.decisionTrace!.validationEvidence.some(e=>e.check.includes("时长")&&e.status==="not_checked"));
  const invalid=structuredClone(follow.result.plan!);invalid.events.push({...invalid.events[0],id:"forged-after",startTime:"19:00",endTime:"20:00"});assert(validatePlan(follow.result.context,invalid).some(v=>v.code==="duration"));
  console.log("PASS missing dinner asks one question; natural-language answer keeps partial museum and final arrival-only booking");

  reset();ambiguousMuseum=true;active.activities[1].location="和平饭店";
  const ambiguous=await runAgentAssist({snapshot:base(),rawText:rawFollow});assert.equal(ambiguous.status,"needs_input");assert.equal(ambiguous.ambiguities?.[0].candidates.length,2);
  const chosen=await runAgentAssist({snapshot:base(),rawText:rawFollow,userAnswers:{venueSelections:{[ambiguous.missingFacts[0].field]:"art"}}});assert.equal(chosen.status,"ready");assert(chosen.result.ok);
  ambiguousMuseum=false;
  console.log("PASS ambiguous museum returns actual candidates and selection is applied without rewriting the itinerary");

  reset();active.activities[1].location="和平饭店";
  const noTaxi=await runAgentAssist({snapshot:base(),rawText:rawFollow+"不要打车。"});assert.equal(noTaxi.status,"ready");assert(!queries.some(q=>q.pathname.includes("driving")));
  assert.deepEqual(allowedModes("我只能坐地铁"),["TRANSIT"]);
  reset();failRoutes=true;active.activities[1].location="和平饭店";
  const unavailable=await runAgentAssist({snapshot:base(),rawText:rawFollow});assert.equal(unavailable.status,"unavailable");assert.equal(plannerCalls,0);failRoutes=false;
  console.log("PASS explicit transport restrictions and total route failure never invoke Mock or fabricate feasibility");

  reset();active.context.currentLocation={value:"酒店",sourceText:"在酒店"};active.activities[1].location="和平饭店";
  const hotelSnapshot=base();hotelSnapshot.itinerary=[{...saved("hotel","酒店入住","虹桥酒店","08:00","09:00",false),status:"completed"}];
  const hotel=await runAgentAssist({snapshot:hotelSnapshot,rawText:rawFollow+"我在酒店"});assert.equal(hotel.status,"ready");assert(!hotel.result.plan?.events.some(e=>e.id==="hotel"));assert(queries.some(q=>q.searchParams.get("keywords")==="虹桥酒店"));
  const stale={latitude:31,longitude:121,coordinateSystem:"WGS84" as const,accuracy:10,capturedAt:new Date(Date.now()-3600000).toISOString(),source:"browser_geolocation" as const};assert.equal(freshBrowserLocation(stale),false);
  console.log("PASS hotel reference uses unique saved hotel; completed history excluded; stale GPS rejected");
 }finally{globalThis.fetch=oldFetch;clearWorldCache();if(key===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=key;if(amap===undefined)delete process.env.AMAP_API_KEY;else process.env.AMAP_API_KEY=amap;}
}
