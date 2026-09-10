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
import type { runEvals } from "@/evals/harness";
import type { AnalyticsEvent } from "@/services/trip-service";
type Report = typeof import("../data/eval-report.json");
const percentage = (n: number) => `${(n * 100).toFixed(1)}%`;
export function EvalDashboard({ report }: { report: Report }) {
  const [analytics, setAnalytics] = useState<AnalyticsEvent[]>([]);
  useEffect(() => {
    try {
      setAnalytics(
        JSON.parse(localStorage.getItem("travel-analytics") ?? "[]"),
      );
    } catch {}
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
  return (
    <div className="workspace">
      <Link className="text-link" href="/trip">
        <ArrowLeft size={15} /> Back to my day
      </Link>
      <div className="page-heading" style={{ marginTop: 30 }}>
        <div>
          <span className="eyebrow">AGENT EVALUATION · PORTFOLIO VIEW</span>
          <h1>Trust is a constraint.</h1>
          <p>32 synthetic scenarios. Clear rules. Measurable outcomes.</p>
        </div>
      </div>
      <div className="success-box">
        <ShieldCheck style={{ display: "inline", marginRight: 10 }} />
        <b>Demo planner benchmark</b>
        <p>
          This report tests deterministic simulation and the validation loop. It
          does not measure live OpenAI quality. Five cases are deliberately
          impossible and should be refused.
        </p>
      </div>
      <div className="metrics">
        <div className="metric">
          <strong>{percentage(report.scenarioPassRate)}</strong>
          <span>Expected outcomes · {report.total} cases</span>
        </div>
        <div className="metric">
          <strong>{percentage(report.hardConstraintPassRate)}</strong>
          <span>Valid plans / all scenarios</span>
        </div>
        <div className="metric">
          <strong>{percentage(report.feasibleCasePassRate)}</strong>
          <span>Valid plans / feasible scenarios</span>
        </div>
      </div>
      <div className="card form-card">
        <h2>Attempt-level violation rates</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          Includes rejected candidates and retries, including intentionally
          impossible scenarios.
        </p>
        <div className="metrics">
          {Object.entries(report.violationRates).map(([code, rate]) => (
            <div className="metric" key={code}>
              <strong>{percentage(rate)}</strong>
              <span>{code.replaceAll("_", " ")}</span>
            </div>
          ))}
        </div>
        <p className="muted">
          Average regenerations per case:{" "}
          {report.averageRegenerationCount.toFixed(2)} · Model: {report.model}
        </p>
      </div>
      <div className="card" style={{ marginTop: 25, overflow: "hidden" }}>
        <div className="card-heading">
          <h2>Scenario results</h2>
          <span>Run {report.generatedAt.slice(0, 10)}</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead>Scenario</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Attempts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.results.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.id}</TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell>
                  {r.expectedFeasible ? "Valid plan" : "Safe refusal"}
                </TableCell>
                <TableCell>
                  <span className="badge">{r.pass ? "Pass" : "Fail"}</span>
                </TableCell>
                <TableCell>{r.attempts.length}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="card form-card" style={{ marginTop: 25 }}>
        <h2>Your demo session</h2>
        <p className="muted">
          Browser-local interaction events; cloud copies are written to Supabase
          when configured.
        </p>
        <div className="metrics">
          <div className="metric">
            <strong>{generated.size}</strong>
            <span>Valid plans generated</span>
          </div>
          <div className="metric">
            <strong>{accepted.size}</strong>
            <span>Unique plans accepted</span>
          </div>
          <div className="metric">
            <strong>
              {generated.size
                ? percentage(accepted.size / generated.size)
                : "—"}
            </strong>
            <span>Plan acceptance rate</span>
          </div>
        </div>
      </div>
      <div className="demo-note">
        <b>Human evaluation</b>
        <p>
          Score relevance, personalization, reasonableness, preference alignment
          and explanation quality from 1–5 using the supplied SoftEvaluation
          schema. Live model comparison runs use the same cases and validators.
        </p>
      </div>
    </div>
  );
}
