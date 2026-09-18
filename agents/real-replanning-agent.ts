import { WorldContextService } from "../services/world/world-context-service";
import { buildRealContext } from "./real-context-builder";
import { DeepSeekPlanner, materializeCandidate, type CandidatePlanner } from "../services/deepseek-planner";
import { validatePlan } from "../validators";
import { decisionTrace } from "./replanning-agent";
import type { AgentResult, ImpactAnalysis, Violation } from "../types";
import type { RealWorldContext } from "../types/world";
export const MAX_REPLAN_ATTEMPTS=2;
export async function replanReal(raw:unknown,planner:CandidatePlanner=new DeepSeekPlanner(),worldService:Pick<WorldContextService,"ground">=new WorldContextService(),impactAnalysis?:ImpactAnalysis):Promise<AgentResult|{world:RealWorldContext;error:string}>{
  const world=await worldService.ground(raw);
  if(world.status!=="ready")return {world,error:"真实世界数据尚未完整，请确认地点或补充必要信息。"};
  const context=buildRealContext(raw,world,impactAnalysis),attempts:AgentResult["attempts"]=[];
  let feedback:Violation[]=[],comparisons:NonNullable<AgentResult["candidateComparisons"]>=[];
  for(let attempt=0;attempt<MAX_REPLAN_ATTEMPTS;attempt++){
    const started=Date.now();feedback=attempt?feedback:[];
    let selected:AgentResult["plan"]=null;
    try{
      const candidates=await planner.generateCandidates(context,feedback,attempt);
      feedback=[];comparisons=[];
      for(const candidate of candidates){
        try{
          const plan=materializeCandidate(context,candidate),violations=validatePlan(context,plan);
          comparisons.push({title:candidate.title,tradeOff:candidate.tradeOff,feasible:!violations.length,conflicts:violations.map(v=>v.message)});
          feedback.push(...violations);
          if(!selected&&!violations.length)selected=plan;
        }catch(error){
          const message=error instanceof Error?error.message:"候选结构无效。";
          feedback.push({code:"schema",message});comparisons.push({title:candidate.title,tradeOff:candidate.tradeOff,feasible:false,conflicts:[message]});
        }
      }
    }catch{feedback=[{code:"schema",message:"DeepSeek 未返回完整候选方案，本轮没有使用本地规划替代。"}];}
    attempts.push({attempt:attempt+1,durationMs:Date.now()-started,violations:selected?[]:feedback});
    if(selected)return {id:crypto.randomUUID(),ok:true,plan:selected,attempts,mode:"live",model:planner.name,message:"已通过当前可验证规则。营业状态等未确认信息请查看说明。",verificationLevel:"partial",context,impactAnalysis,decisionTrace:decisionTrace(context,selected,[]),candidateComparisons:comparisons};
  }
  return {id:crypto.randomUUID(),ok:false,plan:null,attempts,mode:"live",model:planner.name,message:"目前没有找到满足全部硬约束的方案。",verificationLevel:"partial",context,impactAnalysis,decisionTrace:decisionTrace(context,null,feedback),candidateComparisons:comparisons};
}
