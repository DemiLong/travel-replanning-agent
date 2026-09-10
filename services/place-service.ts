import { places } from "../data/places";
export const districts = [...new Set(places.map((p) => p.district))];
export function getPlaces(city: string) {
  if (city !== "Bangkok")
    throw new Error("Only Bangkok is available in this demo.");
  return places;
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
export function travelMatrix() {
  return Object.fromEntries(
    districts.flatMap((a) =>
      districts.map((b) => [`${a}|${b}`, travelMinutes(a, b)]),
    ),
  );
}
