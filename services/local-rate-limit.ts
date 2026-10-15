import type { ProtectedApiRoute } from "./server-auth";

// This personal app's local development server keeps auth but allows normal
// multi-step planning without the deployed database's five-request allowance.
export const LOCAL_REQUEST_LIMITS = { assist: 20, parse: 30, validate: 60 } as const;
const WINDOW_MS = 60_000;

export function createLocalRateLimiter(now: () => number = Date.now) {
  const counters = new Map<string, { startedAt: number; count: number }>();
  return {
    claim(userId: string, route: ProtectedApiRoute) {
      const time = now();
      const key = `${userId}:${route}`;
      let counter = counters.get(key);
      if (!counter || time >= counter.startedAt + WINDOW_MS) {
        for (const [id, entry] of counters) if (time >= entry.startedAt + WINDOW_MS) counters.delete(id);
        counter = { startedAt: time, count: 0 };
        counters.set(key, counter);
      }
      const limit = LOCAL_REQUEST_LIMITS[route];
      const allowed = counter.count < limit;
      if (allowed) counter.count++;
      return { allowed, remaining: Math.max(0, limit - counter.count), retry_after_seconds: Math.max(1, Math.ceil((counter.startedAt + WINDOW_MS - time) / 1000)), exceeded_scope: allowed ? null : "user" as const };
    },
  };
}
