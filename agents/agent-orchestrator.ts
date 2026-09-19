import { z } from "zod";
import { createHash } from "node:crypto";
import { ConfirmedDraftSchema, EventSchema, ParsedUserInputSchema, ReplanningRequestSchema, SnapshotSchema, type AgentResult, type ConfirmedDraft, type ImpactAnalysis, type MissingFact, type ParsedUserInput, type Snapshot } from "../types";
import { BrowserLocationSchema, TravelModeSchema, type RealWorldContext } from "../types/world";
import { addMinutesWithinDay } from "../lib/time";
import { DeepSeekSemanticParser } from "../services/semantic-parser";
import { analyzeImpact } from "../services/impact-analysis";
import { WorldContextService } from "../services/world/world-context-service";
import { allowedModes, genericLocation } from "../services/world/context-resolution";
import { replanReal } from "./real-replanning-agent";

export const AssistRequestSchema = z.object({
  snapshot: SnapshotSchema, rawText:z.string().trim().min(1).max(4000), browserLocation:BrowserLocationSchema.optional(),
  userAnswers:z.object({destination:z.string().trim().max(80).optional(),currentLocation:z.string().trim().max(100).optional(),travelMode:TravelModeSchema.optional(),venueSelections:z.record(z.string().min(1)).optional(),durations:z.record(z.number().int().positive().max(1440)).optional()}).optional(),
  confirmedDraft: ConfirmedDraftSchema.optional(), appendText:z.string().trim().max(4000).optional(), replaceRawText:z.string().trim().max(4000).optional(),
});
export type AssistRequest=z.infer<typeof AssistRequestSchema>;
export type AssistResponse =
  | {status:"needs_input";parsedInput:ParsedUserInput;impactAnalysis:ImpactAnalysis;missingFacts:MissingFact[];ambiguities?:RealWorldContext["ambiguities"];world?:RealWorldContext}
  | {status:"ready";parsedInput:ParsedUserInput;impactAnalysis:ImpactAnalysis;result:AgentResult;base:Snapshot;request:ReturnType<typeof ReplanningRequestSchema.parse>}
  | {status:"unavailable";parsedInput:ParsedUserInput;impactAnalysis:ImpactAnalysis;error:string};
const related=(a:string,b:string)=>a.includes(b)||b.includes(a)||(/美术馆/.test(a)&&/美术馆/.test(b))||(/晚餐|餐厅/.test(a)&&/晚餐|餐厅/.test(b));

function draftToParsed(draft:ConfirmedDraft):ParsedUserInput {
  return ParsedUserInputSchema.parse({
    rawText:draft.rawText,intent:draft.intent,
    existingPlans:draft.existingPlans.map(item=>({...item,source:"user" as const})),
    activityMentions:draft.activityMentions,disruptions:draft.disruptions,constraints:draft.constraints,
    context:draft.context,contextSources:draft.contextSources,
    closedPlaceIds:draft.closedPlaceIds,missingFacts:[],status:"confirmed",parser:"manual",parserModel:null,parseWarnings:[],question:draft.question,worldOptions:draft.worldOptions??{selectedPois:{}},
  });
}

function materializeDraftTime(item:ConfirmedDraft["existingPlans"][number]) {
  if(item.endTime)return {endTime:item.endTime,durationSource:"user" as const};
  if(item.durationMinutes!==null)return {endTime:addMinutesWithinDay(item.startTime,item.durationMinutes),durationSource:"user" as const};
  return {endTime:item.startTime,durationSource:"unknown" as const};
}

