import { CoordinateSchema, type Coordinate } from "../../types/world";
import { amapGet, textValue, WorldServiceError } from "./amap-client";
import type { RequestExecution } from "../request-execution";

export class CoordinateService {
  async toGCJ02(input: Coordinate, signal?: AbortSignal, execution?: RequestExecution): Promise<Coordinate & { coordinateSystem: "GCJ02" }> {
    const point = CoordinateSchema.parse(input);
    if (point.coordinateSystem === "GCJ02") return { ...point, coordinateSystem: "GCJ02" };
    // Use the provider's official gps conversion, never relabel WGS84 coordinates.
    const data = await amapGet("/v3/assistant/coordinate/convert", {
      locations: `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`, coordsys: "gps",
    }, 86400000, { signal, execution });
    const values = textValue(data.locations).split(",");
    if (values.length !== 2 || values.some(x=>!x.trim())) throw new WorldServiceError("MAP_INVALID_RESPONSE", "coordinate-conversion");
    return CoordinateSchema.extend({}).parse({ longitude: Number(values[0]), latitude: Number(values[1]), coordinateSystem: "GCJ02" }) as Coordinate & {coordinateSystem:"GCJ02"};
  }
  async format(input: Coordinate, signal?: AbortSignal, execution?: RequestExecution) {
    const point = await this.toGCJ02(input, signal, execution);
    return `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`;
  }
}
