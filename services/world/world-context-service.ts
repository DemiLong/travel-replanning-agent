import { ReplanInputSchema } from "../../types";
import { RealWorldContextSchema, type RealWorldContext, type RouteEndpoint, type WorldPoi } from "../../types/world";
import { AmapPlacesService, MAX_PLACE_CANDIDATES } from "./amap-places-service";
import { AmapRoutesService, MAX_ROUTE_PAIRS } from "./amap-routes-service";
import { AmapWeatherService, emptyWeather } from "./amap-weather-service";
import { CoordinateService } from "./coordinate-service";
import { requireAmapKey, WorldServiceError } from "./amap-client";
import { freshBrowserLocation, genericLocation, locationQuery, uniquePlace, allowedModes } from "./context-resolution";

export function validateRealInput(raw: unknown) {
  const input = ReplanInputSchema.parse(raw);
  if (input.snapshot.mode!=="user" || input.mode==="demo") throw new Error("真实世界服务不接受示例行程。");
  if (!input.confirmation || !input.snapshot.itinerary.some(e=>e.status!=="completed")) throw new Error("请先确认至少一项今日安排及解析结果。");
  const state=input.request.currentState, sources=input.request.stateSources ?? input.snapshot.stateSources;
  if (Object.values(sources).includes("demo")) throw new Error("示例状态不能进入真实规划。");
  if (state.currentDate!==input.snapshot.state.currentDate || state.currentDate<input.snapshot.trip.startDate || state.currentDate>input.snapshot.trip.endDate) throw new Error("日期不属于当前行程。");
  if (sources.currentTime==="unset") throw new Error("请确认当前时间。");
  if (!input.request.freeText.trim() && input.request.reason!=="optimize") throw new Error("请先确认本次变化或选择优化行程。");
  if (new Set(input.snapshot.itinerary.map(e=>e.id)).size!==input.snapshot.itinerary.length) throw new Error("活动 ID 重复。");
  return input;
}