function mergeConfirmedDraft(input:AssistRequest,draft:ConfirmedDraft):Snapshot {
  const base=input.snapshot;
  if(draft.baseRevision!==base.revision)throw new Error("原行程版本已变化，请重新确认后再生成方案。");
  const removedLocked=new Set(draft.removedLockedIds);
  const incomingIds=new Set(draft.existingPlans.map(item=>item.id));
  for(const id of removedLocked){
    const event=base.itinerary.find(item=>item.id===id);
    if(!event?.locked)throw new Error("removedLockedIds 只能包含当前行程中的固定安排。");
    if(incomingIds.has(id))throw new Error("固定安排不能同时保留并标记为删除。");
  }
  const next=base.itinerary.filter(event=>event.status==="completed");
  for(const old of base.itinerary.filter(event=>event.status!=="completed")){
    if(incomingIds.has(old.id))continue;
    if(old.locked&&!removedLocked.has(old.id))throw new Error(`固定安排“${old.name}”不能被静默删除，请先明确确认。`);
  }
  for(const item of draft.existingPlans){
    const old=base.itinerary.find(event=>event.id===item.id);
    if(old?.status==="completed")throw new Error(`已完成安排“${old.name}”不能重新编辑。`);
    const timing=materializeDraftTime(item);
    if(old?.locked&&(!item.locked||item.name!==old.name||item.startTime!==old.startTime||timing.endTime!==old.endTime||item.placeId!==old.placeId||item.location!==old.location||item.estimatedCost!==old.estimatedCost||item.estimatedCostKnown!==old.estimatedCostKnown))throw new Error(`固定安排“${old.name}”的时间、地点、名称、费用和锁定状态不能修改。`);
    const changedLocation=Boolean(old&&item.location.trim()!==old.location.trim());
    const event=EventSchema.parse({
      ...(old??{category:"user activity",indoorOutdoor:"mixed",openingTime:null,closingTime:null,travelTimeFromPrevious:null,reason:item.locked?"这是用户确认需要保留的固定安排。":"这是用户确认的原有安排。",constraint:item.locked?"Locked plan":"Original plan"}),
      id:item.id,placeId:item.placeId??(changedLocation?`draft-place-${item.id}`:old?.placeId??`custom-${item.id}`),name:item.name,startTime:item.startTime,endTime:timing.endTime,durationSource:timing.durationSource,location:item.location,estimatedCost:item.estimatedCost,estimatedCostKnown:item.estimatedCostKnown,locked:old?.locked??item.locked,status:(old?.locked??item.locked)?"locked":"planned",
    });
    next.push(event);
  }
  const answers=input.userAnswers;
  const currentLocation=answers?.currentLocation?.trim()||draft.context.currentLocation||base.state.currentLocation;
  const state={...base.state,...draft.context,currentLocation,...(input.browserLocation?{browserLocation:input.browserLocation}:{})};
  return SnapshotSchema.parse({...base,state,stateSources:{...base.stateSources,...draft.contextSources,...(answers?.currentLocation?{currentLocation:"user" as const}:{}),disruption:draft.disruptions.length?"user":draft.contextSources.disruption},trip:{...base.trip,destination:answers?.destination||base.trip.destination},itinerary:next.sort((a,b)=>a.startTime.localeCompare(b.startTime))});
}

function appendToDraft(draft:ConfirmedDraft,addition:ParsedUserInput,appendText:string):ConfirmedDraft {
  return ConfirmedDraftSchema.parse({...draft,rawText:`${draft.rawText}\n${appendText}`.trim(),existingPlans:[...draft.existingPlans,...addition.existingPlans],activityMentions:[...draft.activityMentions,...addition.activityMentions],disruptions:[...draft.disruptions,...addition.disruptions],constraints:[...draft.constraints,...addition.constraints],context:{...draft.context,...addition.context},contextSources:{...draft.contextSources,...addition.contextSources},question:addition.question??draft.question,worldOptions:{...draft.worldOptions,...addition.worldOptions,selectedPois:{...draft.worldOptions?.selectedPois,...addition.worldOptions?.selectedPois}},});
}

