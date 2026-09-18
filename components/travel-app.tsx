"use client";

import Link from "next/link";
import { Route } from "lucide-react";
import { SessionWorkflow } from "./workflows";

export function TravelApp({ page }: { page: string }) {
  return (
    <div className="site">
      <header className="header">
        <Link className="brand" href="/" aria-label="接住你 首页">
          <span className="brand-icon" aria-hidden="true">
            <Route size={24} />
          </span>
          接住你
          <span className="brand-label">今日行程救援助手</span>
        </Link>
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
      <main>
        <SessionWorkflow page={page} />
      </main>
      <footer className="site-footer">
        <span>
          dayshift <span> / </span> 今日行程救援助手
        </span>
        <span>
          为旅途中的意外而生。
        </span>
      </footer>
    </div>
  );
}
