"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Loading } from "./shared-ui";
import { useRealSession } from "./use-real-session";

export function MineFlow() {
  const { session, error } = useRealSession();
  const [rescueCount, setRescueCount] = useState(0);
  const [lastRescue, setLastRescue] = useState<string | null>(null);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const events = JSON.parse(localStorage.getItem("travel-analytics") ?? "[]") as Array<{ name?: string; created_at?: string }>;
        const accepted = events.filter(event => event.name === "replan_accepted").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setRescueCount(accepted.length);
        setLastRescue(accepted[0]?.created_at ?? null);
      } catch {
        setRescueCount(0);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);
  if (!session) return <Loading error={error} />;
  const displayName = session.snapshot.profile.id === "local-traveler" ? "Ying Long" : session.snapshot.profile.id;
  const latest = lastRescue ? new Date(lastRescue).toLocaleDateString("zh-CN", { month: "long", day: "numeric", timeZone: "Asia/Shanghai" }) : "暂无记录";
  const settings = ["出行节奏与步行", "历史救援记录"];
  return <div className="mobile-workspace mine-screen">
    <div className="mine-heading"><h1>我的</h1></div>
    <section className="profile-card">
      <div className="avatar">{displayName.slice(0, 1).toUpperCase()}</div>
      <div><h2>{displayName}</h2><p>已被接住 {rescueCount} 次</p></div>
    </section>
    <section className="mine-stat"><p>最近一次救援：{latest}</p></section>
    <div className="settings-list">{settings.map(label => <button type="button" className="settings-row" key={label}><span>{label}</span><ChevronRight size={18} /></button>)}</div>
    <p className="mine-footnote">你的行程只保存在此设备的浏览器里。</p>
  </div>;
}