function mergeFacts(input:AssistRequest,parsed:ParsedUserInput):Snapshot {
  const snapshot=input.snapshot, answers=input.userAnswers;
  const next=structuredClone(snapshot.itinerary);
  const plans=[...parsed.existingPlans.map(p=>({...p,locked:p.locked?"yes":"no",durationMinutes:null})),...parsed.activityMentions.filter(p=>p.role==="existing_plan")];
  const timeOccurrences=new Map<string,number>();
  plans.sort((a,b)=>(a.startTime??"").localeCompare(b.startTime??"")||a.name.localeCompare(b.name));
  for(const p of plans){
    if(!p.startTime)continue;
    const matches=next.filter(e=>e.startTime===p.startTime&&related(e.name,p.name));
    const old=matches.length===1?matches[0]:undefined;
    if(old?.status==="completed")continue;
    const occurrence=timeOccurrences.get(p.startTime)??0;timeOccurrences.set(p.startTime,occurrence+1);
    const id=old?.id??`assist-${createHash("sha256").update(`${p.startTime}:${occurrence}`).digest("hex").slice(0,16)}`;
    const duration=answers?.durations?.[p.id]??answers?.durations?.[id];
    const end=p.endTime??(p.durationMinutes||duration?addMinutesWithinDay(p.startTime,p.durationMinutes??duration!):old?.endTime??p.startTime);
    const explicitLocation=p.location&&!genericLocation(p.location)?p.location:undefined;
    const event=EventSchema.parse({
      id,placeId:old?.placeId??id,name:old?.name??p.name,category:old?.category??"user activity",startTime:p.startTime,endTime:end,
      durationSource:p.endTime||p.durationMinutes||duration?"user":old?.durationSource??(old?"user":"unknown"),
      location:explicitLocation??old?.location??p.location??(/晚餐/.test(p.name)?"晚餐":/酒店/.test(p.name)?"酒店":/景点/.test(p.name)?"景点":p.name),
      locked:old?.locked||p.locked==="yes",status:old?.locked||p.locked==="yes"?"locked":"planned",
      estimatedCost:("estimatedCostKnown" in p?p.estimatedCostKnown:p.estimatedCost!==null)?p.estimatedCost:old?.estimatedCost??0,estimatedCostKnown:("estimatedCostKnown" in p?p.estimatedCostKnown:p.estimatedCost!==null)?true:old?.estimatedCostKnown??false,
      indoorOutdoor:old?.indoorOutdoor??"mixed",openingTime:null,closingTime:null,travelTimeFromPrevious:null,
      reason:"来自用户原文或已保存行程。",constraint:old?.constraint??(p.locked==="yes"?"保留固定预约":"原计划；未知时长仅可作为建议"),
    });
    const i=next.findIndex(e=>e.id===id);if(i>=0)next[i]=event;else next.push(event);
  }
  const currentLocation=answers?.currentLocation?.trim()||parsed.context.currentLocation||snapshot.state.currentLocation;
  const browserLocation=input.browserLocation??parsed.context.browserLocation;
  parsed.context={...parsed.context,currentLocation,...(browserLocation?{browserLocation}:{})};
  if(answers?.currentLocation)parsed.contextSources.currentLocation="user";
  const modes=allowedModes(input.rawText,answers?.travelMode,parsed.worldOptions?.travelMode,[...parsed.constraints.map(c=>c.value),...snapshot.profile.preferences,...snapshot.profile.dislikes]);
  parsed.worldOptions={selectedPois:{...parsed.worldOptions?.selectedPois,...answers?.venueSelections},...(modes.length?{allowedTravelModes:modes}:{}),...(answers?.travelMode?{travelMode:answers.travelMode}:{})};
  return SnapshotSchema.parse({...snapshot,state:{...snapshot.state,...parsed.context},stateSources:parsed.contextSources,trip:{...snapshot.trip,destination:answers?.destination||snapshot.trip.destination},itinerary:next.sort((a,b)=>a.startTime.localeCompare(b.startTime))});
}
const buildRequest=(snapshot:Snapshot,parsed:ParsedUserInput,removedLockedIds:string[]=[] )=>ReplanningRequestSchema.parse({reason:parsed.disruptions[0]?.kind??"optimize",freeText:parsed.rawText,currentState:snapshot.state,closedPlaceIds:parsed.closedPlaceIds,variation:0,stateSources:parsed.contextSources,worldOptions:parsed.worldOptions,...(removedLockedIds.length?{confirmedDraftChanges:{removedLockedIds}}:{})});

