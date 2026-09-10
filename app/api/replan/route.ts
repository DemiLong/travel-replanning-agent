import { ReplanInputSchema } from "@/types";
import { replan } from "@/agents/replanning-agent";
import { DemoPlanner } from "@/agents/demo-planner";
import { OpenAIPlanner } from "@/services/openai";
import { authenticatePlanner } from "@/services/server-auth";
export const maxDuration = 90;
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 80000)
      return Response.json({ error: "Request is too large." }, { status: 413 });
    const raw = await request.text();
    if (raw.length > 80000)
      return Response.json({ error: "Request is too large." }, { status: 413 });
    const parsed = ReplanInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success)
      return Response.json(
        {
          error:
            "Some trip details are missing or invalid. Review your time, dates and budget.",
        },
        { status: 400 },
      );
    const { mode } = parsed.data;
    if (
      mode === "live" &&
      (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)
    )
      return Response.json(
        { error: "Live planning is not configured. Please use Demo mode." },
        { status: 503 },
      );
    if (mode === "live") {
      try {
        await authenticatePlanner(request);
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : "Guest session required." },
          { status: 429 },
        );
      }
    }
    const result = await replan(
      parsed.data,
      mode === "live" ? new OpenAIPlanner() : new DemoPlanner(),
      mode,
    );
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof SyntaxError
            ? "Invalid request."
            : error instanceof Error &&
                /date|district|Duplicate|closed place/.test(error.message)
              ? error.message
              : "We couldn’t replan right now. Check your trip details and try again.",
      },
      { status: 400 },
    );
  }
}
