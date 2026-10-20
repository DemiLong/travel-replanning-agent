import type { ActivityFact, Snapshot } from "../types";
import { genericLocation, locationQuery } from "./world/context-resolution";

// These are activity words, not a catalogue of venues. A recovered phrase is
// only a search query; the world service still has to verify the actual place.
const leadingAction = /^(?:前往|参观|游览|回到|返回|去|到|逛|回|在|吃)\s*/u;
const trailingAction = /(?:办理入住|办理退房|入住|退房|购物|吃饭|吃(?:早饭|午饭|晚饭|早餐|午餐|晚餐)|用餐|散步|游览|参观|集合|看电影)$/u;
const multipleDestinations = /[、，,；;]|或者|还是|或是|以及|然后|再去|(?:馆|园|中心|店|站|码头|广场|寺|故居|滩)(?:和|与|或)/u;
const unspecifiedActivity = /^(?:吃)?(?:早饭|午饭|晚饭|早餐|午餐|晚餐|饭|用餐|购物|买东西|逛街|散步|休息|看电影|电影|集合|入住|退房|商场|公园|咖啡馆|咖啡店|饭店|车站|机场|码头|广场|地铁站)$/u;

function queryPhrase(value: string, stripLeading = true) {
  const phrase = value.trim();
  return (stripLeading ? phrase.replace(leadingAction, "") : phrase).replace(trailingAction, "").trim();
}

function usablePhrase(value: string) {
  const withoutAction = value.replace(leadingAction, "");
  return value.length >= 2 && value.length <= 100 &&
    !genericLocation(value) && !unspecifiedActivity.test(value) &&
    !genericLocation(withoutAction) && !unspecifiedActivity.test(withoutAction) &&
    !multipleDestinations.test(value) &&
    !/^(?:附近|周边|随便|找[一个家]?|某[个家]?|另一[个家]?|这里|那里)/u.test(value) &&
    !/[。！？!?]|\d{1,2}[:：]\d{2}|\d+点/u.test(value);
}

export function recoverActivityLocation(fact: ActivityFact, rawText: string, snapshot: Snapshot): ActivityFact {
  // An explicit edit to a saved activity must not be overwritten from stale
  // prose. Existing locations (including follow-up answers) always take priority.
  if (fact.placeQuery?.trim() || fact.origin !== "message" || fact.progress === "completed") return fact;
  const source = fact.sourceText?.trim();
  if (!source || !rawText.includes(source) || /或者|还是|或是/u.test(source)) return fact;

  const nameOffset = source.indexOf(fact.name);
  const beforeName = nameOffset >= 0 ? source.slice(0, nameOffset) : "";
  // If the original clause already puts a movement verb before this exact
  // name, its first character belongs to the name and must not be stripped.
  const hasSeparateAction = /(?:前往|参观|游览|回到|返回|去|到|逛|回|在|吃)\s*$/u.test(beforeName);
  const fromName = queryPhrase(fact.name, !hasSeparateAction);
  let query = usablePhrase(fromName) && source.includes(fromName) ? fromName : null;
  if (!query) {
    if (multipleDestinations.test(source)) return fact;
    // A generic activity title may still have a single named venue in its own
    // source clause, e.g. an activity title of "吃饭" with "去某餐厅吃饭".
    const phrases = [...source.matchAll(/(?:前往|回到|返回|参观|游览|去|到|在)\s*([^，,。；;！？!?]+)/gu)]
      .map(match => queryPhrase(match[1], false));
    const candidates = [...new Set(phrases.filter(usablePhrase))];
    if (candidates.length === 1) query = candidates[0];
  }
  if (query && source.includes(query) && rawText.includes(query)) {
    return { ...fact, placeQuery: query, locationEvidence: { source: "original_text", text: source } };
  }

  // A reference to "the hotel" can use an existing, uniquely identified hotel;
  // it cannot create a new hotel choice or silently pick one of several hotels.
  if (/^(?:我|我们)?(?:的|住的)?(?:酒店|宾馆)$/u.test(fromName) && source.includes(fromName)) {
    const known = locationQuery(fromName, rawText, snapshot).query;
    if (usablePhrase(known) && known !== fromName) {
      return { ...fact, placeQuery: known, locationEvidence: { source: "saved_itinerary", text: source } };
    }
  }
  return fact;
}
