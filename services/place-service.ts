import { places } from "../data/places";
import { PlaceSchema, type ItineraryEvent, type Place } from "../types";
import { thailandDestinationLabels } from "../data/thailand";

export const districts = [...new Set(places.map((p) => p.district))];

function regionalFallback(destination: string): Place[] {
  const district = `${destination} Centre`;
  const cityLabel = thailandDestinationLabels[destination] ?? destination;
  const slug = destination.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return [
    {
      id: `${slug}-rest`,
      name: "酒店休息",
      category: "rest",
      estimatedCost: 0,
      averageDuration: 60,
      indoorOutdoor: "indoor" as const,
      tags: ["rest", "relaxed", "rain-friendly"],
    },
    {
      id: `${slug}-cafe`,
      name: `${cityLabel}附近咖啡馆`,
      category: "cafe",
      estimatedCost: 160,
      averageDuration: 60,
      indoorOutdoor: "indoor" as const,
      tags: ["coffee", "food", "relaxed", "rain-friendly"],
    },
    {
      id: `${slug}-indoor`,
      name: `${cityLabel}室内文化去处`,
      category: "indoor attraction",
      estimatedCost: 250,
      averageDuration: 75,
      indoorOutdoor: "indoor" as const,
      tags: ["culture", "museums", "rain-friendly"],
    },
  ].map((item) =>
    PlaceSchema.parse({
      ...item,
      district,
      latitude: 0,
      longitude: 0,
      openingTime: "08:00",
      closingTime: "22:00",
    }),
  );
}

export function getPlaces(city: string) {
  return city === "Bangkok" ? places : regionalFallback(city);
}

export function itineraryPlaces(events: ItineraryEvent[]): Place[] {
  return events.map((event) =>
    PlaceSchema.parse({
      id: event.placeId,
      name: event.name,
      category: event.category,
      district: event.location,
      latitude: 0,
      longitude: 0,
      openingTime: event.openingTime ?? "00:00",
      closingTime: event.closingTime ?? "23:59",
      estimatedCost: event.estimatedCost,
      indoorOutdoor: event.indoorOutdoor,
      averageDuration: Math.max(
        15,
        Number(event.endTime.slice(0, 2)) * 60 +
          Number(event.endTime.slice(3)) -
          Number(event.startTime.slice(0, 2)) * 60 -
          Number(event.startTime.slice(3)),
      ),
      tags: ["user itinerary"],
    }),
  );
}
// Conservative mock district transfer minutes; independent of any model output.
export function travelMinutes(from: string, to: string) {
  if (from === to) return 15;
  if (
    [from, to].every((d) => ["Old Town", "Riverside", "Chinatown"].includes(d))
  )
    return 30;
  if ([from, to].every((d) => ["Siam", "Silom", "Sukhumvit"].includes(d)))
    return 30;
  return 45;
}
export function travelMatrix(locations = districts) {
  return Object.fromEntries(
    locations.flatMap((a) =>
      locations.map((b) => [`${a}|${b}`, travelMinutes(a, b)]),
    ),
  );
}
