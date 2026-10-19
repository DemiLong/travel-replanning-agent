import type { ReplanningRequest } from "../types";
import type { RealWorldContext, TravelMode } from "../types/world";

const modeNames: Record<TravelMode, string> = { WALKING: "步行", TRANSIT: "公共交通", DRIVING: "打车" };

export function partialRouteMessage(world: RealWorldContext | undefined, request: ReplanningRequest): string | null {
  if (!world) return null;
  const allowed = request.worldOptions?.allowedTravelModes;
  const explicit = request.worldOptions?.travelMode;
  const permitted = (mode: TravelMode) => (!allowed || allowed.includes(mode)) && (!explicit || mode === explicit);
  const hasMissingRoutes = world.routes.some(route => route.status === "unavailable" && permitted(route.travelMode)) ||
    world.missingWorldFacts.some(fact => fact.kind === "world" && fact.field === "routes");
  if (!hasMissingRoutes) return null;
  const modes = (["WALKING", "TRANSIT", "DRIVING"] as const).filter(mode => permitted(mode) &&
    world.routes.some(route => route.travelMode === mode && route.status === "available" && route.durationSeconds !== null));
  if (!modes.length) return "暂未获取到符合你要求的线路，请重试。";
  const partlyAvailable = modes.every(mode => world.routes.some(route => route.travelMode === mode && route.status === "unavailable"));
  return `只获取到${partlyAvailable ? "部分" : ""}${modes.map(mode => modeNames[mode]).join("、")}线路，若还需其他线路，请重试`;
}
