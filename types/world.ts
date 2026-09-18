import { z } from "zod";

export const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  coordinateSystem: z.enum(["WGS84", "GCJ02"]),
});
export type Coordinate = z.infer<typeof CoordinateSchema>;
export const BrowserLocationSchema = CoordinateSchema.extend({
  coordinateSystem: z.literal("WGS84"), accuracy: z.number().nonnegative(),
  capturedAt: z.string().datetime(), source: z.literal("browser_geolocation"),
});
export type BrowserLocation = z.infer<typeof BrowserLocationSchema>;
export const PoiSchema = CoordinateSchema.extend({
  coordinateSystem: z.literal("GCJ02"), poiId: z.string().min(1), name: z.string().min(1),
  address: z.string(), city: z.string(), district: z.string(), adcode: z.string(), type: z.string(),
  source: z.literal("amap"), fetchedAt: z.string().datetime(), status: z.literal("available"),
});
export type WorldPoi = z.infer<typeof PoiSchema>;
export type PlaceResolution = { status: "available" | "ambiguous" | "unavailable"; candidates: WorldPoi[]; message?: string };
export const TravelModeSchema = z.enum(["DRIVING", "WALKING", "TRANSIT"]);
export type TravelMode = z.infer<typeof TravelModeSchema>;
export const RouteEndpointSchema = CoordinateSchema.extend({ id: z.string().min(1), city: z.string() });
export type RouteEndpoint = z.infer<typeof RouteEndpointSchema>;
export const RouteSchema = z.object({
  origin: RouteEndpointSchema, destination: RouteEndpointSchema, travelMode: TravelModeSchema,
  distanceMeters: z.number().nonnegative().nullable(), durationSeconds: z.number().nonnegative().nullable(),
  trafficDurationSeconds: z.number().nonnegative().optional(), fare: z.number().nonnegative().optional(),
  source: z.literal("amap"), fetchedAt: z.string().datetime(), status: z.enum(["available", "unavailable"]),
});
export type WorldRoute = z.infer<typeof RouteSchema>;
export const WeatherSchema = z.object({
  condition:z.string().nullable(),temperature:z.number().nullable(),humidity:z.number().nullable(),
  windDirection:z.string().nullable(),windPower:z.string().nullable(),
  forecast:z.array(z.object({date:z.string(),dayCondition:z.string(),nightCondition:z.string(),dayTemperature:z.number().nullable(),nightTemperature:z.number().nullable()})),
  source:z.literal("amap"),fetchedAt:z.string().datetime(),reportedAt:z.string().nullable(),
  status:z.enum(["available","unavailable","not_requested"]),
});
export type WorldWeather = z.infer<typeof WeatherSchema>;
export const WorldOptionsSchema = z.object({
  travelMode: TravelModeSchema.optional(),
  allowedTravelModes: z.array(TravelModeSchema).min(1).optional(),
  selectedPois: z.record(z.string().min(1)),
});
export const MissingWorldFactSchema = z.object({kind:z.enum(["user","world"]),field:z.string(),message:z.string()});
export const CitySourceSchema = z.enum(["current_location","place_evidence","trip_destination","none"]);
export const ResolutionEvidenceSchema = z.object({
  field:z.string(), query:z.string(), reason:z.string(), poiId:z.string().optional(),
  lookupCity:z.string().optional(), citySource:CitySourceSchema.optional(),
  conflict:z.boolean().optional(), evidenceFields:z.array(z.string()).optional(),
});
export const CityEvidenceSchema = z.object({
  field:z.string().min(1), query:z.string().min(1), city:z.string().min(1), poiId:z.string().min(1),
});
export const CityConflictSchema = z.object({
  source:z.enum(["trip_destination","place_evidence","current_location"]),
  expected:z.string().min(1), actual:z.string().min(1), message:z.string().min(1),
});
export const CityResolutionSchema = z.object({
  city:z.string().nullable(), source:CitySourceSchema,
  evidence:z.array(CityEvidenceSchema), conflicts:z.array(CityConflictSchema),
});
export const RealWorldContextSchema = z.object({
  currentTime:z.object({value:z.string(),date:z.string(),source:z.enum(["user","system"]),confirmedAt:z.string().datetime()}),
  currentLocation:RouteEndpointSchema.extend({coordinateSystem:z.literal("GCJ02"),source:z.enum(["user","browser_geolocation"]),capturedAt:z.string(),accuracy:z.number().optional(),adcode:z.string()}).nullable(),
  resolvedPlaces:z.array(z.object({placeId:z.string(),poi:PoiSchema})),
  alternatives:z.array(PoiSchema),routes:z.array(RouteSchema),weather:WeatherSchema,
  dataFreshness:z.object({groundedAt:z.string().datetime(),routeMaxAgeSeconds:z.number(),locationMaxAgeSeconds:z.number()}),
  missingWorldFacts:z.array(MissingWorldFactSchema),
  ambiguities:z.array(z.object({field:z.string(),label:z.string(),candidates:z.array(PoiSchema)})),
  travelMode:TravelModeSchema.nullable(),
  cityResolution:CityResolutionSchema.optional(),
  resolutionEvidence:z.array(ResolutionEvidenceSchema).optional(),
  status:z.enum(["ready","needs_input","unavailable"]),
});
export type RealWorldContext = z.infer<typeof RealWorldContextSchema>;
