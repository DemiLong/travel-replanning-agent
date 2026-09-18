import { WeatherSchema, type WorldWeather } from "../../types/world";
import { amapGet, objects, requireAmapKey, textValue } from "./amap-client";
export function emptyWeather(status: "unavailable" | "not_requested"): WorldWeather {
  return {condition:null,temperature:null,humidity:null,windDirection:null,windPower:null,forecast:[],source:"amap",fetchedAt:new Date().toISOString(),reportedAt:null,status};
}
const number = (x: unknown) => (typeof x==="number" || typeof x==="string" && x.trim()!=="") && Number.isFinite(Number(x)) ? Number(x) : null;
export class AmapWeatherService {
  async weather(adcode: string): Promise<WorldWeather> {
    requireAmapKey();
    if (!/^\d{6}$/.test(adcode)) return emptyWeather("unavailable");
    const responses = await Promise.allSettled([amapGet("/v3/weather/weatherInfo",{city:adcode,extensions:"base"},600000),amapGet("/v3/weather/weatherInfo",{city:adcode,extensions:"all"},600000)]);
    const liveBody = responses[0].status==="fulfilled" ? responses[0].value : null;
    const forecastBody = responses[1].status==="fulfilled" ? responses[1].value : null;
    const live = objects(liveBody?.lives)[0];
    const forecast = objects(forecastBody?.forecasts)[0];
    if (!live || !textValue(live.weather)) return emptyWeather("unavailable");
    return WeatherSchema.parse({
      condition:textValue(live.weather),temperature:number(live.temperature),humidity:number(live.humidity),
      windDirection:textValue(live.winddirection)||null,windPower:textValue(live.windpower)||null,
      forecast:objects(forecast?.casts).slice(0,3).map(c=>({date:textValue(c.date),dayCondition:textValue(c.dayweather),nightCondition:textValue(c.nightweather),dayTemperature:number(c.daytemp),nightTemperature:number(c.nighttemp)})),
      source:"amap",fetchedAt:liveBody?._fetchedAt,reportedAt:textValue(live.reporttime)||null,status:"available",
    });
  }
}
