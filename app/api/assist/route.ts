import { AssistRequestSchema, runAgentAssist } from "@/agents/agent-orchestrator";
import { failureEnvelope, failureResponse } from "@/services/api-failure";
import {
  failureHttpStatus,
  ServiceFailure,
} from "@/services/failures";
import { outcomeForFailure, RequestExecution } from "@/services/request-execution";
import { authorizeApiRequest } from "@/services/server-auth";

export const maxDuration = 35;

export async function POST(request: Request) {
  const execution = new RequestExecution({ clientSignal: request.signal, deadlineMs: 30000 });
  const headers = { "Cache-Control": "no-store", "X-Trace-Id": execution.traceId };

  try {
    await execution.measure("AUTH", () => authorizeApiRequest(request, "assist", execution.signal));
    const input = await execution.measure("REQUEST", async () => {
      const raw = await request.text();
      if (raw.length > 80000) {
        throw new ServiceFailure("INVALID_REQUEST", "REQUEST", {
          retryable: false,
          detail: "PAYLOAD_TOO_LARGE",
        });
      }
      return AssistRequestSchema.parse(JSON.parse(raw));
    });
    const result = await runAgentAssist(input, execution);
    if ("failure" in result) {
      const provider = result.failure.code.startsWith("MODEL_")
        ? "deepseek"
        : result.failure.code.startsWith("MAP_")
          ? "amap"
          : undefined;
      const failure = new ServiceFailure(result.failure.code, result.failure.stage, {
        retryable: result.failure.retryable,
        provider,
      });
      const httpStatus = failureHttpStatus(failure.code);
      const response = Response.json(result, { status: httpStatus, headers });
      execution.finish({ route: "/api/assist", outcome: outcomeForFailure(failure), httpStatus, status: result.status, failure });
      return response;
    }
    const response = Response.json(result, { status: 200, headers });
    execution.finish({ route: "/api/assist", outcome: result.status === "READY" ? "success" : "business", httpStatus: 200, status: result.status });
    return response;
  } catch (error) {
    const mapped = failureEnvelope(execution.failureFor(error), {
      traceId: execution.traceId,
      stage: execution.activeStage,
    });
    const response = failureResponse(mapped.failure, { traceId: execution.traceId, stage: execution.activeStage });
    execution.finish({ route: "/api/assist", outcome: outcomeForFailure(mapped.failure), httpStatus: mapped.httpStatus, status: mapped.body.status, failure: mapped.failure });
    return response;
  } finally {
    execution.dispose();
  }
}