export class WorldContextService {
  constructor(private places=new AmapPlacesService(), private routes=new AmapRoutesService(), private weather=new AmapWeatherService(), private coordinates=new CoordinateService()) {}
  async ground(raw: unknown): Promise<RealWorldContext> {
    const input=validateRealInput(raw);
    requireAmapKey();
    const {snapshot,request}=input, state=request.currentState, options=request.worldOptions;
    const now=new Date().toISOString();
    const result:RealWorldContext={currentTime:{value:state.currentTime,date:state.currentDate,source:(request.stateSources??snapshot.stateSources).currentTime==="user"?"user":"system",confirmedAt:input.confirmation!.confirmedAt},currentLocation:null,resolvedPlaces:[],alternatives:[],routes:[],weather:emptyWeather("not_requested"),dataFreshness:{groundedAt:now,routeMaxAgeSeconds:120,locationMaxAgeSeconds:600},missingWorldFacts:[],ambiguities:[],travelMode:options?.travelMode??null,status:"needs_input"};
    result.resolutionEvidence=[];
    let city=snapshot.trip.destination==="待确认城市"?"":snapshot.trip.destination;
    const userModes=allowedModes(request.freeText,options?.travelMode,undefined,[...snapshot.profile.preferences,...snapshot.profile.dislikes]);
    const modes=userModes.filter(m=>!options?.allowedTravelModes||options.allowedTravelModes.includes(m));
    const missing=(kind:"user"|"world",field:string,message:string)=>result.missingWorldFacts.push({kind,field,message});
    const resolve=async (field:string,query:string):Promise<WorldPoi|null>=>{
      const inferred=locationQuery(query,request.freeText,snapshot);
      query=inferred.query;
      result.resolutionEvidence!.push({field,query,reason:inferred.reason});
      if (!query.trim()) {missing("user",field,"你现在在哪里？告诉我地点名称即可。");return null;}
      try {
        const selected=options?.selectedPois[field];
        if (selected) {
          const match=await this.places.detail(selected);
          if(match) {result.resolutionEvidence!.push({field,query,reason:"复核此前已解析或用户选择的高德地点；保留原始解析依据。",poiId:match.poiId});return match;}
          missing("world",field,"此前选择的地点暂时无法从高德复核。");return null;
        }
        // An unknown booked restaurant cannot be discovered by searching nearby restaurants.
        if (/^(预约)?晚餐|^餐厅$/.test(query) || /^(我的|我们住的|住的)?(酒店|宾馆|预约景点|已预约景点|景点)(集合|参观)?$/.test(query)) {
          missing("user",field,`“${query}”具体在哪里？告诉我名称或定位即可。`);return null;
        }
        const response=await this.places.search(query,/上海虹桥国际机场/.test(query)?"":city);
        const match=uniquePlace(response.candidates,query,city);
        if(match) {result.resolutionEvidence!.push({field,query,reason:"高德查询结合名称、场景及城市得到唯一匹配。",poiId:match.poiId});return match;}
        if(response.candidates.length) result.ambiguities.push({field,label:query,candidates:response.candidates});
        else missing("world",field,`高德没有找到“${query}”的有效地点；未使用本地目录替代。`);
      }catch(error){if(error instanceof WorldServiceError && error.code==="AMAP_NOT_CONFIGURED")throw error;missing("world",field,`“${query}”的高德地点数据暂不可用。`);}
      return null;
    };
    // An explicit text location always wins over browser coordinates.
    const currentQuery=locationQuery(state.currentLocation,request.freeText,snapshot).query;
    if(currentQuery.trim() && currentQuery!=="浏览器定位" && !(genericLocation(currentQuery)&&freshBrowserLocation(state.browserLocation))) {
      const poi=await resolve("currentLocation",state.currentLocation);
      if(poi){result.currentLocation={...poi,id:"current",source:"user",capturedAt:input.confirmation!.confirmedAt,adcode:poi.adcode};city=poi.city;}
    } else if(state.browserLocation) {
      const age=Date.now()-Date.parse(state.browserLocation.capturedAt);
      if(age>600000 || age< -60000 || state.browserLocation.accuracy>1000) missing("user","currentLocation","浏览器位置已过期或精度不足，请重新定位或填写当前位置。");
      else try {
        const coordinate=await this.coordinates.toGCJ02(state.browserLocation);
        const address=await this.places.reverse(coordinate);
        result.currentLocation={...coordinate,id:"current",city:address.city,adcode:address.adcode,source:"browser_geolocation",capturedAt:state.browserLocation.capturedAt,accuracy:state.browserLocation.accuracy};city=address.city;
      }catch{missing("world","currentLocation","高德坐标转换或逆地理编码不可用。");}
    }else missing("user","currentLocation","请允许浏览器定位，或填写当前位置。");
    if(!modes.length)missing("user","travelMode","已有交通限制互相冲突，这次有哪些出行方式可以使用？");
    const events=snapshot.itinerary.filter(e=>e.status!=="completed");
    for(const event of events){
      if(result.resolvedPlaces.some(p=>p.placeId===event.placeId))continue;
      const poi=await resolve(event.placeId,event.location.trim()||event.name);
      if(poi)result.resolvedPlaces.push({placeId:event.placeId,poi});
    }
    const needsWeather=request.reason==="weather" || state.weather!==undefined || /天气|下雨|高温|暴雨|暴晒/.test(request.freeText);
    if(needsWeather && result.currentLocation){
      if(!result.currentLocation.adcode){
        try{result.currentLocation.adcode=(await this.places.reverse(result.currentLocation)).adcode;}catch{ /* Keep unavailable instead of fabricating an administrative code. */ }
      }
      result.weather=await this.weather.weather(result.currentLocation.adcode);
    }
    if(needsWeather && result.weather.status!=="available")missing("world","weather","天气数据不可用，不能确认天气适宜程度。");
    if(result.currentLocation && ["weather","closed","discovery","tired"].includes(request.reason)){
      try {
        const search=await this.places.around(request.reason==="tired"?"咖啡馆":"博物馆",result.currentLocation);
        result.alternatives=search.candidates.filter(p=>!result.resolvedPlaces.some(r=>r.poi.poiId===p.poiId)).slice(0,MAX_PLACE_CANDIDATES);
      }catch{missing("world","alternatives","附近替代地点暂不可用。已有安排仍可比较。");}
    }
    if(result.currentLocation && modes.length && !result.ambiguities.length && !result.missingWorldFacts.some(x=>x.kind==="user")){
      const endpoints:RouteEndpoint[]=result.resolvedPlaces.map(x=>({...x.poi,id:x.placeId}));
      // Candidate and original legs use the same source; bound total alternatives to route budget.
      while((endpoints.length+result.alternatives.length)**2*modes.length>MAX_ROUTE_PAIRS && result.alternatives.length)result.alternatives.pop();
      endpoints.push(...result.alternatives.map(p=>({...p,id:p.poiId})));
      const originals=events.map(e=>endpoints.find(p=>p.id===e.placeId)).filter((p):p is RouteEndpoint=>Boolean(p));
      const required=originals.map((destination,i)=>({origin:i?originals[i-1]:result.currentLocation!,destination})).filter(p=>p.origin.id!==p.destination.id);
      const fixedPairs=originals.flatMap((origin,i)=>{const fixed=events.slice(i+1).find(e=>e.locked);const destination=fixed?endpoints.find(p=>p.id===fixed.placeId):undefined;return destination&&origin.id!==destination.id?[{origin,destination}]:[];});
      const ordered=[...required,...originals.filter(p=>events.some(e=>e.placeId===p.id&&e.locked)).map(destination=>({origin:result.currentLocation!,destination})),...fixedPairs,...endpoints.map(destination=>({origin:result.currentLocation!,destination})),...endpoints.flatMap(origin=>endpoints.filter(d=>d.id!==origin.id).map(destination=>({origin,destination})))];
      const pairs=[...new Map(ordered.map(p=>[`${p.origin.id}>${p.destination.id}`,p])).values()];
      if(new Set(required.map(p=>`${p.origin.id}>${p.destination.id}`)).size*modes.length>MAX_ROUTE_PAIRS)missing("world","routes","必要路线超过本轮 40 次查询上限，请分段调整行程。");
      else {
        const bounded=pairs.slice(0,Math.floor(MAX_ROUTE_PAIRS/modes.length));
        for(const mode of modes)result.routes.push(...await this.routes.batch(bounded,mode));
      }
      if(result.routes.some(r=>r.status==="unavailable"))missing("world","routes","部分路线不可用；不会用估算时间代替，包含这些路段的方案将被拒绝。");
    }
    const allPlaces=result.resolvedPlaces.length===new Set(events.map(e=>e.placeId)).size;
    result.status=result.ambiguities.length || result.missingWorldFacts.some(x=>x.kind==="user") ? "needs_input" : result.currentLocation && allPlaces && result.routes.some(r=>r.status==="available") ? "ready" : "unavailable";
    return RealWorldContextSchema.parse(result);
  }
}
