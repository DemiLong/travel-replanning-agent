import { WorldContextService } from "../services/world/world-context-service";
import { buildRealContext } from "./real-context-builder";
import { DeepSeekPlanner, materializeCandidate, type CandidatePlanner } from "../services/deepseek-planner";
import { UnknownDurationConflict } from "../services/deepseek-planner";
import { validatePlan } from "../validators";
import { decisionTrace } from "./replanning-agent";
import { MAX_SUGGESTED_DURATION, MIN_SUGGESTED_DURATION } from "../lib/time";
import type { AgentResult, ImpactAnalysis, PlanConflict, ResolutionOption, Violation } from "../types";
import type { RealWorldContext } from "../types/world";
export const MAX_REPLAN_ATTEMPTS=3;

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

function removeConflictingActivity(candidate: import("../services/deepseek-planner").PlanCandidate, context: ReturnType<typeof buildRealContext>, conflict: PlanConflict) {
  if (conflict.kind !== "unknown_duration_window") return null;
  const event = context.remainingEvents.find(item => item.id === conflict.eventId);
  if (!event || event.locked || !candidate.steps.some(step => step.eventId === event.id)) return null;
  return {
    ...candidate,
    title: `${candidate.title}（已跳过${event.name}）`,
    tradeOff: `${candidate.tradeOff}；${event.name}与后续安排之间时间不足，因此自动跳过。`,
    steps: candidate.steps.filter(step => step.eventId !== event.id),
    removed: [...candidate.removed, { eventId: event.id, reason: `${event.name}与后续固定安排之间可用时间不足，已自动跳过。` }],
  };
}

export async function replanReal(raw:unknown,planner:CandidatePlanner=new DeepSeekPlanner(),worldService:Pick<WorldContextService,"ground">=new WorldContextService(),impactAnalysis?:ImpactAnalysis):Promise<AgentResult|{world:RealWorldContext;error:string}>{
  const world=await worldService.ground(raw);
  if(world.status!=="ready")return {world,error:"真实世界数据尚未完整，请确认地点或补充必要信息。"};
  const context=buildRealContext(raw,world,impactAnalysis),attempts:AgentResult["attempts"]=[];
  let feedback:Violation[]=[],comparisons:NonNullable<AgentResult["candidateComparisons"]>=[],candidatePlans:NonNullable<AgentResult["candidatePlans"]>=[];
  for(let attempt=0;attempt<MAX_REPLAN_ATTEMPTS;attempt++){
    const started=Date.now();feedback=attempt?feedback:[];
    let selected:AgentResult["plan"]=null;
    try{
      const candidates=await planner.generateCandidates(context,feedback,attempt);
      feedback=[];comparisons=[];candidatePlans=[];
      for(const candidate of candidates){
        try{
          const plan=materializeCandidate(context,candidate),violations=validatePlan(context,plan);
          comparisons.push({title:candidate.title,tradeOff:candidate.tradeOff,feasible:!violations.length,conflicts:violations.map(v=>v.message)});
          candidatePlans.push({id:crypto.randomUUID(),title:candidate.title,tradeOff:candidate.tradeOff,feasible:!violations.length,plan,conflicts:violations.flatMap(v=>v.conflict?[v.conflict]:[])});
          feedback.push(...violations);
          if(!selected&&!violations.length)selected=plan;
        }catch(error){
          const message=error instanceof Error?error.message:"候选结构无效。";
          const conflict=error instanceof UnknownDurationConflict?error.conflict:undefined;
          feedback.push({code:conflict?.kind==="travel_time"?"travel_time":"duration",message,eventId:conflict?.eventId,conflict});comparisons.push({title:candidate.title,tradeOff:candidate.tradeOff,feasible:false,conflicts:[message]});
          candidatePlans.push({id:crypto.randomUUID(),title:candidate.title,tradeOff:candidate.tradeOff,feasible:false,plan:null,conflicts:conflict?[conflict]:[]});
          if (conflict) {
            const repaired = removeConflictingActivity(candidate, context, conflict);
            if (repaired) {
              try {
                const repairedPlan = materializeCandidate(context, repaired);
                const repairedViolations = validatePlan(context, repairedPlan);
                comparisons.push({title:repaired.title,tradeOff:repaired.tradeOff,feasible:!repairedViolations.length,conflicts:repairedViolations.map(v=>v.message)});
                candidatePlans.push({id:crypto.randomUUID(),title:repaired.title,tradeOff:repaired.tradeOff,feasible:!repairedViolations.length,plan:repairedPlan,conflicts:repairedViolations.flatMap(v=>v.conflict?[v.conflict]:[])});
                feedback.push(...repairedViolations);
                if (!selected && !repairedViolations.length) selected = repairedPlan;
              } catch (repairError) {
                const repairMessage = repairError instanceof Error ? repairError.message : "自动跳过后仍无法安排。";
                feedback.push({code:"duration",eventId:conflict.eventId,message:repairMessage,conflict});
              }
            }
          }
        }
      }
    }catch{feedback=[{code:"schema",message:"DeepSeek 未返回完整候选方案，本轮没有使用本地规划替代。"}];}
    attempts.push({attempt:attempt+1,durationMs:Date.now()-started,violations:selected?[]:feedback});
    if(selected)return {id:crypto.randomUUID(),ok:true,plan:selected,attempts,mode:"live",model:planner.name,message:"已通过当前可验证规则。营业状态等未确认信息请查看说明。",verificationLevel:"partial",context,impactAnalysis,decisionTrace:decisionTrace(context,selected,[]),candidateComparisons:comparisons,candidatePlans};
  }
  const conflicts=collectConflicts(feedback);
  return {id:crypto.randomUUID(),ok:false,plan:null,attempts,mode:"live",model:planner.name,message:"当前安排之间暂时没有可执行的组合。",verificationLevel:"partial",context,impactAnalysis,decisionTrace:decisionTrace(context,null,feedback),candidateComparisons:comparisons,candidatePlans,conflicts,resolutionOptions:resolutionOptions(context,conflicts)};
}
