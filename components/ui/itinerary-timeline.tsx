import type { CSSProperties } from "react";
import { MapPin } from "lucide-react";
import type { ItineraryEvent } from "@/types";

export type ItineraryTone = "kept" | "adjusted" | "new" | "replaced";
export type ItineraryTimelineItem = { event: ItineraryEvent; name: string; address: string; label: string; tone: ItineraryTone };

export function ItineraryTimeline({ items, showChangeLabels = true, showAddresses = true, showTimeLabels = true }: { items: ItineraryTimelineItem[]; showChangeLabels?: boolean; showAddresses?: boolean; showTimeLabels?: boolean }) {
  const usedHues = new Set<number>();
  function appearance(tone: ItineraryTone): CSSProperties {
    const preferred = { replaced: 215, kept: 155, adjusted: 34, new: 265 };
    const hue = [preferred[tone], 215, 155, 265, 34, 185, 340, ...Array.from({ length: 30 }, (_, index) => index * 12)].find(value => !usedHues.has(value)) ?? 215;
    usedHues.add(hue);
    return { "--event-accent": `hsl(${hue} 38% 42%)`, "--event-tint": `hsl(${hue} 60% 94%)` } as CSSProperties;
  }
  return <div className="plan-timeline itinerary-timeline" aria-live="polite">{items.map(({ event, name, address, label, tone }) => (
    <div className="plan-event" key={event.id} style={appearance(tone)}>
      <div className="plan-event-time"><b>{event.startTime}</b>{event.endTime !== event.startTime && <small>{event.endTime}</small>}{showTimeLabels && <small>{event.endTime === event.startTime ? "结束待定" : event.durationSource === "suggested" ? "建议结束" : "结束时间"}</small>}</div>
      <div className="plan-event-line"><span /></div>
      <div className="plan-event-card">
        <div className="plan-event-top"><h2>{name}</h2>{showChangeLabels && <span className="plan-event-ribbon">{label}</span>}</div>
        {showAddresses && <p className="plan-event-address"><MapPin size={14} /><span>{address}</span></p>}
        <div className="event-travel-row"><span className="travel-mode-tag">{event.travelMode ? ({ WALKING: "步行", TRANSIT: "公共交通", DRIVING: "打车" } as const)[event.travelMode] : "路线待查询"}</span>{event.travelTimeFromPrevious !== null && event.travelTimeFromPrevious !== undefined && <small>预计前往 {event.travelTimeFromPrevious} 分钟</small>}</div>
      </div>
    </div>
  ))}</div>;
}
