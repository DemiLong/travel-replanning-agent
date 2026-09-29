import { WorldContextService } from "../services/world/world-context-service";
import { buildRealContext } from "./real-context-builder";
import { DeepSeekPlanner, materializeCandidate, type CandidatePlanner } from "../services/deepseek-planner";
import { UnknownDurationConflict } from "../services/deepseek-planner";
import { validatePlan } from "../validators";
import { validatePlanExplanation } from "../services/plan-narrative";
import { decisionTrace } from "../services/decision-trace";
import { MAX_SUGGESTED_DURATION, MIN_SUGGESTED_DURATION } from "../lib/time";
import type { AgentResult, ImpactAnalysis, PlanConflict, ResolutionOption, Violation } from "../types";
import type { RealWorldContext } from "../types/world";
export const MAX_REPLAN_ATTEMPTS=2;

function collectConflicts(violations: Violation[]) {
  const unique = new Map<string, PlanConflict>();
  for (const item of violations) {
    if (item.conflict) unique.set(`${item.conflict.kind}:${item.conflict.eventId}:${item.conflict.nextAnchorEventId ?? ""}`, item.conflict);
  }
  return [...unique.values()];
}

function resolutionOptions(context: ReturnType<typeof buildRealContext>, conflicts: PlanConflict[]): ResolutionOption[] {
  const options: ResolutionOption[] = [];
  const addRemove = (eventId: string, requiresConfirmation: boolean) => {
    const event = context.remainingEvents.find(item => item.id === eventId);
    if (!event || options.some(option => option.id === `remove-${event.id}`)) return;
    options.push({
      id: `remove-${event.id}`,
      label: requiresConfirmation ? `确认删除${event.name}` : `跳过${event.name}`,
      action: "remove_event",
      eventId: event.id,
      requiresConfirmation,
    });
  };
  for (const conflict of conflicts) {
    const event = context.remainingEvents.find(item => item.id === conflict.eventId);
    const anchor = conflict.nextAnchorEventId ? context.remainingEvents.find(item => item.id === conflict.nextAnchorEventId) : undefined;
    if (conflict.kind === "unknown_duration_window" && event) {
      if (event.durationSource === "unknown" && (conflict.availableMinutes ?? 0) >= MIN_SUGGESTED_DURATION) {
        options.push({
          id: `shorten-${event.id}`,
          label: `将${event.name}安排为 ${Math.min(conflict.availableMinutes ?? MIN_SUGGESTED_DURATION, MAX_SUGGESTED_DURATION)} 分钟`,
          action: "shorten_unknown_duration",
          eventId: event.id,
          nextAnchorEventId: conflict.nextAnchorEventId,
          suggestedDuration: Math.min(conflict.availableMinutes ?? MIN_SUGGESTED_DURATION, MAX_SUGGESTED_DURATION),
          requiresConfirmation: false,
        });
      } else {
        addRemove(event.id, event.locked);
        if (anchor?.locked) addRemove(anchor.id, true);
        if (anchor?.locked) options.push({ id: `edit-${anchor.id}`, label: `回到编辑页重新确认${anchor.name}的固定时间`, action: "edit_locked_arrangement", eventId: anchor.id, requiresConfirmation: false });
      }
    }
    if (conflict.kind === "locked_schedule_conflict") {
      if (event) addRemove(event.id, true);
      if (anchor) addRemove(anchor.id, true);
      if (anchor) options.push({ id: `edit-${anchor.id}`, label: `回到编辑页重新确认${anchor.name}的固定时间`, action: "edit_locked_arrangement", eventId: anchor.id, requiresConfirmation: false });
    }
  }
  return options;
}

export async function replanReal(raw:unknown,planner:CandidatePlanner=new DeepSeekPlanner(),worldService:Pick<WorldContextService,"ground">=new WorldContextService(),impactAnalysis?:ImpactAnalysis,signal?:AbortSignal):Promise<AgentResult|{world:RealWorldContext;error:string}>{
  const world=await worldService.ground(raw, signal);
  if(world.status!=="ready")return {world,error:"真实世界数据尚未完整，请确认地点或补充必要信息。"};
  const context=buildRealContext(raw,world,impactAnalysis),attempts:AgentResult["attempts"]=[];
  let feedback:Violation[]=[],comparisons:NonNullable<AgentResult["candidateComparisons"]>=[],candidatePlans:NonNullable<AgentResult["candidatePlans"]>=[];
  for(let attempt=0;attempt<MAX_REPLAN_ATTEMPTS;attempt++){
    const started=Date.now();feedback=attempt?feedback:[];
    let selected:AgentResult["plan"]=null;
    try{
      const candidates=await planner.generateCandidates(context,feedback,attempt,signal);
      feedback=[];comparisons=[];candidatePlans=[];
      for(const candidate of candidates){
        try{
          const plan=materializeCandidate(context,candidate),violations=[...validatePlan(context,plan),...validatePlanExplanation(context,plan)];
          comparisons.push({title:plan.summary,tradeOff:plan.explanation,feasible:!violations.length,conflicts:violations.map(v=>v.message)});
          candidatePlans.push({id:crypto.randomUUID(),title:plan.summary,tradeOff:plan.explanation,feasible:!violations.length,plan,conflicts:violations.flatMap(v=>v.conflict?[v.conflict]:[])});
          feedback.push(...violations);
          if(!selected&&!violations.length)selected=plan;
        }catch(error){
          const message=error instanceof Error?error.message:"候选结构无效。";
          const conflict=error instanceof UnknownDurationConflict?error.conflict:undefined;
          feedback.push({code:conflict?.kind==="travel_time"?"travel_time":"duration",message,eventId:conflict?.eventId,conflict});comparisons.push({title:candidate.title,tradeOff:candidate.tradeOff,feasible:false,conflicts:[message]});
          candidatePlans.push({id:crypto.randomUUID(),title:candidate.title,tradeOff:candidate.tradeOff,feasible:false,plan:null,conflicts:conflict?[conflict]:[]});
        }
      }
    }catch{feedback=[{code:"schema",message:"DeepSeek 未返回完整候选方案，本轮没有使用本地规划替代。"}];}
    attempts.push({attempt:attempt+1,durationMs:Date.now()-started,violations:selected?[]:feedback});
    if(selected)return {id:crypto.randomUUID(),ok:true,plan:selected,attempts,mode:"live",model:planner.name,message:"已通过当前可验证规则。营业状态等未确认信息请查看说明。",verificationLevel:"partial",context,impactAnalysis,decisionTrace:decisionTrace(context,selected,[]),candidateComparisons:comparisons,candidatePlans};
  }
  const conflicts=collectConflicts(feedback);
  const reasons=[...new Set(feedback.map(item=>item.message).filter(Boolean))].slice(0,2);
  return {id:crypto.randomUUID(),ok:false,plan:null,attempts,mode:"live",model:planner.name,message:`基于当前的安排，暂时无法组合出可行方案。${reasons.length?`主要原因：${reasons.join("；")}`:"请核对地点、时间或交通条件后重试。"}`,verificationLevel:"partial",context,impactAnalysis,decisionTrace:decisionTrace(context,null,feedback),candidateComparisons:comparisons,candidatePlans,conflicts,resolutionOptions:resolutionOptions(context,conflicts)};
}
