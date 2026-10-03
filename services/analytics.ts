"use client";

import type { AgentResult } from "../types";
import type { BrowserSessionRepository } from "./browser-session-repository";

const analyticsKey = "travel-analytics";

export type AnalyticsName =
  | "trip_created"
  | "replan_started"
  | "replan_generated"
  | "replan_validation_failed"
  | "replan_regenerated"
  | "replan_accepted"
  | "replan_rejected"
  | "preference_saved";

export type AnalyticsEvent = {
  id: string;
  name: AnalyticsName;
  created_at: string;
  properties: Record<string, unknown>;
};

export interface AnalyticsService {
  logEvent(
    name: AnalyticsName,
    properties?: Record<string, unknown>,
    id?: string,
  ): Promise<boolean>;
  recordResult(result: AgentResult): Promise<void>;
}

export function createAnalyticsService(
  repository: BrowserSessionRepository,
): AnalyticsService {
  const logEvent: AnalyticsService["logEvent"] = async (
    name,
    properties = {},
    id = crypto.randomUUID(),
  ) => {
    const item: AnalyticsEvent = {
      id,
      name,
      created_at: new Date().toISOString(),
      properties,
    };
    try {
      const list: AnalyticsEvent[] = JSON.parse(
        repository.readRaw(analyticsKey) ?? "[]",
      );
      if (!list.some((event) => event.id === id)) {
        list.push(item);
        repository.writeRaw(analyticsKey, JSON.stringify(list.slice(-1000)));
      }
      return true;
    } catch {
      return false;
    }
  };

  const recordResult = async (result: AgentResult) => {
    const properties = {
      planId: result.id,
      mode: result.mode,
      model: result.model,
    };
    for (const attempt of result.attempts) {
      if (attempt.attempt > 1)
        await logEvent(
          "replan_regenerated",
          { ...properties, regenerationCount: attempt.attempt - 1 },
          `${result.id}-retry-${attempt.attempt}`,
        );
      if (attempt.violations.length)
        await logEvent(
          "replan_validation_failed",
          {
            ...properties,
            codes: attempt.violations.map((violation) => violation.code),
          },
          `${result.id}-failure-${attempt.attempt}`,
        );
    }
    if (result.ok)
      await logEvent(
        "replan_generated",
        { ...properties, regenerationCount: result.attempts.length - 1 },
        `${result.id}-generated`,
      );
  };

  return { logEvent, recordResult };
}
