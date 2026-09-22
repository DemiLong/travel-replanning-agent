import type { Snapshot } from "../../types";
import type { BrowserLocation, TravelMode, WorldPoi } from "../../types/world";

export const genericLocation = (text = "") => !text.trim() || /^(我|我们)?(的|住的|住在的)?(酒店|宾馆|美术馆|博物馆|景点|另一个景点|已预约景点|预约景点|晚餐|预约晚餐|餐厅|集合地点)(集合|参观)?$/.test(text.trim());
export const broadHotelQuery = (text = "") => {
  const value=text.trim();
  if(!/(酒店|宾馆)$/.test(value))return false;
  const brand=value.replace(/酒店|宾馆/g,"").trim();
  return !brand || /^(全季|汉庭|如家|亚朵|维也纳|锦江|速8|七天)$/.test(brand);
};
export const normalizeCity = (city = "") => city.trim().replace(/市$/g, "");
export function freshBrowserLocation(location?: BrowserLocation) {
  if (!location) return false;
  const age = Date.now() - Date.parse(location.capturedAt);
  return age >= -60000 && age <= 600000 && location.accuracy <= 1000;
}
export function locationQuery(text: string, rawText: string, snapshot: Snapshot) {
  text=text.trim().replace(/^(?:我)?(?:刚到|到达|在)/, "");
  if (/^(上海)?虹桥(机场|国际机场|枢纽)?$/.test(text) && /航班|飞机|机场|降落/.test(rawText)) {
    return { query: "上海虹桥国际机场", reason: "原文虹桥与航班到达语境共同限定机场；城市与坐标仍须高德验证。" };
  }
  if (/^(我|我们)?(的|住的)?(酒店|宾馆)$/.test(text.trim())) {
    const hotels = [...new Set(snapshot.itinerary.flatMap(e => /酒店|宾馆|hotel/i.test(e.location + e.name) && !genericLocation(e.location) ? [e.location] : []))];
    if (hotels.length === 1) return {query:hotels[0], reason:"已有行程唯一明确酒店与本次酒店指代对应。"};
  }
  return {query:text.replace(/(?:的)?(?:门口|入口|大门口)$/, "").trim(), reason:"使用用户地点文字及已有上下文查询，不补造坐标。"};
}
export function uniquePlace(candidates: WorldPoi[], query: string, city: string): WorldPoi | null {
  const normalize=(s:string)=>{const value=s.replace(/[\s·（）()]/g, ""),prefix=city.replace(/市$/,"");return prefix&&value.startsWith(prefix)?value.slice(prefix.length):value;};
  const inCity = city && city !== "待确认城市" ? candidates.filter(p => p.city.replace(/市$/, "") === city.replace(/市$/, "")) : candidates;
  // A contradictory city is not silently discarded. A unique exact parent POI
  // excludes similarly named terminals/shops without guessing a terminal.
  const pool = inCity.length ? inCity : candidates;
  // A category such as “美术馆” is not a named venue, even when a city's
  // museum happens to share that category as its name.
  if (genericLocation(query)) return pool.length === 1 ? pool[0] : null;
  const exact=pool.filter(p=>normalize(p.name)===normalize(query));
  if (exact.length===1) return exact[0];
  const alias=pool.filter(p=>p.name.split(/[（）()]/).some(part=>normalize(part)===normalize(query)) && !/(地铁站|停车场|售票|航站楼|\d+口)/.test(p.name));
  if(alias.length===1)return alias[0];
  return pool.length===1 ? pool[0] : null;
}

export function selectCityEvidence(entries: Array<{field:string;query:string;poi:WorldPoi}>){
  const grouped=new Map<string,Array<{field:string;query:string;poi:WorldPoi}>>();
  for(const entry of entries){
    const city=normalizeCity(entry.poi.city);
    if(!city)continue;
    const list=grouped.get(city)??[];list.push(entry);grouped.set(city,list);
  }
  const ranked=[...grouped.entries()].sort((a,b)=>b[1].length-a[1].length);
  if(!ranked.length)return {city:null,evidence:[],competingCities:[] as string[]};
  const [,winnerEntries]=ranked[0];
  const tied=ranked.slice(1).some(([,items])=>items.length===winnerEntries.length);
  if(tied || (ranked.length>1 && winnerEntries.length<2))return {city:null,evidence:[] as typeof winnerEntries,competingCities:ranked.map(([city])=>city)};
  return {city:winnerEntries[0].poi.city,evidence:winnerEntries,competingCities:ranked.slice(1).map(([city])=>city)};
}
export function allowedModes(text: string, explicit?: TravelMode, retained?: TravelMode, constraints: string[] = []): TravelMode[] {
  const input = [text,...constraints].join("；");
  let modes:TravelMode[]=explicit ? [explicit] : retained ? [retained] : ["WALKING","TRANSIT","DRIVING"];
  if (/只(?:能|愿意|想)?(?:坐|乘)?(?:公交|地铁|公共交通)/.test(input)) modes=["TRANSIT"];
  if (/只(?:能|愿意|想)?步行/.test(input)) modes=["WALKING"];
  if (/只(?:能|愿意|想)?(?:打车|驾车|开车)/.test(input)) modes=["DRIVING"];
  if (/(?:不|不能|不想|不愿意|不要)(?:坐|乘)?(?:打车|出租车|网约车|驾车|开车)/.test(input)) modes=modes.filter(m=>m!=="DRIVING");
  if (/(?:不|不能|不想|不愿意|不要)(?:坐|乘)?(?:公交|地铁|公共交通)/.test(input)) modes=modes.filter(m=>m!=="TRANSIT");
  if (/(?:不|不能|不想|不愿意|不要)(?:步行|走路)/.test(input)) modes=modes.filter(m=>m!=="WALKING");
  return modes;
}
