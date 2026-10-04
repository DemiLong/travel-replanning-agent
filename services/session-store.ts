"use client";

import {
  RealSessionSchema,
  SnapshotSchema,
  type FlowStage,
  type ParsedUserInput,
  type RealSession,
  type Snapshot,
} from "../types";
import {
  legacyFallbackSnapshotKey,
  legacyRealSessionBackupKey,
  legacyRealSessionKey,
  legacyRealSessionV3BackupKey,
  legacyRealSessionV3Key,
  legacySnapshotKey,
  realSessionKey,
  type BrowserSessionRepository,
} from "./browser-session-repository";
import {
  createStarterSession,
  migrateLegacySnapshotValue,
  migrateV2SessionValue,
  migrateV3SessionValue,
  parseCurrentSessionValue,
  repairCurrentSession,
} from "./legacy-session-migration";

const SESSION_CLOCK_REFRESH_MS = 10 * 60 * 1_000;

export type SessionPatch = Partial<Omit<RealSession, "snapshot">> & {
  snapshot?: never;
};

export interface SessionStore {
  loadPersisted(): RealSession;
  loadSession(): RealSession;
  updateSession(patch: SessionPatch): RealSession;
  updateSessionAtRevision(
    patch: SessionPatch,
    expectedRevision: number,
    conflictMessage: string,
  ): RealSession;
  commitSnapshot(next: Snapshot, expectedRevision: number): RealSession;
  saveFlowDraft(
    rawInput: string,
    parsedInput: ParsedUserInput | null,
    flowStage: FlowStage,
  ): RealSession;
}

function refreshSessionClock(session: RealSession): RealSession {
  const captured = Date.parse(session.snapshot.state.stateCapturedAt);
  const stale =
    !Number.isFinite(captured) ||
    Date.now() - captured > SESSION_CLOCK_REFRESH_MS;
  if (session.snapshot.stateSources.currentTime === "user" && !stale)
    return session;
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return RealSessionSchema.parse({
    ...session,
    snapshot: {
      ...session.snapshot,
      state: {
        ...session.snapshot.state,
        currentTime,
        stateCapturedAt: now.toISOString(),
      },
      stateSources: { ...session.snapshot.stateSources, currentTime: "system" },
    },
  });
}

export function createSessionStore(
  repository: BrowserSessionRepository,
): SessionStore {
  const writeMigrated = (session: RealSession) => {
    repository.writeJson(realSessionKey, session);
    return session;
  };

  const migrateLegacySession = () => {
    const rawUser = repository.readRaw(legacySnapshotKey);
    const legacy = repository.readRaw(legacyFallbackSnapshotKey);
    const candidate = rawUser ?? legacy;
    if (candidate) {
      try {
        const migrated = migrateLegacySnapshotValue(JSON.parse(candidate));
        if (migrated) return writeMigrated(migrated);
      } catch {
        // Invalid legacy data is ignored instead of contaminating a new session.
      }
    }
    return writeMigrated(createStarterSession());
  };

  const migrateOlderSession = () => {
    const v3 = repository.readRaw(legacyRealSessionV3Key);
    if (v3) {
      repository.writeRaw(legacyRealSessionV3BackupKey, v3);
      try {
        const migrated = migrateV3SessionValue(JSON.parse(v3));
        if (migrated) return writeMigrated(migrated);
      } catch {
        // The exact v3 payload remains backed up before fallback continues.
      }
    }
    const v2 = repository.readRaw(legacyRealSessionKey);
    if (v2) {
      repository.writeRaw(legacyRealSessionBackupKey, v2);
      try {
        const migrated = migrateV2SessionValue(JSON.parse(v2));
        if (migrated) return writeMigrated(migrated);
      } catch {
        // The exact v2 payload remains backed up before fallback continues.
      }
    }
    return migrateLegacySession();
  };

  const loadPersisted = (): RealSession => {
    const raw = repository.readRaw(realSessionKey);
    if (!raw) return migrateOlderSession();
    try {
      const parsed = parseCurrentSessionValue(JSON.parse(raw));
      const repaired = repairCurrentSession(parsed);
      if (repaired.shouldPersist) writeMigrated(repaired.session);
      return repaired.session;
    } catch {
      return migrateOlderSession();
    }
  };

  const persistSession = (value: RealSession): RealSession => {
    const session = RealSessionSchema.parse({
      ...value,
      experienceMode: "real",
      snapshot: { ...value.snapshot, mode: "user" },
      updatedAt: new Date().toISOString(),
    });
    repository.writeJson(realSessionKey, session);
    return session;
  };

  const updateSession = (patch: SessionPatch) =>
    persistSession({ ...loadPersisted(), ...patch });

  return {
    loadPersisted,
    loadSession: () => refreshSessionClock(loadPersisted()),
    updateSession,
    updateSessionAtRevision(patch, expectedRevision, conflictMessage) {
      const session = loadPersisted();
      if (session.snapshot.revision !== expectedRevision)
        throw new Error(conflictMessage);
      return persistSession({ ...session, ...patch });
    },
    commitSnapshot(next, expectedRevision) {
      const snapshot = SnapshotSchema.parse({ ...next, mode: "user" });
      const session = loadPersisted();
      if (session.snapshot.revision !== expectedRevision)
        throw new Error("另一个标签页修改了你的行程，请刷新后再保存。");
      if (snapshot.revision !== expectedRevision + 1)
        throw new Error("行程版本不连续，请刷新后再保存。");
      return persistSession({
        ...session,
        snapshot: { ...snapshot, mode: "user" },
      });
    },
    saveFlowDraft: (rawInput, parsedInput, flowStage) =>
      updateSession({ rawInput, parsedInput, flowStage }),
  };
}
