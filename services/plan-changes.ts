import { minutes } from "../lib/time";
import type { ActivityFact, ItineraryEvent, ProposedPlan, Snapshot } from "../types";

export type ChangeKind = "added" | "removed" | "time" | "start_suggestion" | "duration" | "duration_suggestion" | "transport" | "transport_suggestion" | "order";
export type PlanChange = {
  id: string;
  name: string;
  tags: Array<{ kind: ChangeKind; label: string }>;
  rows: Array<{ label: string; before?: string; after: string }>;
  reason: string;
  important: boolean;
  preservedTime: string | null;
  label: string;
  tone: "kept" | "adjusted" | "new";
};

const modeNames = { DRIVING: "打车", WALKING: "步行", TRANSIT: "公共交通" } as const;
const remaining = (facts: ActivityFact[]) => facts.filter(fact => fact.role === "existing_plan" && fact.progress !== "completed");

export function originalFactForEvent(facts: ActivityFact[], id: string) {
  return remaining(facts).find(fact => fact.id === id || fact.snapshotEventId === id);
}

function durationOf(event: ItineraryEvent) {
  return event.durationSource === "unknown" || event.endTime === event.startTime ? null : minutes(event.endTime) - minutes(event.startTime);
}

/** Derive display facts from the confirmed input, never from model prose. */
export function buildPlanChanges(facts: ActivityFact[], plan: ProposedPlan, base?: Snapshot): PlanChange[] {
  const originals = remaining(facts);
  const ordered = plan.events.map(event => ({ event, fact: originalFactForEvent(originals, event.id) }));
  const reordered = new Set<string>();
  // Compare relative order only when both original times are known. Removing an
  // earlier activity or inserting a new one cannot itself count as reordering.
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i].fact, b = ordered[j].fact;
      if (a?.startTime && b?.startTime && a.startTimeSource !== "not_provided" && b.startTimeSource !== "not_provided" && a.startTime > b.startTime) {
        reordered.add(ordered[i].event.id); reordered.add(ordered[j].event.id);
      }
    }
  }
  const saved = [...(base?.itinerary ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const changes = ordered.map(({ event, fact }, index): PlanChange => {
    const tags: PlanChange["tags"] = [], rows: PlanChange["rows"] = [];
    const add = (kind: ChangeKind, label: string) => tags.push({ kind, label });
    const knownStart = fact?.startTime && fact.startTimeSource !== "not_provided" ? fact.startTime : null;
    const knownEnd = fact?.durationSource !== "unknown" ? fact?.endTime : null;
    const proposedDuration = durationOf(event);
    const beforeTime = knownStart ? knownEnd && knownEnd > knownStart ? `${knownStart}–${knownEnd}` : knownStart : undefined;
    const afterTime = proposedDuration === null ? `${event.startTime}（结束待定）` : `${event.startTime}–${event.endTime}`;
    if (!fact) {
      add("added", "建议新增");
      rows.push({ label: "建议安排", after: afterTime });
    } else if (knownStart && (knownStart !== event.startTime || (knownEnd && knownEnd !== event.endTime))) {
      add("time", "时间调整");
      rows.push({ label: "时间", before: beforeTime, after: afterTime });
    } else if (!knownStart) {
      add("start_suggestion", "建议开始时间");
      rows.push({ label: "开始", after: `建议 ${event.startTime} 开始` });
    }
    const oldDuration = fact && fact.durationSource !== "unknown" && !fact.endTimeFixed
      ? fact.durationMinutes ?? (knownStart && knownEnd ? minutes(knownEnd) - minutes(knownStart) : null) : null;
    if (proposedDuration !== null && proposedDuration > 0) {
      if (fact && oldDuration !== null && oldDuration > 0 && oldDuration !== proposedDuration) {
        add("duration", "时长调整");
        rows.push({ label: "停留", before: `${oldDuration}分钟${fact.durationSource === "suggested" ? "（原建议）" : ""}`, after: `${proposedDuration}分钟${event.durationSource === "suggested" ? "（建议）" : ""}` });
      } else if (!fact || oldDuration === null) {
        if (fact) add("duration_suggestion", "停留建议");
        rows.push({ label: "停留", after: `建议 ${proposedDuration} 分钟` });
      }
    }
    if (event.travelMode) {
      const oldIndex = fact?.snapshotEventId ? saved.findIndex(item => item.id === fact.snapshotEventId) : -1;
      const old = saved[oldIndex];
      // A mode belongs to a leg, not just its destination. Never compare modes
      // after the origin has changed, including the first leg from current location.
      const comparable = oldIndex > 0 && index > 0 && saved[oldIndex - 1].placeId === plan.events[index - 1].placeId && old?.placeId === event.placeId;
      if (comparable && old.travelMode) {
        if (old.travelMode !== event.travelMode) {
          add("transport", "交通调整");
          rows.push({ label: "交通", before: modeNames[old.travelMode], after: modeNames[event.travelMode] });
        }
      } else {
        if (fact) add("transport_suggestion", `推荐${modeNames[event.travelMode]}`);
        rows.push({ label: "交通", after: `推荐${modeNames[event.travelMode]}` });
      }
    }
    if (reordered.has(event.id)) {
      add("order", "顺序调整");
      const peer = ordered.find(other => other.fact?.startTime && knownStart && other.event.id !== event.id &&
        ((other.fact.startTime < knownStart && plan.events.indexOf(other.event) > index) || (other.fact.startTime > knownStart && plan.events.indexOf(other.event) < index)));
      if (peer) rows.push({ label: "顺序", after: `安排在${peer.event.name}${plan.events.indexOf(peer.event) < index ? "之后" : "之前"}` });
    }
    const preservedTime = knownStart === event.startTime ? knownEnd && knownEnd !== event.endTime ? knownStart : beforeTime ?? null : null;
    if (!tags.length) rows.push({ label: "原安排", after: beforeTime ?? event.name });
    return { id: event.id, name: event.name, tags, rows, reason: event.reason,
      important: Boolean(fact && fact.commitment !== "flexible"), preservedTime,
      label: tags[0]?.label ?? "时间、地点未变", tone: !fact ? "new" : tags.length ? "adjusted" : "kept" };
  });
  for (const fact of originals) {
    const removed = plan.removedEvents.find(item => item.eventId === fact.id || item.eventId === fact.snapshotEventId);
    if (removed) changes.push({ id: removed.eventId, name: fact.name, tags: [{ kind: "removed", label: "建议取消" }],
      rows: [{ label: "原安排", after: `${fact.startTime ?? ""} ${fact.name}`.trim() }], reason: removed.reason,
      important: fact.commitment !== "flexible", preservedTime: null, label: "建议取消", tone: "adjusted" });
  }
  return changes;
}

export function changePresentation(change: PlanChange, accepted = false) {
  return { label: accepted && change.label === "建议新增" ? "新增" : change.label, tone: change.tone };
}
