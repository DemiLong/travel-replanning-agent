import { ArrowDown, ChevronDown, ShieldCheck } from "lucide-react";
import { buildPlanChanges, type PlanChange } from "@/services/plan-changes";
import { planNarrativeForDisplay } from "@/services/plan-narrative";
import { partialRouteMessage } from "@/services/route-availability";
import type { AgentContext, ProposedPlan, ReplanningRequest, Snapshot } from "@/types";
import type { RealWorldContext } from "@/types/world";

export function PlanDetails({ plan, request, base, context, world, retrying, busy, retryError, onRetry }: {
  plan: ProposedPlan; request: ReplanningRequest; base: Snapshot; context: AgentContext; world?: RealWorldContext;
  retrying: boolean; busy: boolean; retryError: string; onRetry: () => void;
}) {
  const changes = buildPlanChanges(request.activityFacts, plan, base);
  const changed = changes.filter(item => item.tags.length);
  const important = changes.filter(item => !item.tags.length && item.important);
  const unchanged = changes.filter(item => !item.tags.length && !item.important);
  const narrative = planNarrativeForDisplay(context, plan);
  const routeMessage = partialRouteMessage(world, request);
  const additionalNotes = world?.missingWorldFacts.filter(fact => fact.kind === "world" && fact.field !== "routes") ?? [];
  const hasHiddenText = !narrative.overview || changes.some(item => item.reason.trim() && !narrative.reasons.has(item.id));

  const card = (item: PlanChange) => <article className={`change-card-detail${item.tags.some(tag => tag.kind === "removed") ? " is-removal" : ""}`} key={item.id} data-activity-id={item.id}>
    <h3>{item.name}</h3>
    {item.tags.length > 0 && <div className="change-tags">{item.tags.map(tag => <span key={tag.kind} className={`change-tag ${["added", "removed", "time", "duration", "transport", "order"].includes(tag.kind) ? "is-change" : "is-suggestion"}`}>{tag.label}</span>)}</div>}
    <dl className="change-facts">{item.rows.filter(row => !item.tags.some(tag => tag.label === row.after)).map((row, index) => <div className="change-fact" key={`${row.label}-${index}`}>
      <dt>{row.label}</dt><dd>{row.before && <><span className="change-before">{row.before}</span><ArrowDown size={13} aria-label="调整为" /></>}<span className="change-after">{row.after}</span></dd>
    </div>)}</dl>
    {item.important && item.preservedTime && item.tags.length > 0 && <p className="change-protected"><ShieldCheck size={14} aria-hidden="true" />{item.preservedTime} 固定时间保留</p>}
    {narrative.reasons.get(item.id) && <p className="change-reason">{narrative.reasons.get(item.id)}</p>}
  </article>;

  return <div className="plan-details-content">
    {changed.length > 0 ? <section className="change-section" aria-label="具体改动与建议">
      <div className="change-card-list">{changed.map(card)}</div>
    </section> : <p className="change-empty">本方案保留原安排，已知时间与地点未变。</p>}
    {important.length > 0 && <section className="change-section" aria-label="保住的重要安排">
      <div className="change-section-heading"><h2><ShieldCheck size={15} aria-hidden="true" />保住的重要安排</h2><span>{important.length} 项</span></div>
      <div className="change-card-list">{important.map(card)}</div>
    </section>}
    {unchanged.length > 0 && <details className="change-unchanged">
      <summary><span>{changed.length ? "其余安排" : "原安排明细"}<small>{unchanged.length} 项时间、地点未变</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="change-card-list">{unchanged.map(card)}</div>
    </details>}
    {hasHiddenText && <p className="change-text-note">部分文字说明待核对，以上展示实际安排。</p>}
    {(routeMessage || additionalNotes.length > 0) && <section className="change-section" aria-label="查询与执行提醒">
      <div className="change-section-heading"><h2>查询与执行提醒</h2></div>
      {routeMessage && <div className="plan-route-note" aria-label="线路查询情况" aria-busy={retrying}>
        <p role="status">{routeMessage}</p>
        <button type="button" className="route-retry-link" disabled={busy} onClick={onRetry}>{retrying ? "正在重试…" : "点击重试"}</button>
        {retryError && <p className="route-retry-error" role="alert">{retryError}</p>}
      </div>}
      {additionalNotes.length > 0 && <div className="plan-route-note" aria-label="其他查询情况">{additionalNotes.map(fact => <p key={fact.field}>{fact.message}</p>)}</div>}
    </section>}
  </div>;
}
