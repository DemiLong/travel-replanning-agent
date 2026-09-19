import { ReplanInputSchema } from "../../types";
import { RealWorldContextSchema, type RealWorldContext, type RouteEndpoint, type WorldPoi } from "../../types/world";
import { AmapPlacesService, MAX_PLACE_CANDIDATES } from "./amap-places-service";
import { AmapRoutesService, MAX_ROUTE_PAIRS } from "./amap-routes-service";
import { AmapWeatherService, emptyWeather } from "./amap-weather-service";
import { CoordinateService } from "./coordinate-service";
import { requireAmapKey, WorldServiceError } from "./amap-client";
import { broadHotelQuery, freshBrowserLocation, genericLocation, locationQuery, normalizeCity, selectCityEvidence, uniquePlace, allowedModes } from "./context-resolution";

const CITY_EVIDENCE_CONCURRENCY=3;
async function mapConcurrent<T,R>(items:T[],limit:number,worker:(item:T)=>Promise<R>):Promise<R[]>{
  const output=new Array<R>(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(true){const index=next++;if(index>=items.length)return;output[index]=await worker(items[index]);}
  }));
  return output;
}

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
    const result:RealWorldContext={currentTime:{value:state.currentTime,date:state.currentDate,source:(request.stateSources??snapshot.stateSources).currentTime==="user"?"user":"system",confirmedAt:input.confirmation!.confirmedAt},currentLocation:null,resolvedPlaces:[],alternatives:[],routes:[],weather:emptyWeather("not_requested"),dataFreshness:{groundedAt:now,routeMaxAgeSeconds:120,locationMaxAgeSeconds:600},missingWorldFacts:[],ambiguities:[],candidatePlaceIds:{},travelMode:options?.travelMode??null,cityResolution:{city:null,source:"none",evidence:[],conflicts:[]},status:"needs_input"};
    result.resolutionEvidence=[];
    const candidatePlaceIds=result.candidatePlaceIds??(result.candidatePlaceIds={});
    const tripCity=snapshot.trip.destination==="待确认城市"?"":snapshot.trip.destination;
    let city="";
    let citySource:"current_location"|"place_evidence"|"trip_destination"|"none"="none";
    const userModes=allowedModes(request.freeText,options?.travelMode,undefined,[...snapshot.profile.preferences,...snapshot.profile.dislikes]);
    const modes=userModes.filter(m=>!options?.allowedTravelModes||options.allowedTravelModes.includes(m));
    const missing=(kind:"user"|"world",field:string,message:string)=>result.missingWorldFacts.push({kind,field,message});
    const events=snapshot.itinerary.filter(e=>e.status!=="completed");
    const preResolved=new Map<string,WorldPoi>();
    const cityAnchors=[...new Map(events.map(event=>{
      const inferred=locationQuery(event.location.trim()||event.name,request.freeText,snapshot);
      return [inferred.query,{field:event.placeId,query:inferred.query}] as const;
    })).values()].filter(anchor=>anchor.query.trim()&&!genericLocation(anchor.query)&&!broadHotelQuery(anchor.query));
    const cityResults=await mapConcurrent(cityAnchors,CITY_EVIDENCE_CONCURRENCY,async anchor=>{
      try{
        const response=await this.places.searchUnbounded(anchor.query);
        candidatePlaceIds[anchor.field]=response.candidates.map(p=>p.poiId);
        const selected=options?.selectedPois[anchor.field];
        const resolvedPoi=response.candidates.find(p=>p.poiId===selected)??uniquePlace(response.candidates,anchor.query,"");
        const candidateCities=[...new Set(response.candidates.map(p=>normalizeCity(p.city)).filter(Boolean))];
        const evidencePoi=resolvedPoi??(candidateCities.length===1?response.candidates[0]:null);
        return evidencePoi?{...anchor,evidencePoi,resolvedPoi}:null;
      }catch(error){
        if(error instanceof WorldServiceError&&error.code==="AMAP_NOT_CONFIGURED")throw error;
        return null;
      }
    });
    const cityEvidenceEntries=cityResults.filter((item):item is {field:string;query:string;evidencePoi:WorldPoi;resolvedPoi:WorldPoi|null}=>Boolean(item&&item.evidencePoi)).map(item=>({field:item.field,query:item.query,poi:item.evidencePoi}));
    for(const item of cityResults){
      if(item?.resolvedPoi)preResolved.set(item.field,item.resolvedPoi);
    }
    const selectedCity=selectCityEvidence(cityEvidenceEntries);
    if(selectedCity.city){
      city=selectedCity.city;citySource="place_evidence";
      result.cityResolution={city,source:citySource,evidence:selectedCity.evidence.map(item=>({field:item.field,query:item.query,city:item.poi.city,poiId:item.poi.poiId})),conflicts:[]};
      for(const item of selectedCity.evidence)result.resolutionEvidence!.push({field:"city",query:item.query,reason:"明确行程地点的高德结果提供城市证据。",poiId:item.poi.poiId,lookupCity:"",citySource:"place_evidence",evidenceFields:[item.field]});
      if(tripCity&&normalizeCity(tripCity)!==normalizeCity(city))result.cityResolution.conflicts.push({source:"trip_destination",expected:tripCity,actual:city,message:`Session 城市“${tripCity}”与明确地点证据“${city}”不一致，优先使用地点证据。`});
    }else if(selectedCity.competingCities.length){
      result.cityResolution={city:null,source:"none",evidence:[],conflicts:[{source:"place_evidence",expected:selectedCity.competingCities[0],actual:selectedCity.competingCities[1]??selectedCity.competingCities[0],message:"明确地点对应多个城市，无法安全确定行程城市。"}]};
    }else if(tripCity){
      city=tripCity;citySource="trip_destination";result.cityResolution={city,source:citySource,evidence:[],conflicts:[]};
    }
    const resolve=async (field:string,query:string,lookupCity?:string,traceSource?:typeof citySource):Promise<WorldPoi|null>=>{
      const inferred=locationQuery(query,request.freeText,snapshot);
      query=inferred.query;
      const searchCity=lookupCity??city;
      result.resolutionEvidence!.push({field,query,reason:inferred.reason,lookupCity:searchCity,citySource:traceSource??citySource});
      if (!query.trim()) {missing("user",field,"你现在在哪里？告诉我地点名称即可。");return null;}
      try {
        const selected=options?.selectedPois[field];
        if (selected) {
          const candidateIds=candidatePlaceIds[field];
          if(candidateIds && !candidateIds.includes(selected)) {
            missing("user",field,"所选地点不属于本次 Grounding 的合法候选，请重新选择。");
            return null;
          }
          const selectedCandidate=preResolved.get(field);
          if(selectedCandidate?.poiId===selected){
            result.resolutionEvidence!.push({field,query,reason:"用户选择命中本次 Grounding 的候选地点。",poiId:selected,lookupCity:searchCity,citySource:traceSource??citySource});
            return selectedCandidate;
          }
        }
        const cached=preResolved.get(field);
        if(cached){
          result.resolutionEvidence!.push({field,query,reason:"复用城市证据阶段已确认的高德地点。",poiId:cached.poiId,lookupCity:searchCity,citySource:traceSource??citySource});
          return cached;
        }
        // An unknown booked restaurant cannot be discovered by searching nearby restaurants.
        if (/^(预约)?晚餐|^餐厅$/.test(query) || /^(我的|我们住的|住的)?(酒店|宾馆|预约景点|已预约景点|景点)(集合|参观)?$/.test(query)) {
          missing("user",field,`“${query}”具体在哪里？告诉我名称或定位即可。`);return null;
        }
        if(broadHotelQuery(query)&&!searchCity){
          missing("user",field,`“${query}”可能对应多个分店，请补充所在城市、道路或具体分店。`);return null;
        }
        const response=await this.places.search(query,/上海虹桥国际机场/.test(query)?"":searchCity);
        candidatePlaceIds[field]=response.candidates.map(p=>p.poiId);
        if(selected) {
          const selectedCandidate=response.candidates.find(p=>p.poiId===selected);
          if(!selectedCandidate) {
            missing("user",field,"所选地点不属于本次 Grounding 的合法候选，请重新选择。");
            return null;
          }
          result.resolutionEvidence!.push({field,query,reason:"用户选择命中本次 Grounding 的候选地点。",poiId:selected,lookupCity:searchCity,citySource:traceSource??citySource});
          return selectedCandidate;
        }
        const match=uniquePlace(response.candidates,query,searchCity);
        if(match) {result.resolutionEvidence!.push({field,query,reason:"高德查询结合名称、场景及城市得到唯一匹配。",poiId:match.poiId,lookupCity:searchCity,citySource:traceSource??citySource});return match;}
        if(response.candidates.length) result.ambiguities.push({field,label:query,candidates:response.candidates});
        else missing("world",field,`高德没有找到“${query}”的有效地点；未使用本地目录替代。`);
      }catch(error){if(error instanceof WorldServiceError && error.code==="AMAP_NOT_CONFIGURED")throw error;missing("world",field,`“${query}”的高德地点数据暂不可用。`);}
      return null;
    };
    // An explicit text location always wins over browser coordinates. Explicit
    // text is first validated without the saved city; broad hotel brands may
    // use a verified place-evidence city, but never a stale trip city.
    const currentQuery=locationQuery(state.currentLocation,request.freeText,snapshot).query;
    const currentLookupCity=citySource==="place_evidence"&&/(酒店|宾馆)/.test(currentQuery)?city:"";
    if(currentQuery.trim() && currentQuery!=="浏览器定位" && !(genericLocation(currentQuery)&&freshBrowserLocation(state.browserLocation))) {
      const poi=await resolve("currentLocation",state.currentLocation,currentLookupCity,"current_location");
      if(poi){
        const previousCity=city;
        result.currentLocation={...poi,id:"current",source:"user",capturedAt:input.confirmation!.confirmedAt,adcode:poi.adcode};
        if(previousCity&&normalizeCity(previousCity)!==normalizeCity(poi.city))result.cityResolution?.conflicts.push({source:"current_location",expected:previousCity,actual:poi.city,message:`当前位置城市“${poi.city}”与既有城市证据“${previousCity}”不一致，优先使用当前位置。`});
        city=poi.city;citySource="current_location";result.cityResolution={...(result.cityResolution??{city:null,source:"none",evidence:[],conflicts:[]}),city,source:citySource};
      }
    } else if(state.browserLocation) {
      const age=Date.now()-Date.parse(state.browserLocation.capturedAt);
      if(age>600000 || age< -60000 || state.browserLocation.accuracy>1000) missing("user","currentLocation","浏览器位置已过期或精度不足，请重新定位或填写当前位置。");
      else try {
        const coordinate=await this.coordinates.toGCJ02(state.browserLocation);
        const address=await this.places.reverse(coordinate);
        const previousCity=city;
        result.currentLocation={...coordinate,id:"current",city:address.city,adcode:address.adcode,source:"browser_geolocation",capturedAt:state.browserLocation.capturedAt,accuracy:state.browserLocation.accuracy};
        if(previousCity&&normalizeCity(previousCity)!==normalizeCity(address.city))result.cityResolution?.conflicts.push({source:"current_location",expected:previousCity,actual:address.city,message:`浏览器定位城市“${address.city}”与既有城市证据“${previousCity}”不一致，优先使用当前位置。`});
        city=address.city;citySource="current_location";result.cityResolution={...(result.cityResolution??{city:null,source:"none",evidence:[],conflicts:[]}),city,source:citySource};
      }catch{missing("world","currentLocation","高德坐标转换或逆地理编码不可用。");}
    }else missing("user","currentLocation","请允许浏览器定位，或填写当前位置。");
    if(!modes.length)missing("user","travelMode","已有交通限制互相冲突，这次有哪些出行方式可以使用？");
    if(selectedCity.competingCities.length&&!result.currentLocation)missing("user","destination",`明确地点对应多个城市（${selectedCity.competingCities.join("、")}），请确认这次行程所在城市。`);
    for(const event of events){
      if(result.resolvedPlaces.some(p=>p.placeId===event.placeId))continue;
      const rawQuery=event.location.trim()||event.name;
      const inferred=locationQuery(rawQuery,request.freeText,snapshot);
      const eventLookupCity=broadHotelQuery(inferred.query)&&citySource==="trip_destination"?"":city;
      const poi=await resolve(event.placeId,rawQuery,eventLookupCity,citySource);
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
