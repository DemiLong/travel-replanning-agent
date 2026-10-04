"use client";

import { HomeFlow } from "./workflows/home-flow";
import { MineFlow } from "./workflows/mine-flow";
import { OnboardingFlow } from "./workflows/onboarding-flow";
import { RescueFlow } from "./workflows/rescue-flow";
import { ResultFlow } from "./workflows/result-flow";
import { TripFlow } from "./workflows/trip-flow";

export { HomeFlow } from "./workflows/home-flow";
export { MineFlow } from "./workflows/mine-flow";
export { OnboardingFlow } from "./workflows/onboarding-flow";
export { RescueFlow } from "./workflows/rescue-flow";
export { ResultFlow } from "./workflows/result-flow";
export { TripFlow } from "./workflows/trip-flow";

export function SessionWorkflow({ page }: { page: string }) {
  if (page === "home") return <HomeFlow />;
  if (page === "onboarding") return <OnboardingFlow />;
  if (page === "trip") return <TripFlow />;
  if (page === "rescue") return <RescueFlow />;
  if (page === "result") return <ResultFlow />;
  if (page === "me") return <MineFlow />;
  return <HomeFlow />;
}

export function Workflow({ page }: { page: string }) {
  return <SessionWorkflow page={page} />;
}

export function HomeRescue() {
  return <HomeFlow />;
}
