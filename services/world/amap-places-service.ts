import { PoiSchema, type Coordinate, type PlaceResolution, type WorldPoi } from "../../types/world";
import { amapGet, objects, textValue } from "./amap-client";
import { CoordinateService } from "./coordinate-service";
export const MAX_PLACE_CANDIDATES = 5;
export class AmapPlacesService {
  constructor(private coordinates = new CoordinateService()) {}
  private normalize(data: Record<string, unknown>): PlaceResolution {
    const candidates = objects(data.pois).flatMap(p => {
      const location = textValue(p.location).split(",");
      if (location.length !== 2 || location.some(x=>!x.trim())) return [];
      const parsed = PoiSchema.safeParse({ poiId: p.id, name: p.name, address: textValue(p.address), city: textValue(p.cityname), district: textValue(p.adname), adcode: textValue(p.adcode), longitude: Number(location[0]), latitude: Number(location[1]), coordinateSystem: "GCJ02", type: textValue(p.type), source: "amap", fetchedAt: textValue(data._fetchedAt), status: "available" });
      return parsed.success ? [parsed.data] : [];
    }).filter((p,i,a)=>a.findIndex(q=>q.poiId===p.poiId)===i).slice(0, MAX_PLACE_CANDIDATES);
    return { status: candidates.length === 1 ? "available" : candidates.length ? "ambiguous" : "unavailable", candidates };
  }
  async search(keywords: string, city = "", signal?: AbortSignal): Promise<PlaceResolution> {
    const knownCity = city.trim() && city !== "待确认城市";
    return this.normalize(await amapGet("/v3/place/text", { keywords, ...(knownCity ? {city, citylimit:"true"} : {}), offset: String(MAX_PLACE_CANDIDATES), page: "1", extensions: "base" }, 300000, { signal }));
  }
  async searchUnbounded(keywords: string, signal?: AbortSignal): Promise<PlaceResolution> {
    return this.normalize(await amapGet("/v3/place/text", { keywords, offset: String(MAX_PLACE_CANDIDATES), page: "1", extensions: "base" }, 300000, {paced:false, signal}));
  }
  async around(keywords: string, location: Coordinate, signal?: AbortSignal): Promise<PlaceResolution> {
    return this.normalize(await amapGet("/v3/place/around", { keywords, location: await this.coordinates.format(location, signal), radius: "3000", offset: String(MAX_PLACE_CANDIDATES), page: "1", extensions: "base" }, 300000, { signal }));
  }
  async detail(poiId: string, signal?: AbortSignal): Promise<WorldPoi | null> {
    const result = this.normalize(await amapGet("/v3/place/detail", { id: poiId }, 300000, { signal }));
    return result.candidates.find(p=>p.poiId===poiId) ?? null;
  }
  async reverse(location: Coordinate, signal?: AbortSignal): Promise<{ city: string; adcode: string; address: string }> {
    const body = await amapGet("/v3/geocode/regeo", { location: await this.coordinates.format(location, signal), extensions: "base" }, 300000, { signal });
    const regeo = body.regeocode as Record<string, unknown> | undefined;
    const component = regeo?.addressComponent as Record<string, unknown> | undefined;
    return { city: textValue(component?.city) || textValue(component?.province), adcode: textValue(component?.adcode), address: textValue(regeo?.formatted_address) };
  }
}
