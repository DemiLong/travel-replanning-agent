"use client";

export const realSessionKey = "travel-session-real-v5";

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
