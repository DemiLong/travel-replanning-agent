import { REQUEST_DEADLINE_MS, ReplanInputSchema, ProposedPlanSchema } from "@/types";
import { validatePlan } from "@/validators";
import { WorldContextService } from "@/services/world/world-context-service";
import { buildRealContext } from "@/agents/real-context-builder";
import { failureEnvelope, failureResponse } from "@/services/api-failure";
import { ServiceFailure } from "@/services/failures";
import { outcomeForFailure, RequestExecution } from "@/services/request-execution";
import { authorizeApiRequest } from "@/services/server-auth";
export async function POST(request: Request) {
  const execution = new RequestExecution({ clientSignal: request.signal, deadlineMs: REQUEST_DEADLINE_MS });
  const headers = { "Cache-Control": "no-store", "X-Trace-Id": execution.traceId };
  try {
    await execution.measure("AUTH", () => authorizeApiRequest(request, "validate", execution.signal));
    const { input, parsed } = await execution.measure("REQUEST", async () => {
      const raw = await request.text();
      if (raw.length > 100000)
        throw new ServiceFailure("INVALID_REQUEST", "REQUEST", { retryable: false, detail: "PAYLOAD_TOO_LARGE" });
      const input = JSON.parse(raw);
      const parsed=ReplanInputSchema.parse(input);
      if(parsed.mode!=="live"||parsed.snapshot.mode!=="user")throw new ServiceFailure("INVALID_REQUEST", "REQUEST", { retryable: false, detail: "LIVE_USER_SNAPSHOT_REQUIRED" });
      return { input, parsed };
    });
    const world=await execution.measure("GROUNDING", () => new WorldContextService().ground(parsed, execution.signal, execution));
    if(world.status!=="ready")throw new ServiceFailure("MAP_PROVIDER_ERROR", "GROUNDING", { retryable: true, provider: "amap", detail: "VALIDATION_WORLD_CONTEXT_UNAVAILABLE" });
    const context = buildRealContext(parsed,world);
    const violations = execution.measureSync("VALIDATOR", () => validatePlan(
        context,
        ProposedPlanSchema.parse(input.plan),
      ));
    const response = Response.json({ ok: !violations.length, violations }, { headers });
    execution.finish({ route: "/api/validate", outcome: violations.length ? "business" : "success", httpStatus: 200, status: violations.length ? "REJECTED" : "VALID" });
    return response;
  } catch (error) {
    const mapped = failureEnvelope(execution.failureFor(error), { traceId: execution.traceId, stage: execution.activeStage });
    const response = failureResponse(mapped.failure, { traceId: execution.traceId, stage: execution.activeStage });
    execution.finish({ route: "/api/validate", outcome: outcomeForFailure(mapped.failure), httpStatus: mapped.httpStatus, status: mapped.body.status, failure: mapped.failure });
    return response;
  } finally {
    execution.dispose();
  }
}
