import { PlaceSchema, type ItineraryEvent, type Place } from "../types";

type FixturePlace = Omit<Place, "latitude" | "longitude"> & {
  latitude?: number;
  longitude?: number;
};

// Offline planning support only. Real mode receives POIs from Amap and never
// uses this catalog as venue truth.
const fixturePlaces: Place[] = [
  {
    id: "museum",
    name: "城市博物馆",
    category: "museum",
    district: "历史街区",
    latitude: 0,
    longitude: 0,
    estimatedCost: 500,
    averageDuration: 90,
    indoorOutdoor: "mixed",
    tags: ["culture", "museums"],
    openingTime: "08:30",
    closingTime: "18:00",
  },
  {
    id: "lunch",
    name: "城市午餐点",
    category: "restaurant",
    district: "城市中心",
    latitude: 0,
    longitude: 0,
    estimatedCost: 250,
    averageDuration: 60,
    indoorOutdoor: "indoor",
    tags: ["food"],
    openingTime: "10:00",
    closingTime: "21:00",
  },
  {
    id: "riverside-gallery",
    name: "河畔文化馆",
    category: "museum",
    district: "河畔区域",
    latitude: 0,
    longitude: 0,
    estimatedCost: 200,
    averageDuration: 90,
    indoorOutdoor: "mixed",
    tags: ["culture"],
    openingTime: "08:00",
    closingTime: "18:00",
  },
  {
    id: "shopping-center",
    name: "室内商业中心",
    category: "shopping mall",
    district: "河畔区域",
    latitude: 0,
    longitude: 0,
    estimatedCost: 300,
    averageDuration: 90,
    indoorOutdoor: "indoor",
    tags: ["shopping", "rain-friendly"],
    openingTime: "10:00",
    closingTime: "22:00",
  },
  {
    id: "dinner",
    name: "预约晚餐",
    category: "restaurant",
    district: "城市中心",
    latitude: 0,
    longitude: 0,
    estimatedCost: 650,
    averageDuration: 90,
    indoorOutdoor: "indoor",
    tags: ["food"],
    openingTime: "17:00",
    closingTime: "22:00",
  },
  {
    id: "massage",
    name: "舒缓休息点",
    category: "rest",
    district: "城市中心",
    latitude: 0,
    longitude: 0,
    estimatedCost: 450,
    averageDuration: 60,
    indoorOutdoor: "indoor",
    tags: ["rest", "relaxed", "rain-friendly"],
    openingTime: "10:00",
    closingTime: "21:00",
  },
  {
    id: "hotel",
    name: "酒店休息",
    category: "rest",
    district: "城市中心",
    latitude: 0,
    longitude: 0,
    estimatedCost: 0,
    averageDuration: 60,
    indoorOutdoor: "indoor",
    tags: ["rest", "relaxed", "rain-friendly"],
    openingTime: "00:00",
    closingTime: "23:59",
  },
  {
    id: "cafe",
    name: "社区咖啡馆",
    category: "cafe",
    district: "城市中心",
    latitude: 0,
    longitude: 0,
    estimatedCost: 160,
    averageDuration: 60,
    indoorOutdoor: "indoor",
    tags: ["coffee", "relaxed", "rain-friendly"],
    openingTime: "08:00",
    closingTime: "20:00",
  },
  {
    id: "history-museum",
    name: "城市历史馆",
    category: "museum",
    district: "历史街区",
    latitude: 0,
    longitude: 0,
    estimatedCost: 200,
    averageDuration: 90,
    indoorOutdoor: "indoor",
    tags: ["museums", "culture"],
    openingTime: "09:00",
    closingTime: "16:00",
  },
  {
    id: "nature-center",
    name: "室内自然馆",
    category: "indoor attraction",
    district: "城市中心",
    latitude: 0,
    longitude: 0,
    estimatedCost: 1200,
    averageDuration: 90,
    indoorOutdoor: "indoor",
    tags: ["nature"],
    openingTime: "10:00",
    closingTime: "20:00",
  },
].map((place) => PlaceSchema.parse(place));

export const districts = [...new Set(fixturePlaces.map((place) => place.district))];

function regionalFallback(destination: string): Place[] {
  const district = destination.trim() ? `${destination} 中心` : "待确认区域";
  const slug = destination.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown";
  const items: FixturePlace[] = [
    {
      id: `${slug}-rest`,
      name: "酒店休息",
      category: "rest",
      district,
      estimatedCost: 0,
      averageDuration: 60,
      indoorOutdoor: "indoor",
      tags: ["rest", "relaxed", "rain-friendly"],
      openingTime: "00:00",
      closingTime: "23:59",
    },
    {
      id: `${slug}-cafe`,
      name: "附近咖啡馆",
      category: "cafe",
      district,
      estimatedCost: 160,
      averageDuration: 60,
      indoorOutdoor: "indoor",
      tags: ["coffee", "food", "relaxed", "rain-friendly"],
      openingTime: "08:00",
      closingTime: "22:00",
    },
    {
      id: `${slug}-indoor`,
      name: "室内文化去处",
      category: "indoor attraction",
      district,
      estimatedCost: 250,
      averageDuration: 75,
      indoorOutdoor: "indoor",
      tags: ["culture", "museums", "rain-friendly"],
      openingTime: "08:00",
      closingTime: "22:00",
    },
  ];
  return items.map((item) =>
    PlaceSchema.parse({ latitude: 0, longitude: 0, ...item }),
  );
}

export function getPlaces(city: string) {
  return city === "待确认城市" || !city.trim()
    ? regionalFallback(city)
    : [...fixturePlaces, ...regionalFallback(city)];
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

// Conservative mock transfer minutes for offline validation; real mode uses Amap.
export function travelMinutes(from: string, to: string) {
  if (from === to) return 15;
  const compactAreas = new Set([
    "历史街区",
    "城市中心",
    "河畔区域",
    "测试区域",
  ]);
  if (compactAreas.has(from) && compactAreas.has(to)) return 30;
  return 45;
}

export function travelMatrix(locations = districts) {
  return Object.fromEntries(
    locations.flatMap((from) =>
      locations.map((to) => [`${from}|${to}`, travelMinutes(from, to)]),
    ),
  );
}
