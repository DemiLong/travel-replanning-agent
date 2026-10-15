"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ItineraryTimeline, type ItineraryTimelineItem } from "@/components/ui/itinerary-timeline";
import { displayDestination, Loading } from "./shared-ui";
import { useRealSession } from "./use-real-session";

export function TripFlow() {
  const { session, error } = useRealSession();
  if (!session) return <Loading error={error} />;
  const { snapshot } = session;
  if (!snapshot.itinerary.length) return (
    <div className="mobile-workspace empty-screen">
      <h1>今天还没有行程。</h1>
      <Link className="primary full" href="/">开始安排今天 <ArrowRight size={17} /></Link>
    </div>
  );
  const remaining = snapshot.itinerary.filter(event => event.status !== "completed").sort((a, b) => a.startTime.localeCompare(b.startTime));
  const presentation = session.itineraryPresentation?.revision === snapshot.revision ? session.itineraryPresentation.events : [];
  const comparison = !session.itineraryPresentation || session.itineraryPresentation.revision === snapshot.revision ? session.lastDisruption : null;
  const items: ItineraryTimelineItem[] = remaining.map(event => {
    const saved = presentation.find(item => item.id === event.id);
    const fact = comparison?.activityFacts.find(item => item.id === event.id);
    const changed = Boolean(fact && (fact.startTime && fact.startTime !== event.startTime || fact.endTime && fact.endTime !== event.endTime));
    const added = Boolean(comparison && !fact);
    const placeName = fact?.placeQuery || (event.location && event.name.includes(event.location) ? event.location : event.name);
    return { event, name: saved?.name || placeName, address: saved?.address || event.location, label: saved?.label || (added ? "新增" : changed ? "调整" : "保留"), tone: saved?.tone || (added ? "new" : changed ? "adjusted" : "kept") };
  });
  return (
    <div className="mobile-workspace today-screen">
      <div className="today-heading"><span className="eyebrow">{displayDestination(snapshot.trip.destination)} · {snapshot.state.currentDate}</span></div>
      <section className="today-list-section"><div className="section-title"><h1>今日行程</h1><span>{remaining.length} 个安排</span></div><ItineraryTimeline items={items} /></section>
      <Link className="change-card" href="/"><span><b>发生变化？</b><small>随时告诉我，我来帮你重新安排</small></span><ArrowRight size={18} /></Link>
      <Link className="today-edit-link" href="/onboarding">编辑今天的安排</Link>
    </div>
  );
}
