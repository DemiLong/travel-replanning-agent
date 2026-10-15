"use client";

import Link from "next/link";
import { CalendarDays, ChevronLeft, UserRound } from "lucide-react";
import { SessionWorkflow } from "./workflows";

export function TravelApp({ page }: { page: string }) {
  const isMe = page === "me";
  const hasBack = page === "result" || page === "onboarding";
  return (
    <div className="site">
      <header className={hasBack ? "header result-header" : "header"}>
        {hasBack ? <Link className="result-back" href="/" aria-label="返回上一页"><ChevronLeft size={22} strokeWidth={1.8} /></Link> : <Link className="brand" href="/" aria-label="coveredYou 首页">
          coveredYou · 接住你
        </Link>}
        <nav aria-label="主导航">
          <Link className={page === "home" ? "active" : ""} href="/">
            首页
          </Link>
          <Link className={page === "trip" ? "active" : ""} href="/trip">
            我的今日行程
          </Link>
          <Link
            className={page === "onboarding" ? "active" : ""}
            href="/onboarding"
          >
            创建行程
          </Link>
        </nav>
        <span className="site-mode-label">真实行程 · 本地保存</span>
      </header>
      <main className={isMe ? "app-main me-main" : "app-main"}>
        <SessionWorkflow page={page} />
      </main>
      <footer className="site-footer">
        <span>
          coveredYou <span> / </span> 今日行程救援助手
        </span>
        <span>
          为旅途中的意外而生。
        </span>
      </footer>
      <nav className="mobile-bottom-nav" aria-label="底部导航">
        <Link className={page === "trip" ? "active" : ""} href="/trip">
          <CalendarDays size={19} />
          <span>今日</span>
        </Link>
        <Link className={page === "me" ? "active" : ""} href="/me">
          <UserRound size={19} />
          <span>我的</span>
        </Link>
      </nav>
    </div>
  );
}
