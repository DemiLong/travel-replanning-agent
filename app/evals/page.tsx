import { EvalDashboard } from "@/components/eval-dashboard";
import { notFound } from "next/navigation";

export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <EvalDashboard />;
}
