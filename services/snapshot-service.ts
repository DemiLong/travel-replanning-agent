import type { RealSession, Snapshot } from "../types";
import type { SessionStore } from "./session-store";

export type TripMode = Snapshot["mode"];
export const resultKey = (mode: TripMode) => `travel-result-${mode}`;

export function activeTripMode(): TripMode {
  return "user";
}

export interface SnapshotService {
  commitSnapshot(next: Snapshot, expectedRevision: number): RealSession;
  localTrip(): Snapshot;
  loadTrip(): Promise<Snapshot>;
}

export function createSnapshotService(store: SessionStore): SnapshotService {
  const localTrip = () => store.loadSession().snapshot;
  return {
    commitSnapshot: (next, expectedRevision) =>
      store.commitSnapshot(next, expectedRevision),
    localTrip,
    loadTrip: async () => localTrip(),
  };
}
