"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SnapshotSchema, type Snapshot, type AgentResult } from "../types";
import { demo } from "../data/demo";
type Config = {
  supabaseUrl: string;
  supabaseKey: string;
  liveAvailable: boolean;
};
let configPromise: Promise<Config> | undefined;
let client: SupabaseClient | null = null;
export function getConfig() {
  return (configPromise ??= fetch("/api/config")
    .then((r) => {
      if (!r.ok) throw new Error("Could not load app settings.");
      return r.json() as Promise<Config>;
    })
    .catch((e) => {
      configPromise = undefined;
      throw e;
    }));
}
// Share concurrent initialization so two mounted views cannot create two guests.
let sessionInFlight: ReturnType<typeof resolveSession> | undefined;
function session() {
  return (sessionInFlight ??= resolveSession().finally(() => {
    sessionInFlight = undefined;
  }));
}
async function resolveSession() {
  const config = await getConfig();
  if (!config.supabaseUrl && !config.supabaseKey) return null;
  if (!config.supabaseUrl || !config.supabaseKey)
    throw new Error("Cloud storage is not fully configured.");
  client ??= createClient(config.supabaseUrl, config.supabaseKey);
  const {
    data: { session },
  } = await client.auth.getSession();
  if (session)
    return { client, userId: session.user.id, token: session.access_token };
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.session)
    throw new Error(
      "Could not start a private guest session. Please try again.",
    );
  return {
    client,
    userId: data.session.user.id,
    token: data.session.access_token,
  };
}
export function localTrip(): Snapshot {
  const raw = localStorage.getItem("travel-snapshot");
  return raw ? SnapshotSchema.parse(JSON.parse(raw)) : structuredClone(demo);
}
export async function loadTrip() {
  const auth = await session();
  if (!auth) return localTrip();
  const { data, error } = await auth.client
    .from("travel_snapshots")
    .select("snapshot")
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (error) throw new Error("Could not load your saved trip. Please retry.");
  const snapshot = data ? SnapshotSchema.parse(data.snapshot) : localTrip();
  if (data) localStorage.setItem("travel-snapshot", JSON.stringify(snapshot));
  return snapshot;
}
export async function saveTrip(value: Snapshot, expectedRevision?: number) {
  const snapshot = SnapshotSchema.parse(value);
  const auth = await session();
  if (auth) {
    // Database RPC uses a row lock and revision comparison to prevent stale acceptance.
    const { error } = await auth.client.rpc("save_travel_snapshot", {
      new_snapshot: snapshot,
      expected_revision: expectedRevision ?? null,
    });
    if (error)
      throw new Error(
        error.message.includes("stale")
          ? "Your trip changed in another tab. Reload before saving."
          : "Cloud save failed. Your existing trip has been kept; please retry.",
      );
  } else if (
    expectedRevision !== undefined &&
    localTrip().revision !== expectedRevision
  )
    throw new Error("Your trip changed in another tab. Reload before saving.");
  localStorage.setItem("travel-snapshot", JSON.stringify(snapshot));
  return snapshot;
}
export async function requestHeaders() {
  const auth = await session();
  return {
    "Content-Type": "application/json",
    ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
  };
}
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
export async function logEvent(
  name: AnalyticsName,
  properties: Record<string, unknown> = {},
  id = crypto.randomUUID(),
) {
  const item: AnalyticsEvent = {
    id,
    name,
    created_at: new Date().toISOString(),
    properties,
  };
  try {
    const list: AnalyticsEvent[] = JSON.parse(
      localStorage.getItem("travel-analytics") ?? "[]",
    );
    if (!list.some((e) => e.id === id)) {
      list.push(item);
      localStorage.setItem(
        "travel-analytics",
        JSON.stringify(list.slice(-1000)),
      );
    }
    const auth = await session();
    if (auth) {
      const { error } = await auth.client
        .from("travel_analytics")
        .upsert(
          { ...item, user_id: auth.userId },
          { onConflict: "id", ignoreDuplicates: true },
        );
      if (error) return false;
    }
    return true;
  } catch {
    return false;
  }
}
export async function recordResult(result: AgentResult) {
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
        { ...properties, codes: attempt.violations.map((v) => v.code) },
        `${result.id}-failure-${attempt.attempt}`,
      );
  }
  if (result.ok)
    await logEvent(
      "replan_generated",
      { ...properties, regenerationCount: result.attempts.length - 1 },
      `${result.id}-generated`,
    );
}
