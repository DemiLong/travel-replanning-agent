import { EvalDashboard } from "@/components/eval-dashboard";
import report from "@/data/eval-report.json";
export default function Page() {
  return <EvalDashboard report={report} />;
}
