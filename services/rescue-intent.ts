import { getPlaces } from "./place-service";
import type { ReplanningRequest, Snapshot, TripState } from "../types";

const contains = (text: string, words: string[]) =>
  words.some((word) => text.includes(word));

function readCurrentTime(text: string, fallback: string) {
  const match = text.match(
    /(?:现在|当前|此刻|now|currently)\s*(?:是|为|已经|已|都|at)?\s*(\d{1,2})(?:(?::|：)([0-5]\d)|点(?:([0-5]?\d)分?)?)?\s*(am|pm)?/i,
  );
  if (!match) return fallback;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? match[3] ?? "00");
  const meridiem = match[4]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function inferRescueRequest(
  snapshot: Snapshot,
  freeText: string,
  hint?: ReplanningRequest["reason"],
  baseState: TripState = snapshot.state,
): ReplanningRequest {
  const text = freeText.trim();
  const lower = text.toLowerCase();
  const reason =
    hint ??
    (contains(lower, ["rain", "raining", "storm", "下雨", "暴雨"])
      ? "weather"
      : contains(lower, ["late", "delay", "delayed", "迟到", "晚点"])
        ? "late"
        : contains(lower, ["tired", "exhausted", "疲惫", "累"])
          ? "tired"
          : contains(lower, ["closed", "shut", "关门", "关闭"])
            ? "closed"
            : contains(lower, ["优化路线", "优化行程", "帮我优化", "optimize"])
              ? "optimize"
              : "other");
  // Only text the user actually supplied may alter the current state.
  const currentState = { ...baseState };
  if (contains(lower, ["rain", "raining", "storm", "下雨", "暴雨"]))
    currentState.weather = "rain";
  else if (contains(lower, ["hot", "heat", "很热", "炎热"]))
    currentState.weather = "hot";
  else if (contains(lower, ["sunny", "clear", "晴天"]))
    currentState.weather = "sunny";
  if (contains(lower, ["tired", "exhausted", "疲惫", "累", "没力气"]))
    currentState.energyLevel = "low";
  else if (contains(lower, ["energetic", "refreshed", "有精神"]))
    currentState.energyLevel = "high";
  currentState.currentTime = readCurrentTime(text, currentState.currentTime);

  const places = [
    ...getPlaces(snapshot.trip.destination).map((place) => place.district),
    ...snapshot.itinerary.map((event) => event.location),
    "城市中心",
    "历史街区",
    "河畔区域",
    "测试区域",
  ];
  const location =
    [...new Set(places)]
      .sort((a, b) => b.length - a.length)
      .find((candidate) => lower.includes(candidate.toLowerCase()));
  if (location) currentState.currentLocation = location;

  const closedPlaceIds =
    reason === "closed"
      ? snapshot.itinerary
          .filter(
            (event) =>
              lower.includes(event.name.toLowerCase()) ||
              lower.includes(event.location.toLowerCase()),
          )
          .map((event) => event.placeId)
      : [];
  return {
    reason,
    freeText: text,
    currentState,
    closedPlaceIds,
    variation: 0,
  };
}
