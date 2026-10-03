import { RouteEndpointSchema, RouteSchema, type RouteEndpoint, type TravelMode, type WorldRoute } from "../../types/world";
import { amapGet, objects, requireAmapKey } from "./amap-client";
import { CoordinateService } from "./coordinate-service";
import { ServiceFailure } from "../failures";
import type { RequestExecution } from "../request-execution";
export const MAX_ROUTE_PAIRS = 40;
export const routeKey = (a: RouteEndpoint, b: RouteEndpoint, mode: TravelMode) => `${a.id}:${a.longitude},${a.latitude}:${a.coordinateSystem}>${b.id}:${b.longitude},${b.latitude}:${b.coordinateSystem}:${mode}`;
const numeric = (value: unknown): number | null => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export class AmapRoutesService {
  constructor(private coordinates = new CoordinateService()) {}
  async route(origin: RouteEndpoint, destination: RouteEndpoint, travelMode: TravelMode, signal?: AbortSignal, execution?: RequestExecution): Promise<WorldRoute> {
    requireAmapKey();
    origin = { ...RouteEndpointSchema.parse(origin), ...await this.coordinates.toGCJ02(origin, signal, execution) };
    destination = { ...RouteEndpointSchema.parse(destination), ...await this.coordinates.toGCJ02(destination, signal, execution) };
    const base = { origin, destination, travelMode, source: "amap" as const, fetchedAt: new Date().toISOString() };
    try {
      const path = travelMode === "DRIVING" ? "/v3/direction/driving" : travelMode === "WALKING" ? "/v3/direction/walking" : "/v3/direction/transit/integrated";
      const body = await amapGet(path, { origin: await this.coordinates.format(origin, signal, execution), destination: await this.coordinates.format(destination, signal, execution), ...(travelMode === "TRANSIT" ? { city: origin.city, cityd: destination.city, strategy:"0", extensions:"base" } : { extensions:"base" }) }, 120000, { signal, execution });
      const route = body.route as Record<string,unknown> | undefined;
      const choices = objects(travelMode === "TRANSIT" ? route?.transits : route?.paths);
      const choice = choices.find(p=>numeric(p.duration)!==null && numeric(p.distance)!==null);
      if (!choice) throw new Error("NO_ROUTE");
      return RouteSchema.parse({ ...base, fetchedAt: body._fetchedAt, status:"available", distanceMeters:numeric(choice.distance), durationSeconds:numeric(choice.duration), ...(numeric(choice.cost)!==null ? {fare:numeric(choice.cost)} : {}) });
    } catch (error) {
      if (error instanceof ServiceFailure) throw error;
      return { ...base, status:"unavailable", distanceMeters:null, durationSeconds:null };
    }
  }
  async batch(pairs: Array<{origin:RouteEndpoint;destination:RouteEndpoint}>, mode: TravelMode, signal?: AbortSignal, execution?: RequestExecution): Promise<WorldRoute[]> {
    const unique = [...new Map(pairs.map(p=>[routeKey(p.origin,p.destination,mode),p])).values()];
    if (unique.length > MAX_ROUTE_PAIRS) throw new Error("路线组合过多，请减少待比较地点。");
    const output: WorldRoute[] = [];
    // Three concurrent requests at most; amapGet also deduplicates in-flight calls.
    for (let i=0;i<unique.length;i+=3) output.push(...await Promise.all(unique.slice(i,i+3).map(p=>this.route(p.origin,p.destination,mode,signal,execution))));
    return output;
  }
}
