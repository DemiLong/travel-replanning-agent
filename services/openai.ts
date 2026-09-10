import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  ProposedPlanSchema,
  type AgentContext,
  type Violation,
} from "../types";
import { SYSTEM_PROMPT } from "../agents/prompts";
export interface Planner {
  name: string;
  generate(
    context: AgentContext,
    feedback: Violation[],
    attempt: number,
  ): Promise<unknown>;
}
export class OpenAIPlanner implements Planner {
  name: string;
  private client: OpenAI;
  constructor(model = process.env.OPENAI_MODEL) {
    if (!process.env.OPENAI_API_KEY || !model)
      throw new Error(
        "Live planning is not configured. Use Demo mode or configure the server.",
      );
    this.name = model;
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
      timeout: 25000,
    });
  }
  async generate(
    context: AgentContext,
    feedback: Violation[],
    attempt: number,
  ) {
    // All LLM calls are server-side. SDK retries are disabled: the agent owns the bound.
    const result = await this.client.responses.parse({
      model: this.name,
      store: false,
      max_output_tokens: 6000,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            context,
            validationFeedback: feedback,
            attempt,
          }),
        },
      ],
      text: { format: zodTextFormat(ProposedPlanSchema, "travel_plan") },
    });
    if (result.status !== "completed" || !result.output_parsed)
      throw new Error("The planner did not return a complete structured plan.");
    return ProposedPlanSchema.parse(result.output_parsed);
  }
}
