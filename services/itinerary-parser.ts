import { getPlaces } from "./place-service";
import { addMinutesWithinDay } from "../lib/time";

export type ParsedItineraryItem = {
  id: string;
  name: string;
  startTime: string;
  endTime: string | null;
  durationMinutes: number | null;
  location: string;
  estimatedCost: number;
  estimatedCostKnown: boolean;
  locked: boolean;
};

const timePattern =
  /(?:^|[，,;；。\n])\s*(\d{1,2})(?:(?::|：)([0-5]\d)|点(?:([0-5]?\d)分?)?)\s*(am|pm)?\s*/gi;

function clock(hourValue: string, minuteValue?: string, meridiem?: string) {
  let hour = Number(hourValue);
  if (meridiem?.toLowerCase() === "pm" && hour < 12) hour += 12;
  if (meridiem?.toLowerCase() === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minuteValue ?? "00"}`;
}

function aliases(name: string) {
  const normalized = name
    .toLowerCase()
    .replace(/[()（）]/g, "")
    .trim();
  return [normalized, normalized.replace(/\bbooked\b/g, "").trim()];
}

export function parseItineraryText(
  text: string,
  destination: string,
  fallbackLocation = "",
): ParsedItineraryItem[] {
  const matches = [...text.matchAll(timePattern)];
  const places = getPlaces(destination);
  return matches
    .map((match, index): ParsedItineraryItem | null => {
      const startTime = clock(match[1], match[2] ?? match[3], match[4]);
      const next = matches[index + 1];
      const raw = text
        .slice((match.index ?? 0) + match[0].length, next?.index)
        .split(
          /[。.!！？]\s*(?=现在|当前|此刻|下雨|晚点|迟到|太累|有点累|希望|请保留)/,
        )[0]
        .replace(/^[\s，,;；：:-]+|[\s，,;；：:-]+$/g, "")
        .trim();
      if (!raw) return null;
      // A second clock expression belongs to another clause or to the current
      // context. Treating the whole tail as one event caused sentences such as
      // “15:00 按摩……现在14点……20点游乐场” to become one fake locked event.
      // The deterministic parser cannot resolve that attachment safely, so it
      // leaves the text for the semantic parser or for explicit user editing.
      if (/\d{1,2}(?:(?::|：)[0-5]\d|点)/.test(raw)) return null;
      if (/[吗么？?]/.test(raw) && raw.length > 40) return null;
      const lower = raw.toLowerCase();
      const comparable = lower
        .replace(/\b(booked|reservation|reserved)\b/g, "")
        .replace(/预约|预订|已订|固定/g, "")
        .trim();
      const matchedPlace = places.find((place) => {
        const names = [
          ...aliases(place.name),
        ].map((value) => value.toLowerCase());
        return names.some(
          (alias) =>
            alias && (comparable.includes(alias) || alias.includes(comparable)),
        );
      });
      const locked = /booked|reservation|reserved|预约|预订|已订|固定/.test(
        lower,
      );
      const duration = /dinner|晚餐/.test(lower)
        ? 90
        : /lunch|午餐|早餐|咖啡/.test(lower)
          ? 60
          : (matchedPlace?.averageDuration ?? 90);
      let endTime: string | null;
      try {
        endTime = addMinutesWithinDay(startTime, duration);
      } catch {
        return null;
      }
      return {
        id: crypto.randomUUID(),
        name:
          matchedPlace?.name ??
          raw.replace(/\b(booked|reservation|reserved)\b/gi, "").trim(),
        startTime,
        endTime,
        durationMinutes: duration,
        location: matchedPlace?.district ?? fallbackLocation,
        estimatedCost: matchedPlace?.estimatedCost ?? 0,
        estimatedCostKnown: Boolean(matchedPlace),
        locked,
      };
    })
    .filter((item): item is ParsedItineraryItem => Boolean(item));
}
