import { BrowserLocationSchema, type BrowserLocation } from "../../types/world";

// Browser-only adapter; it contains no provider credentials or HTTP calls.
export class LocationService {
  getCurrentPosition(): Promise<BrowserLocation> {
    return new Promise((resolve, reject) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) return reject(new Error("当前浏览器不支持定位，请填写当前位置。"));
      navigator.geolocation.getCurrentPosition(
        p => resolve(BrowserLocationSchema.parse({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, capturedAt: new Date(p.timestamp).toISOString(), source: "browser_geolocation", coordinateSystem: "WGS84" })),
        () => reject(new Error("没有取得浏览器位置，请填写你现在所在的具体地点。")),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
      );
    });
  }
}