export async function runAgentAssist(raw:unknown):Promise<AssistResponse>{
  const input=AssistRequestSchema.parse(raw);
  if(input.snapshot.mode!=="user"||Object.values(input.snapshot.stateSources).includes("demo"))throw new Error("真实流程不接受示例状态。");
  let parsed:ParsedUserInput;
  let snapshot:Snapshot;
  if(input.confirmedDraft){
    if(input.replaceRawText){
      parsed=await new DeepSeekSemanticParser().parse(input.snapshot,input.replaceRawText);
      snapshot=mergeFacts({...input,rawText:input.replaceRawText,confirmedDraft:undefined},parsed);
    }else if(input.appendText){
      const addition=await new DeepSeekSemanticParser().parse(input.snapshot,input.appendText);
      const draft=appendToDraft(input.confirmedDraft,addition,input.appendText);
      parsed=draftToParsed(draft);
      snapshot=mergeConfirmedDraft(input,draft);
    }else{
      parsed=draftToParsed(input.confirmedDraft);
      snapshot=mergeConfirmedDraft(input,input.confirmedDraft);
    }
  }else{
    parsed=await new DeepSeekSemanticParser().parse(input.snapshot,input.rawText);
    snapshot=mergeFacts(input,parsed);
  }
  const request=buildRequest(snapshot,parsed,input.confirmedDraft?.removedLockedIds??[]);
  let impact=analyzeImpact(snapshot,request);
  const missingUserFacts:MissingFact[]=[];
  const add=(field:string,reason:string)=>missingUserFacts.push({field,importance:"blocking",reason});
  const ask=(world?:RealWorldContext):AssistResponse=>{
    const priority=(f:MissingFact)=>snapshot.itinerary.find(e=>e.placeId===f.field)?.locked?0:f.field==="currentLocation"?1:2;
    const first=[...new Map(missingUserFacts.map(f=>[f.field,f])).values()].sort((a,b)=>priority(a)-priority(b))[0];
    parsed.missingFacts=[first.field];parsed.status="needs_input";
    return {status:"needs_input",parsedInput:parsed,impactAnalysis:impact,missingFacts:[first],ambiguities:world?.ambiguities.filter(a=>a.field===first.field)??[],world};
  };
  if(!snapshot.itinerary.some(e=>e.status!=="completed")){
    add("existingPlans","今天有哪些想保留的安排？直接告诉我即可。");return ask();
  }
  const world=await new WorldContextService().ground({snapshot,request,mode:"live",confirmation:{status:"confirmed",confirmedAt:new Date().toISOString()}});
  impact=analyzeImpact(snapshot,request,world);
  parsed.resolutionEvidence=world.resolutionEvidence;
  for(const f of world.missingWorldFacts.filter(f=>f.kind==="user"))add(f.field,f.message);
  for(const a of world.ambiguities)add(a.field,`“${a.label}”有几个可能地点，你指的是哪一个？`);
  for(const mention of parsed.activityMentions.filter(m=>m.role==="existing_plan"&&!m.startTime)){
    if(!snapshot.itinerary.some(e=>related(e.name,mention.name)))add(`activity:${mention.id}:startTime`,`“${mention.name}”安排在几点？`);
  }
  if(parsed.disruptions.some(d=>d.kind==="closed")&&!parsed.closedPlaceIds.length){
    const matches=snapshot.itinerary.filter(e=>parsed.disruptions.filter(d=>d.kind==="closed").some(d=>d.label.includes(e.name)||d.label.includes(e.location)));
    if(matches.length===1){parsed.closedPlaceIds=[matches[0].placeId];request.closedPlaceIds=parsed.closedPlaceIds;}
    else add("closedPlace","是哪个原计划地点关门了？");
  }
  if(missingUserFacts.length)return ask(world);
  if(world.status!=="ready")return {status:"unavailable",parsedInput:parsed,impactAnalysis:impact,error:world.missingWorldFacts.find(f=>f.kind==="world")?.message??"真实路线暂时不可用，请稍后重试。"};
  if(world.currentLocation?.city)snapshot.trip.destination=world.currentLocation.city;
  for(const resolved of world.resolvedPlaces)parsed.worldOptions!.selectedPois[resolved.placeId]=resolved.poi.poiId;
  const current=[...(world.resolutionEvidence??[])].reverse().find(e=>e.field==="currentLocation"&&e.poiId);
  if(current?.poiId)parsed.worldOptions!.selectedPois.currentLocation=current.poiId;
  request.worldOptions=parsed.worldOptions;
  parsed.status="confirmed";parsed.missingFacts=[];
  const result=await replanReal({snapshot,request,mode:"live",confirmation:{status:"confirmed",confirmedAt:new Date().toISOString()}},undefined,{ground:async()=>world},impact);
  if("error" in result)return {status:"unavailable",parsedInput:parsed,impactAnalysis:impact,error:result.error};
  return {status:"ready",parsedInput:ParsedUserInputSchema.parse(parsed),impactAnalysis:impact,result,base:snapshot,request};
}
