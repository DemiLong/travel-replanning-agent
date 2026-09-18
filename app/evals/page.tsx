import { EvalDashboard } from "@/components/eval-dashboard";
import report from "@/data/eval-report.json";
import { notFound } from "next/navigation";

export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <EvalDashboard report={report} />;
}
