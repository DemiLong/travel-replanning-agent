"use client";

import { useSyncExternalStore } from "react";
import {
  getAuthStateSnapshot,
  subscribeAuthState,
  type AuthStateSnapshot,
} from "@/services/api-client";

export function useAuthState(): AuthStateSnapshot {
  return useSyncExternalStore(
    subscribeAuthState,
    getAuthStateSnapshot,
    getAuthStateSnapshot,
  );
}
