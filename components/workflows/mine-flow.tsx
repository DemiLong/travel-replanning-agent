"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Settings2, Sparkles } from "lucide-react";
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
  const latest = lastRescue ? new Date(lastRescue).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }) : "还没有成功救援记录";
  const settings = ["出行节奏与步行", "历史救援记录", "数据与隐私", "关于接住你"];
  return <div className="mobile-workspace mine-screen"><div className="mine-heading"><span className="eyebrow">个人设置</span><h1>我的</h1></div><section className="profile-card"><div className="avatar">{displayName.slice(0, 1).toUpperCase()}</div><div><h2>{displayName}</h2><p>已被接住 {rescueCount} 次</p></div><Sparkles size={22} /></section><section className="mine-stat"><div><span className="eyebrow">最近一次救援</span><b>{latest}</b></div><Settings2 size={20} /></section><div className="settings-list">{settings.map(label => <button type="button" className="settings-row" key={label}><span>{label}</span><ChevronRight size={18} /></button>)}</div><p className="mine-footnote">你的行程只保存在此设备的浏览器里。</p></div>;
}

