import type { AgentContext, ImpactAnalysis } from "../types";
import type { RealWorldContext } from "../types/world";
import { validateRealInput } from "../services/world/world-context-service";
export function buildRealContext(raw:unknown,world:RealWorldContext,impactAnalysis?:ImpactAnalysis):AgentContext{
  const {snapshot,request}=validateRealInput(raw);
  if(world.status!=="ready")throw new Error("真实世界数据尚未准备好。");
  const remaining=snapshot.itinerary.filter(e=>e.status!=="completed");
  return {profile:snapshot.profile,trip:snapshot.trip,state:request.currentState,stateSources:request.stateSources??snapshot.stateSources,existingItinerary:snapshot.itinerary,remainingEvents:remaining,lockedEvents:remaining.filter(e=>e.locked),disruption:request,places:[],travelMinutes:{},world,impactAnalysis};
}
