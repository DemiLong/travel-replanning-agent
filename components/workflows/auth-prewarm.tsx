"use client";

import { useEffect } from "react";
import { prewarmAnonymousSession } from "@/services/api-client";

/**
 * Establishes the anonymous session as soon as the app loads so the first
 * user action never has to wait for (or fail on) the sign-in round trip.
 */
export function AuthPrewarm() {
  useEffect(() => {
    const controller = new AbortController();
    prewarmAnonymousSession(controller.signal).catch(() => {
      // The failure is captured in the auth state; the UI offers a manual retry.
    });
    return () => {
      controller.abort();
    };
  }, []);
  return null;
}
