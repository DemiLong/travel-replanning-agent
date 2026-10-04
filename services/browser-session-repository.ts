"use client";

export const realSessionKey = "travel-session-real-v4";
export const legacyRealSessionV3Key = "travel-session-real-v3";
export const legacyRealSessionV3BackupKey = "travel-session-real-v3-backup";
export const legacyRealSessionKey = "travel-session-real-v2";
export const legacyRealSessionBackupKey = "travel-session-real-v2-backup";
export const legacySnapshotKey = "travel-snapshot-user";
export const legacyFallbackSnapshotKey = "travel-snapshot";

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

export interface BrowserSessionRepository {
  readRaw(key: string): string | null;
  writeRaw(key: string, value: string): void;
  readJson(key: string): unknown | null;
  writeJson(key: string, value: unknown): void;
}

export function createBrowserSessionRepository(
  storage?: BrowserStorage,
): BrowserSessionRepository {
  const target = () => storage ?? localStorage;
  return {
    readRaw(key) {
      return target().getItem(key);
    },
    writeRaw(key, value) {
      target().setItem(key, value);
    },
    readJson(key) {
      const raw = target().getItem(key);
      return raw === null ? null : JSON.parse(raw);
    },
    writeJson(key, value) {
      target().setItem(key, JSON.stringify(value));
    },
  };
}
