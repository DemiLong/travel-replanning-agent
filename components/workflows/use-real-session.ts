"use client";

import { useEffect, useState } from "react";
import { loadSession } from "@/services/trip-service";
import type { RealSession } from "@/types";
import { errorText } from "./assist-client";

export function useRealSession() {
  const [session, setSession] = useState<RealSession | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        setSession(loadSession());
      } catch (cause) {
        setError(errorText(cause));
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);
  return { session, setSession, error, setError };
}
