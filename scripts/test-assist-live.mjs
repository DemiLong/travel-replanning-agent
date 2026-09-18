import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";

// Real HTTP; the time and saved venues below are explicit TEST fixtures.
const compile=spawnSync(process.execPath,["node_modules/typescript/bin/tsc","-p","tsconfig.evals.json"],{stdio:"inherit"});
if(compile.status!==0)process.exit(compile.status??1);
mkdirSync("work/eval-build",{recursive:true});writeFileSync("work/eval-build/package.json",'{"type":"commonjs"}');
const require=createRequire(import.meta.url);
const {createStarterSnapshot}=require("../work/eval-build/data/demo.js");
const {EventSchema}=require("../work/eval-build/types/index.js");
const {runAgentAssist}=require("../work/eval-build/agents/agent-orchestrator.js");
const {validatePlan}=require("../work/eval-build/validators/index.js");
const rawText="我原本 10:00 去美术馆，现在航班晚点了 2 小时，刚到虹桥。下午 6 点的预约晚餐必须保留。";
const snapshot=()=>{const s=createStarterSnapshot();s.trip.destination="待确认城市";s.state.currentTime="12:00";s.stateSources.currentTime="user";return s;};
try{
  const partial=await runAgentAssist({snapshot:snapshot(),rawText});
  assert.equal(partial.status,"needs_input");assert.equal(partial.missingFacts.length,1);
  assert(/晚餐/.test(partial.missingFacts[0].reason));
  assert(!["destination","travelMode"].includes(partial.missingFacts[0].field));
  console.log("PASS actual DeepSeek + Amap: only the unknown dinner venue is asked");
  const s=snapshot();
  s.itinerary=[{id:"art",name:"美术馆",location:"上海美术馆(中华艺术宫)",startTime:"10:00",endTime:"11:30",locked:false},{id:"dinner",name:"预约晚餐",location:"上海和平饭店龙凤厅",startTime:"18:00",endTime:"19:00",locked:true}].map(e=>EventSchema.parse({...e,placeId:e.id,category:"user activity",status:e.locked?"locked":"planned",estimatedCost:0,estimatedCostKnown:false,indoorOutdoor:"mixed",openingTime:null,closingTime:null,travelTimeFromPrevious:null,reason:"Explicit TEST saved venue",constraint:e.locked?"固定预约":"原安排"}));
  const ready=await runAgentAssist({snapshot:s,rawText});
  assert.equal(ready.status,"ready");assert(ready.result.ok,"live provider returned no feasible plan");
  assert.equal(ready.base.trip.destination,"上海市");assert.equal(ready.parsedInput.parser,"llm");
  assert.deepEqual(validatePlan(ready.result.context,ready.result.plan),[]);
  assert(ready.result.attempts.length<=2);
  const world=ready.result.context.world;
  assert(world.routes.length<=40&&world.routes.every(r=>r.source==="amap"));
  const report={testedAt:new Date().toISOString(),fixture:"Explicit test time 12:00 and saved Shanghai venues; live routes fetched at testedAt",status:ready.status,parser:ready.parsedInput.parser,question:partial.missingFacts,evidence:world.resolutionEvidence,routes:world.routes,ok:ready.result.ok,attempts:ready.result.attempts,events:ready.result.plan.events};
  writeFileSync("work/assist-resolution-live-retest.json",JSON.stringify(report,null,2));
  console.log("PASS actual grounded Planner + Validator; report: work/assist-resolution-live-retest.json");
}catch(error){
  let message=String(error?.message??"Live verification failed");
  for(const key of [process.env.DEEPSEEK_API_KEY,process.env.AMAP_API_KEY])if(key)message=message.replaceAll(key,"[REDACTED]");
  console.error(message);process.exitCode=1;
}
