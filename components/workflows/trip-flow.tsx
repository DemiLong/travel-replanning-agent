"use client";

import Link from "next/link";
import { ArrowRight, ChevronRight, CloudSun, MapPin } from "lucide-react";
import type { ItineraryEvent } from "@/types";
import {
  displayDestination,
  displayPlace,
  Loading,
} from "./shared-ui";
import { useRealSession } from "./use-real-session";

export function TripFlow() {
  const { session, error } = useRealSession();
  if (!session) return <Loading error={error} />;
  const { snapshot } = session;
  if (!snapshot.itinerary.length)
    return (
      <div className="mobile-workspace empty-screen">
        <span className="eyebrow">今日</span>
        <h1>今天还没有行程。</h1>
        <p className="muted">把今天的安排告诉我，我们一起慢慢排好。</p>
        <Link className="primary full" href="/">开始安排今天 <ArrowRight size={17} /></Link>
      </div>
    );
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (value: string) => value.split(":").map(Number).reduce((h, m) => h * 60 + m, 0);
  const remaining = snapshot.itinerary.filter(event => event.status !== "completed").sort((a, b) => a.startTime.localeCompare(b.startTime));
  const nextEvent = remaining.find((event) => toMinutes(event.startTime) >= currentMinutes);
  const activityLabel = (event: ItineraryEvent) => event.durationSource !== "unknown" && toMinutes(event.startTime) <= currentMinutes && toMinutes(event.endTime) > currentMinutes ? "进行中" : toMinutes(event.startTime) < currentMinutes ? "时间已过，待确认" : "待进行";
  const weatherLabel = snapshot.state.weather === "rain" ? "有雨" : snapshot.state.weather === "hot" ? "高温" : snapshot.state.weather === "sunny" ? "晴" : "天气未查询";
  return (
    <div className="mobile-workspace today-screen">
      <div className="today-heading">
        <div><span className="eyebrow">{displayDestination(snapshot.trip.destination)} · {snapshot.state.currentDate}</span><h1>今天，慢慢走</h1></div>
        <div className="today-meta"><span>{currentTime}</span><span><CloudSun size={16} />{weatherLabel}</span></div>
      </div>
      <section className="next-card">
        <div><span className="eyebrow">下一步去哪</span>{nextEvent ? <><h2>{displayPlace(nextEvent.name)}</h2><p><MapPin size={14} /> {displayPlace(nextEvent.location)} · {nextEvent.travelMode ? ({ WALKING: "步行", TRANSIT: "公共交通", DRIVING: "打车" } as Record<string, string>)[nextEvent.travelMode] : "路线待查询"}</p></> : <h2>今天没有待执行安排</h2>}</div><ChevronRight size={24} />
      </section>
      <div className="route-strip"><span className="route-dot active" /><span /><span className="route-dot" /><span /><span className="route-dot" /><small>{nextEvent?.travelTimeFromPrevious ? `路上约 ${nextEvent.travelTimeFromPrevious} 分钟` : "按自己的节奏走"}</small></div>
      <section className="today-list-section"><div className="section-title"><h2>今日剩余</h2><span>{remaining.length} 个安排</span></div><div className="mobile-timeline">{remaining.map(event => <div className={`mobile-timeline-item ${event.id === nextEvent?.id ? "current" : ""}`} key={event.id}><div className="mobile-time"><b>{event.startTime}</b><small>{event.endTime === event.startTime ? "时间待定" : event.endTime}</small></div><div className="mobile-line"><span /></div><div className="mobile-event"><div><b>{displayPlace(event.name)}</b>{event.locked && <span className="status-pill kept">保留</span>}</div><p>{displayPlace(event.location)} · {event.durationSource === "unknown" ? "停留时间待定" : `${Math.max(0, toMinutes(event.endTime) - toMinutes(event.startTime))} 分钟`}</p><small className="now-label">{activityLabel(event)}</small></div></div>)}</div></section>
      <Link className="change-card" href="/"><span><b>发生变化？</b><small>随时告诉我，我来帮你重新安排</small></span><ArrowRight size={18} /></Link>
      <Link className="today-edit-link" href="/onboarding">编辑今天的安排</Link>
    </div>
  );
}

