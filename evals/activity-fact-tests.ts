import assert from "node:assert/strict";
import { createStarterSnapshot } from "../data/session-defaults";
import { reconcileActivityFacts, snapshotActivityFacts } from "../services/activity-facts";
import { activityFactToEvent } from "../services/itinerary-domain";
import { protectionPolicyForActivity } from "../services/protection-policy";
import { normalizeSemanticExtraction } from "../services/semantic-parser";
import { runAgentAssist } from "../agents/agent-orchestrator";
import { EventSchema, SemanticExtractionSchema, SnapshotSchema } from "../types";

async function main() {
const base=createStarterSnapshot();
const snapshot=SnapshotSchema.parse({...base,trip:{...base.trip,destination:"上海"},state:{...base.state,currentLocation:"人民广场"},stateSources:{...base.stateSources,currentLocation:"user"},itinerary:[EventSchema.parse({
  id:"museum",placeId:"museum-poi",name:"城市博物馆",category:"culture",startTime:"10:00",endTime:"11:00",startTimeSource:"user",durationSource:"user",location:"城市博物馆",status:"planned",locked:false,indoorOutdoor:"mixed",openingTime:null,closingTime:null,travelTimeFromPrevious:12,travelMode:"TRANSIT",reason:"原行程展示说明",constraint:"保留展示元数据",
})]});
const semanticContext={currentTime:{value:null,sourceText:null},currentLocation:{value:null,sourceText:null},weather:{value:null,sourceText:null},energyLevel:{value:null,sourceText:null}};

const parsed=normalizeSemanticExtraction(snapshot,"原定10点去城市博物馆，下午3点去外滩，18点可能预约海棠餐厅",SemanticExtractionSchema.parse({
  intent:"rescue",
  activities:[
    {role:"existing_plan",name:"城市博物馆",startTime:"10:00",startTimeEvidence:"10点",endTime:null,durationMinutes:null,location:"城市博物馆",locked:"no",sourceText:"原定10点去城市博物馆",progress:"not_started"},
    {role:"existing_plan",name:"外滩散步",startTime:"15:00",startTimeEvidence:"下午3点",endTime:null,durationMinutes:null,location:"外滩",locked:"no",sourceText:"下午3点去外滩",progress:"not_started"},
    {role:"existing_plan",name:"海棠餐厅晚餐",startTime:"18:00",startTimeEvidence:"18点",endTime:null,durationMinutes:null,location:"海棠餐厅",locked:"no",sourceText:"18点可能预约海棠餐厅",progress:"not_started"},
  ],
  disruptions:[{kind:"changed_mind",label:"调整原安排",sourceText:"可能预约"}],constraints:[],context:semanticContext,question:null,ambiguities:[],
}),"test-model");

assert.equal("existingPlans" in parsed,false);
assert.equal("activityMentions" in parsed,false);
const museum=parsed.activityFacts.find(fact=>fact.id==="museum")!;
assert.equal(museum.snapshotEventId,"museum");
assert.equal(museum.endTime,"11:00");
assert.equal(museum.durationSource,"user");
const bund=parsed.activityFacts.find(fact=>fact.name==="外滩散步")!;
assert.equal(bund.placeId,`custom-${bund.id}`);
assert.equal(bund.endTime,null);
assert.equal(bund.durationSource,"unknown");
const uncertain=parsed.activityFacts.find(fact=>fact.name==="海棠餐厅晚餐")!;
assert.equal(uncertain.commitment,"uncertain");
assert.equal(uncertain.protectionPolicy?.source,"possible");

const reconciled=reconcileActivityFacts(snapshot,[{...museum,origin:"message",id:"new-model-id",snapshotEventId:"museum",sourceText:"原定10点去城市博物馆"}]);
assert.equal(reconciled.filter(fact=>fact.snapshotEventId==="museum").length,1);
assert.equal(reconciled.find(fact=>fact.snapshotEventId==="museum")?.id,"museum");

const fixedPolicy=protectionPolicyForActivity({name:"城市博物馆",location:"城市博物馆",sourceText:"固定预约城市博物馆",startTime:"10:00",endTime:"11:00",durationMinutes:60,commitment:"fixed"})!;
const lockedSnapshot=SnapshotSchema.parse({...snapshot,itinerary:[{...snapshot.itinerary[0],status:"locked",locked:true,protectionPolicy:fixedPolicy}]});
const lockedFact=snapshotActivityFacts(lockedSnapshot)[0];
const parserReconciled=reconcileActivityFacts(lockedSnapshot,[{...lockedFact,id:"model-copy",origin:"message",commitment:"flexible",protectionPolicy:undefined}]);
assert.equal(parserReconciled[0].commitment,"fixed");
assert(parserReconciled[0].protectionPolicy);
const explicitlyEdited=reconcileActivityFacts(lockedSnapshot,[{...lockedFact,startTime:null,endTime:null,durationMinutes:null,durationSource:"unknown",placeQuery:null,commitment:"flexible",protectionPolicy:undefined}]);
assert.equal(explicitlyEdited[0].commitment,"flexible");
assert.equal(explicitlyEdited[0].protectionPolicy,undefined);
assert.equal(explicitlyEdited[0].startTime,null);
assert.equal(explicitlyEdited[0].placeQuery,null);

const duplicateNameSnapshot=SnapshotSchema.parse({...snapshot,itinerary:[
  snapshot.itinerary[0],
  EventSchema.parse({...snapshot.itinerary[0],id:"museum-east",placeId:"museum-east-poi",location:"城市博物馆东馆"}),
]});
const duplicateNameFact={...snapshotActivityFacts(duplicateNameSnapshot)[0],id:"model-duplicate",placeId:"custom-model-duplicate",origin:"message" as const,snapshotEventId:null,sourceText:"原定10点去城市博物馆"};
const placeDisambiguated=reconcileActivityFacts(duplicateNameSnapshot,[duplicateNameFact]);
assert.equal(placeDisambiguated.length,2);
assert.equal(placeDisambiguated.find(fact=>fact.id==="museum")?.sourceText,duplicateNameFact.sourceText);
assert.equal(placeDisambiguated.some(fact=>fact.id==="model-duplicate"),false);

const placeDisambiguatedTimeChange=reconcileActivityFacts(duplicateNameSnapshot,[{...duplicateNameFact,id:"model-east-time-change",placeQuery:"城市博物馆东馆",startTime:"12:00",endTime:null,durationMinutes:null,durationSource:"unknown"}]);
assert.equal(placeDisambiguatedTimeChange.length,2);
assert.equal(placeDisambiguatedTimeChange.find(fact=>fact.id==="museum-east")?.startTime,"12:00");
assert.equal(placeDisambiguatedTimeChange.find(fact=>fact.id==="museum-east")?.endTime,"13:00");
assert.equal(placeDisambiguatedTimeChange.some(fact=>fact.id==="model-east-time-change"),false);

const unresolvedDuplicate=reconcileActivityFacts(duplicateNameSnapshot,[{...duplicateNameFact,id:"model-ambiguous",placeQuery:null}]);
assert.equal(unresolvedDuplicate.length,2);
assert.equal(unresolvedDuplicate.some(fact=>fact.id==="model-ambiguous"),false);

const explicitDuplicateMatch=reconcileActivityFacts(duplicateNameSnapshot,[{...duplicateNameFact,id:"model-explicit",snapshotEventId:"museum-east",placeQuery:null,sourceText:"明确指向东馆"}]);
assert.equal(explicitDuplicateMatch.length,2);
assert.equal(explicitDuplicateMatch.find(fact=>fact.id==="museum-east")?.sourceText,"明确指向东馆");

const changedTimeFact={...snapshotActivityFacts(snapshot)[0],id:"message-change",placeId:"custom-message-change",origin:"message" as const,snapshotEventId:null,startTime:"11:00",startTimeSource:"user" as const,endTime:null,durationMinutes:null,durationSource:"unknown" as const,sourceText:"把城市博物馆改到11点"};
const changedTime=reconcileActivityFacts(snapshot,[changedTimeFact]);
assert.equal(changedTime.length,1);
assert.equal(changedTime[0].id,"museum");
assert.equal(changedTime[0].snapshotEventId,"museum");
assert.equal(changedTime[0].startTime,"11:00");
assert.equal(changedTime[0].endTime,"12:00");
assert.equal(changedTime[0].durationMinutes,60);
assert.equal(changedTime[0].durationSource,"user");

const changedTimeRaw="把城市博物馆改到11点";
const changedTimeExtraction=SemanticExtractionSchema.parse({
  intent:"rescue",
  activities:[{role:"existing_plan",name:"城市博物馆",startTime:"11:00",startTimeEvidence:"11点",endTime:null,durationMinutes:null,location:"城市博物馆",locked:"no",sourceText:changedTimeRaw,progress:"not_started"}],
  disruptions:[{kind:"changed_mind",label:"修改时间",sourceText:changedTimeRaw}],constraints:[],context:semanticContext,question:null,ambiguities:[],
});
const changedTimeParsed=normalizeSemanticExtraction(snapshot,changedTimeRaw,changedTimeExtraction,"test-model");
assert.equal(changedTimeParsed.activityFacts.length,1);
assert.equal(changedTimeParsed.activityFacts[0].id,"museum");
assert.equal(changedTimeParsed.activityFacts[0].startTime,"11:00");
assert.equal(changedTimeParsed.activityFacts[0].endTime,"12:00");
assert.equal(changedTimeParsed.activityFacts[0].durationMinutes,60);

const ambiguousRaw="把城市博物馆改到12点";
const ambiguousExtraction=SemanticExtractionSchema.parse({
  ...changedTimeExtraction,
  activities:[{...changedTimeExtraction.activities[0],startTime:"12:00",startTimeEvidence:"12点",location:null,sourceText:ambiguousRaw}],
  disruptions:[{kind:"changed_mind",label:"修改时间",sourceText:ambiguousRaw}],
});
const ambiguousParsed=normalizeSemanticExtraction(duplicateNameSnapshot,ambiguousRaw,ambiguousExtraction,"test-model");
assert.equal(ambiguousParsed.activityFacts.length,2);
assert(ambiguousParsed.missingFacts.some(field=>field.startsWith("activityMatch:")));
assert(ambiguousParsed.parseWarnings.some(warning=>warning.includes("对应多个同名原安排")));
const ambiguousResponse=await runAgentAssist({snapshot:duplicateNameSnapshot,rawText:ambiguousRaw},undefined,{parse:async()=>ambiguousParsed});
assert.equal(ambiguousResponse.status,"OUT_OF_SCOPE");
assert.match(ambiguousResponse.message,/补充它原来的时间或地点/);

const suggestedPolicy=protectionPolicyForActivity({name:"预约晚餐",location:"海棠餐厅",sourceText:"18点预约晚餐",startTime:"18:00",durationMinutes:null,commitment:"fixed"});
assert(suggestedPolicy);
const converted=activityFactToEvent({...uncertain,id:"museum",placeId:"museum-poi",snapshotEventId:"museum",origin:"snapshot",name:"城市博物馆",placeQuery:"城市博物馆",startTime:"10:00",endTime:"10:45",durationMinutes:45,durationSource:"suggested",commitment:"flexible",protectionPolicy:undefined},snapshot);
assert.equal(converted.id,"museum");
assert.equal(converted.placeId,"museum-poi");
assert.equal(converted.travelTimeFromPrevious,12);
assert.equal(converted.reason,"原行程展示说明");
assert.equal(converted.durationSource,"suggested");

const facts=snapshotActivityFacts(snapshot);
assert.deepEqual(facts.map(fact=>fact.id),["museum"]);
console.log("ActivityFact single-source tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
