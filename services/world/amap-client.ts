import { createHash } from "node:crypto";

export class WorldServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function requireAmapKey() {
  if (typeof window !== "undefined") throw new Error("SERVER_ONLY");
  const key = process.env.AMAP_API_KEY;
  if (!key?.trim()) throw new WorldServiceError("AMAP_NOT_CONFIGURED", "真实地图服务未启用，请配置服务端 AMAP_API_KEY。");
  return key;
}
const cache = new Map<string, { expires: number; value: Promise<Record<string, unknown>> }>();
let nextRequestAt=0;
export function clearWorldCache() { cache.clear(); }
export type AmapRequestOptions = { paced?: boolean; signal?: AbortSignal };
export async function amapGet(path: string, params: Record<string, string>, ttl = 300000, options: AmapRequestOptions = {}): Promise<Record<string, unknown>> {
  const key = requireAmapKey();
  const query = new URLSearchParams(params); query.sort();
  const cacheKey = createHash("sha256").update(key + path + query.toString()).digest("hex");
  const found = cache.get(cacheKey);
  if (found && found.expires > Date.now()) return found.value;
  const promise = (async () => {
    try {
      if(options.paced!==false){
        const wait=Math.max(0,nextRequestAt-Date.now());
        nextRequestAt=Math.max(Date.now(),nextRequestAt)+400;
        if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
      }
      query.set("key", key); query.set("output", "JSON");
      const timeoutSignal = AbortSignal.timeout(8000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(`https://restapi.amap.com${path}?${query}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error("http");
      const body = await response.json() as Record<string, unknown>;
      if (body.status !== "1") throw new Error("provider");
      return { ...body, _fetchedAt: new Date().toISOString() };
    } catch {
      cache.delete(cacheKey);
      // Never propagate provider URLs, headers, credentials or raw error bodies.
      throw new WorldServiceError("AMAP_UNAVAILABLE", "高德暂时无法提供所需数据，请检查服务权限或稍后重试。");
    }
  })();
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { expires: Date.now() + ttl, value: promise });
  return promise;
}
export const textValue = (x: unknown) => typeof x === "string" ? x : "";
export const objects = (x: unknown): Record<string, unknown>[] => Array.isArray(x) ? x.filter(v=>v && typeof v === "object") : [];
