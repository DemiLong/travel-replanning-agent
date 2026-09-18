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
  constructor(
    model = process.env.DEEPSEEK_MODEL,
    baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  ) {
    if (!process.env.DEEPSEEK_API_KEY || !model)
      throw new Error("实时规划尚未配置，请使用模拟模式或配置服务端。");
    this.name = model;
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL,
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
      throw new Error("规划器没有返回完整的结构化方案。");
    return ProposedPlanSchema.parse(result.output_parsed);
  }
}
