import { createHash } from "node:crypto";
import { requestCancelled, ServiceFailure } from "../failures";
import type { RequestExecution } from "../request-execution";
import { MAP_REQUEST_TIMEOUT_MS } from "../../types/protocol";

const TRANSIENT_PROVIDER_CODES = new Set(["10014", "10015", "10016", "10019", "10020", "10021", "10029"]);
const ACCOUNT_FAILURE_CODES = new Set(["10001", "10005", "10006", "10007", "10008", "10009", "10013", "10026"]);

/** Only a failed lookup may be omitted; cancellation, deadlines and account errors must propagate. */
export function canUsePartialWorld(error: unknown): error is WorldServiceError {
  return error instanceof WorldServiceError && error.code !== "MAP_NOT_CONFIGURED" &&
    !(error.code === "MAP_PROVIDER_ERROR" && ACCOUNT_FAILURE_CODES.has(error.detail ?? "")) &&
    !(error.code === "MAP_HTTP_ERROR" && ["401", "403"].includes(error.detail ?? ""));
}

export class WorldServiceError extends ServiceFailure {
  constructor(
    code: "MAP_NOT_CONFIGURED" | "MAP_TIMEOUT" | "MAP_NETWORK_ERROR" | "MAP_HTTP_ERROR" | "MAP_PROVIDER_ERROR" | "MAP_INVALID_RESPONSE",
    detail?: string,
    cause?: unknown,
  ) {
    const retryable = code === "MAP_NETWORK_ERROR" || code === "MAP_TIMEOUT" ||
      code === "MAP_HTTP_ERROR" && ["429", "500", "502", "503", "504"].includes(detail ?? "") ||
      code === "MAP_PROVIDER_ERROR" && TRANSIENT_PROVIDER_CODES.has(detail ?? "");
    super(code, "GROUNDING", { retryable, provider: "amap", detail, cause });
    this.name = "WorldServiceError";
  }
}
export function requireAmapKey() {
  if (typeof window !== "undefined") throw new Error("SERVER_ONLY");
  const key = process.env.AMAP_API_KEY;
  if (!key?.trim()) throw new WorldServiceError("MAP_NOT_CONFIGURED");
  return key;
}
const cache = new Map<string, { expires: number; value: Record<string, unknown> }>();
type InFlightEntry = {
  promise: Promise<Record<string, unknown>>;
  controller: AbortController;
  consumers: Map<symbol, RequestExecution | undefined>;
  settled: boolean;
  networkStartedAt?: number;
};
const inFlight = new Map<string, InFlightEntry>();
let lastRequestStartedAt=0;
let cooldownUntil=0;
export function amapRequestIntervalMs() {
  const configured = Number(process.env.AMAP_REQUEST_INTERVAL_MS);
  return Number.isInteger(configured) && configured > 0 && configured <= 60_000 ? configured : 500;
}
export function clearWorldCache() {
  cache.clear();
  for (const entry of inFlight.values()) entry.controller.abort(requestCancelled("GROUNDING"));
  inFlight.clear();
  lastRequestStartedAt=0;
  cooldownUntil=0;
}
export type AmapRequestOptions = { signal?: AbortSignal; execution?: RequestExecution; timeoutMs?: number };
function cancellationReason(signal?: AbortSignal) {
  return signal?.reason instanceof ServiceFailure ? signal.reason : requestCancelled("GROUNDING", signal?.reason);
}
function cancellableDelay(milliseconds: number, signal?: AbortSignal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(cancellationReason(signal));
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
async function waitForPacing(signal: AbortSignal) {
  while(true){
    if(signal.aborted)throw cancellationReason(signal);
    const wait=Math.max(0,Math.max(lastRequestStartedAt+amapRequestIntervalMs(),cooldownUntil)-Date.now());
    if(!wait){lastRequestStartedAt=Date.now();return;}
    await cancellableDelay(wait,signal);
  }
}
function awaitEntry(entry: InFlightEntry, signal?: AbortSignal, execution?: RequestExecution) {
  if(signal?.aborted)return Promise.reject(cancellationReason(signal));
  const token=Symbol("amap-consumer");
  const joinedAt=performance.now();
  entry.consumers.set(token,execution);
  return new Promise<Record<string,unknown>>((resolve,reject)=>{
    let finished=false;
    const complete=(callback:(value:never)=>void,value:unknown)=>{
      if(finished)return;
      finished=true;
      const endedAt=performance.now();
      const networkStartedAt=entry.networkStartedAt;
      execution?.recordProvider("amap",networkStartedAt===undefined
        ? {queueWaitMs:endedAt-joinedAt}
        : {
            queueWaitMs:Math.max(0,Math.min(endedAt,networkStartedAt)-joinedAt),
            networkMs:Math.max(0,endedAt-Math.max(joinedAt,networkStartedAt)),
          });
      signal?.removeEventListener("abort",abort);
      entry.consumers.delete(token);
      if(!entry.settled&&!entry.consumers.size)entry.controller.abort(requestCancelled("GROUNDING"));
      callback(value as never);
    };
    const abort=()=>complete(reject,cancellationReason(signal));
    signal?.addEventListener("abort",abort,{once:true});
    entry.promise.then(value=>complete(resolve,value),error=>complete(reject,error));
  });
}
export async function amapGet(path: string, params: Record<string, string>, ttl = 300000, options: AmapRequestOptions = {}): Promise<Record<string, unknown>> {
  if(options.signal?.aborted)throw cancellationReason(options.signal);
  options.execution?.recordProvider("amap",{requestCount:1});
  const key = requireAmapKey();
  const query = new URLSearchParams(params); query.sort();
  const cacheKey = createHash("sha256").update(key + path + query.toString()).digest("hex");
  const found = cache.get(cacheKey);
  if (found && found.expires > Date.now()) {
    options.execution?.recordProvider("amap",{cacheHitCount:1});
    return found.value;
  }
  if(found)cache.delete(cacheKey);
  const existing=inFlight.get(cacheKey);
  if(existing&&!existing.controller.signal.aborted){
    options.execution?.recordProvider("amap",{cacheHitCount:1});
    return awaitEntry(existing,options.signal,options.execution);
  }
  const entry:InFlightEntry={promise:Promise.resolve({}),controller:new AbortController(),consumers:new Map(),settled:false};
  entry.promise = (async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        // Pacing belongs to the overall request deadline, not network time.
        await waitForPacing(entry.controller.signal);
        if (entry.controller.signal.aborted) throw cancellationReason(entry.controller.signal);
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? MAP_REQUEST_TIMEOUT_MS);
        const transportSignal = AbortSignal.any([entry.controller.signal, timeoutSignal]);
        let retryDelayMs = 200;
        try {
          query.set("key", key); query.set("output", "JSON");
          entry.networkStartedAt ??= performance.now();
          for (const execution of new Set(entry.consumers.values())) execution?.recordProvider("amap", { outboundRequestCount: 1, retryCount: attempt > 0 ? 1 : 0 });
          if (attempt > 0) for (const execution of new Set(entry.consumers.values())) execution?.recordProvider("amap", { requestCount: 1 });
          const response = await fetch(`https://restapi.amap.com${path}?${query}`, { cache: "no-store", signal: transportSignal });
          if (!response.ok) {
            if (response.status === 429) {
              const retryAfter = response.headers.get("Retry-After");
              const seconds = retryAfter === null ? NaN : Number(retryAfter);
              const date = retryAfter === null ? NaN : Date.parse(retryAfter);
              retryDelayMs = Math.max(1_000, Number.isFinite(seconds) ? seconds * 1_000 : Number.isFinite(date) ? date - Date.now() : 0);
            }
            throw new WorldServiceError("MAP_HTTP_ERROR", String(response.status));
          }
          let body: Record<string, unknown>;
          try { body = await response.json() as Record<string, unknown>; }
          catch (error) {
            if (transportSignal.aborted) throw error;
            throw new WorldServiceError("MAP_INVALID_RESPONSE", undefined, error);
          }
          if (body.status !== "1") {
            const providerCode = String(body.infocode ?? "unknown");
            throw new WorldServiceError("MAP_PROVIDER_ERROR", /^\d{1,8}$/.test(providerCode) ? providerCode : "unknown");
          }
          const value = { ...body, _fetchedAt: new Date().toISOString() };
          if (cache.size >= 500) cache.delete(cache.keys().next().value!);
          cache.set(cacheKey, { expires: Date.now() + ttl, value });
          return value;
        } catch (error) {
          if (entry.controller.signal.aborted) throw cancellationReason(entry.controller.signal);
          const failure = timeoutSignal.aborted ? new WorldServiceError("MAP_TIMEOUT", undefined, error)
            : error instanceof ServiceFailure ? error
            : error instanceof TypeError ? new WorldServiceError("MAP_NETWORK_ERROR", undefined, error)
            : new ServiceFailure("INTERNAL_ERROR", "GROUNDING", { retryable: true, cause: error });
          for (const execution of new Set(entry.consumers.values())) {
            execution?.recordProviderFailure("amap", failure, path, attempt + 1);
          }
          if (failure.code === "MAP_PROVIDER_ERROR" && TRANSIENT_PROVIDER_CODES.has(failure.detail ?? "")) retryDelayMs = 1_000;
          if (retryDelayMs >= 1_000) {
            // Slow all queued calls after throttling, not just this request's retry.
            cooldownUntil = Math.max(cooldownUntil, Date.now() + retryDelayMs + Math.floor(Math.random() * 200));
          }
          if (attempt >= 1 || !(failure instanceof WorldServiceError && failure.retryable)) throw failure;
          await cancellableDelay(retryDelayMs, entry.controller.signal);
        }
      }
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    } finally {
      entry.settled = true;
      if (inFlight.get(cacheKey) === entry) inFlight.delete(cacheKey);
    }
  })();
  inFlight.set(cacheKey,entry);
  return awaitEntry(entry,options.signal,options.execution);
}
export const textValue = (x: unknown) => typeof x === "string" ? x : "";
export const objects = (x: unknown): Record<string, unknown>[] => Array.isArray(x) ? x.filter(v=>v && typeof v === "object") : [];
