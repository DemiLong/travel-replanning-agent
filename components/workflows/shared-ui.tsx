"use client";

import { LockKeyhole, MapPin } from "lucide-react";
import type { ItineraryEvent, ReplanningRequest } from "@/types";

export const reasonLabels: Record<ReplanningRequest["reason"], string> = {
  weather: "下雨或天气变化",
  late: "晚点或快迟到了",
  tired: "太累了",
  closed: "有个地方关门了",
  discovery: "发现了一个新去处",
  changed_mind: "改变主意了",
  optimize: "帮我优化路线",
  other: "其他变化",
};

export const displayPlace = (value: string) => value;
export const displayDestination = (value: string) => value;

export const eventDurationLabel = (event: ItineraryEvent) => {
  if (event.durationSource === "unknown") return "停留时间待定";
  const [startHour, startMinute] = event.startTime.split(":").map(Number);
  const [endHour, endMinute] = event.endTime.split(":").map(Number);
  const duration = Math.max(
    0,
    endHour * 60 + endMinute - (startHour * 60 + startMinute),
  );
  return event.durationSource === "suggested"
    ? `预计停留 ${duration} 分钟`
    : `停留至 ${event.endTime}`;
};

export function RawInputLimitHint({
  id,
  remaining,
}: {
  id: string;
  remaining: number;
}) {
  return (
    <small id={id} className="input-limit-hint">
      还可输入 {Math.max(0, remaining)} 个字
    </small>
  );
}

export function Loading({ error }: { error?: string }) {
  return (
    <div className="workspace busy" role={error ? "alert" : "status"}>
      {error ? (
        <>
          <h1>恢复上次进度失败</h1>
          <p>{error}</p>
          <button
            type="button"
            className="primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </>
      ) : (
        "正在恢复你上次的进度……"
      )}
    </div>
  );
}

export function Timeline({ events }: { events: ItineraryEvent[] }) {
  if (!events.length)
    return <p className="muted">这里暂时没有需要执行的安排。</p>;
  return (
    <div className="timeline">
      {events.map((event) => (
        <div
          className={`event ${event.locked ? "protected" : ""}`}
          key={event.id}
        >
          <div className="event-time">
            {event.startTime}
            <small>
              {event.durationSource === "unknown"
                ? "停留时间待定"
                : event.endTime}
            </small>
          </div>
          <div className="event-marker">
            {event.locked ? <LockKeyhole size={14} /> : <span />}
          </div>
          <div className="event-body">
            <div className="event-title">
              <h3>{displayPlace(event.name)}</h3>
              <span className={`badge ${event.locked ? "locked" : ""}`}>
                {event.locked ? "保留" : "待进行"}
              </span>
            </div>
            <p>
              <MapPin size={13} /> {displayPlace(event.location)}
            </p>
            {event.travelMode && (
              <p>
                {({
                  WALKING: "步行",
                  TRANSIT: "公共交通",
                  DRIVING: "驾车 / 打车建议",
                } as Record<string, string>)[event.travelMode]}{" "}
                · 预计 {event.travelTimeFromPrevious} 分钟
              </p>
            )}
            {event.durationSource === "suggested" && <small>预计停留时间</small>}
            {event.protectionPolicy?.arrivalBuffer && (
              <small>
                建议提前 {event.protectionPolicy.arrivalBuffer.recommendedMinutes}{" "}
                分钟抵达；这是规划缓冲，不是票面时间
              </small>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
