import type { RealSession, Snapshot } from "../types";
import type { SessionStore } from "./session-store";

export interface SnapshotService {
  commitSnapshot(next: Snapshot, expectedRevision: number): RealSession;
}

export function createSnapshotService(store: SessionStore): SnapshotService {
  return {
    commitSnapshot: (next, expectedRevision) =>
      store.commitSnapshot(next, expectedRevision),
  };
}
