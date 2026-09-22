"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import type { AnalyticsEvent } from "@/services/trip-service";
type Report = {
  scenarioPassRate: number;
  hardConstraintPassRate: number;
  feasibleCasePassRate: number;
  total: number;
  violationRates: Record<string, number>;
  averageRegenerationCount: number;
  model: string;
  generatedAt: string;
  results: Array<{
    id: string;
    name: string;
    expectedFeasible: boolean;
    pass: boolean;
    attempts: unknown[];
  }>;
};
const percentage = (n: number) => `${(n * 100).toFixed(1)}%`;
const violationLabels: Record<string, string> = {
  locked: "锁定安排",
  overlap: "时间重叠",
  travel: "路程不足",
  opening_hours: "营业时间",
  closure: "地点关闭",
  past: "时间已过",
  duration: "时长无效",
  identity: "地点身份",
  accounting: "行程遗漏",
};
export function EvalDashboard({ report }: { report?: Report }) {
  const [analytics, setAnalytics] = useState<AnalyticsEvent[]>([]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        setAnalytics(
          JSON.parse(localStorage.getItem("travel-analytics") ?? "[]"),
        );
      } catch {}
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);
  const generated = new Set(
    analytics
      .filter((e) => e.name === "replan_generated")
      .map((e) => e.properties.planId),
  );
  const accepted = new Set(
    analytics
      .filter(
        (e) =>
          e.name === "replan_accepted" && generated.has(e.properties.planId),
      )
      .map((e) => e.properties.planId),
  );
  if (!report)
    return (
      <div className="workspace narrow">
        <Link className="text-link" href="/trip">
          <ArrowLeft size={15} /> 返回我的今日行程
        </Link>
        <div className="page-heading" style={{ marginTop: 30 }}>
          <div>
            <span className="eyebrow">智能体评测</span>
            <h1>暂无离线评测报告。</h1>
            <p>运行评测命令后，报告会保存在本地工作目录，不作为应用运行时数据。</p>
          </div>
        </div>
      </div>
    );
  return (
    <div className="workspace">
      <Link className="text-link" href="/trip">
        <ArrowLeft size={15} /> 返回我的今日行程
      </Link>
      <div className="page-heading" style={{ marginTop: 30 }}>
        <div>
          <span className="eyebrow">智能体评测 · 作品集视图</span>
          <h1>可信，本身就是约束。</h1>
          <p>32 个模拟场景，规则清晰，结果可衡量。</p>
        </div>
      </div>
      <div className="success-box">
        <ShieldCheck style={{ display: "inline", marginRight: 10 }} />
        <b>模拟规划器基准</b>
        <p>
          这份报告测试确定性模拟和校验流程，不代表实时 OpenAI 模型的质量。其中 5
          个场景被刻意设为无解，系统应当拒绝它们。
        </p>
      </div>
      <div className="metrics">
        <div className="metric">
          <strong>{percentage(report.scenarioPassRate)}</strong>
          <span>预期结果 · {report.total} 个场景</span>
        </div>
        <div className="metric">
          <strong>{percentage(report.hardConstraintPassRate)}</strong>
          <span>有效方案 / 全部场景</span>
        </div>
        <div className="metric">
          <strong>{percentage(report.feasibleCasePassRate)}</strong>
          <span>有效方案 / 可行场景</span>
        </div>
      </div>
      <div className="card form-card">
        <h2>每次尝试的违规率</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          包含被拒绝的候选方案和重试，也包含那些刻意设置为无解的场景。
        </p>
        <div className="metrics">
          {Object.entries(report.violationRates).map(([code, rate]) => (
            <div className="metric" key={code}>
              <strong>{percentage(rate)}</strong>
              <span>{violationLabels[code] ?? code.replaceAll("_", " ")}</span>
            </div>
          ))}
        </div>
        <p className="muted">
          每个场景平均重生成次数：{report.averageRegenerationCount.toFixed(2)} ·
          模型：{report.model}
        </p>
      </div>
      <div className="card" style={{ marginTop: 25, overflow: "hidden" }}>
        <div className="card-heading">
          <h2>场景结果</h2>
          <span>运行于 {report.generatedAt.slice(0, 10)}</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>编号</TableHead>
              <TableHead>场景</TableHead>
              <TableHead>预期</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>尝试次数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.results.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.id}</TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell>
                  {r.expectedFeasible ? "有效方案" : "安全拒绝"}
                </TableCell>
                <TableCell>
                  <span className="badge">{r.pass ? "通过" : "失败"}</span>
                </TableCell>
                <TableCell>{r.attempts.length}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="card form-card" style={{ marginTop: 25 }}>
        <h2>你的示例会话</h2>
        <p className="muted">
          记录当前浏览器中的本地交互事件，不会上传到外部服务。
        </p>
        <div className="metrics">
          <div className="metric">
            <strong>{generated.size}</strong>
            <span>生成的有效方案</span>
          </div>
          <div className="metric">
            <strong>{accepted.size}</strong>
            <span>接受的不同方案</span>
          </div>
          <div className="metric">
            <strong>
              {generated.size
                ? percentage(accepted.size / generated.size)
                : "—"}
            </strong>
            <span>方案接受率</span>
          </div>
        </div>
      </div>
      <div className="info-note">
        <b>人工评估</b>
        <p>
          请使用 SoftEvaluation 结构，从 1–5
          分别评价相关性、个性化、合理性、偏好匹配度和解释质量。实时模型对比会使用同一组场景和校验器。
        </p>
      </div>
    </div>
  );
}
