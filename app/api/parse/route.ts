import { z } from "zod";
import { OpenAISemanticParser } from "@/services/semantic-parser";
import { SnapshotSchema, reasons } from "@/types";
import { failureEnvelope, failureResponse } from "@/services/api-failure";
import { ServiceFailure } from "@/services/failures";
import { outcomeForFailure, RequestExecution } from "@/services/request-execution";
import { authorizeApiRequest } from "@/services/server-auth";

export const maxDuration = 12;

const ParseRequestSchema = z.object({
  snapshot: SnapshotSchema,
  rawText: z.string().trim().min(1).max(4000),
  hint: z.enum(reasons).optional(),
});

export async function POST(request: Request) {
  const execution = new RequestExecution({ clientSignal: request.signal, deadlineMs: null });
  const headers = { "Cache-Control": "no-store", "X-Trace-Id": execution.traceId };
  try {
    await execution.measure("AUTH", () => authorizeApiRequest(request, "parse", execution.signal));
    const input = await execution.measure("REQUEST", async () => {
      if (Number(request.headers.get("content-length") ?? 0) > 50000) {
        throw new ServiceFailure("INVALID_REQUEST", "REQUEST", { retryable: false, detail: "PAYLOAD_TOO_LARGE" });
      }
      const raw = await request.text();
      if (raw.length > 50000) throw new ServiceFailure("INVALID_REQUEST", "REQUEST", { retryable: false, detail: "PAYLOAD_TOO_LARGE" });
      let decoded:unknown;
      try{decoded=JSON.parse(raw);}catch(error){throw new ServiceFailure("INVALID_REQUEST", "REQUEST", { retryable: false, cause: error });}
      const input = ParseRequestSchema.safeParse(decoded);
      if (!input.success) throw new ServiceFailure("INVALID_REQUEST", "REQUEST", { retryable: false, cause: input.error });
      if(input.data.snapshot.mode!=="user")throw new ServiceFailure("INVALID_REQUEST", "REQUEST", { retryable: false, detail: "DEMO_CONTEXT_REJECTED" });
      return input.data;
    });
    const parser = new OpenAISemanticParser();
    const parsed = await execution.measure("PARSER", () => parser.parse(input.snapshot, input.rawText, input.hint, execution.signal, undefined, execution));
    const response = Response.json(parsed, { headers });
    execution.finish({ route: "/api/parse", outcome: "success", httpStatus: 200, status: "PARSED" });
    return response;
  } catch (error) {
    const mapped = failureEnvelope(execution.failureFor(error), { traceId: execution.traceId, stage: execution.activeStage });
    const response = failureResponse(mapped.failure, { traceId: execution.traceId, stage: execution.activeStage });
    execution.finish({ route: "/api/parse", outcome: outcomeForFailure(mapped.failure), httpStatus: mapped.httpStatus, status: mapped.body.status, failure: mapped.failure });
    return response;
  } finally {
    execution.dispose();
  }
}
