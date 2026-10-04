import assert from "node:assert/strict";
import { createStarterSnapshot } from "../data/session-defaults";
import {
  commitSnapshot,
  createItineraryDraft,
  realSessionKey,
  saveItineraryDraft,
  updateSession,
} from "../services/trip-service";
import { RealSessionSchema, SnapshotSchema, type RealSession } from "../types";

function createStorage() {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  } satisfies Storage;
}

function session(): RealSession {
  const snapshot = SnapshotSchema.parse({
    ...createStarterSnapshot(),
    state: {
      ...createStarterSnapshot().state,
      currentTime: "08:30",
      stateCapturedAt: "2020-01-01T00:00:00.000Z",
    },
    revision: 0,
  });
  return RealSessionSchema.parse({
    schemaVersion: 4,
    experienceMode: "real",
    flowStage: "NO_ITINERARY",
    snapshot,
    rawInput: "尚未提交的输入",
    parsedInput: null,
    lastDisruption: null,
    pendingPlan: null,
    resolutionState: {
      currentBlockerKey: null,
      sameBlockerCount: 0,
      roundCount: 0,
      answeredFields: [],
      questionHistory: [],
    },
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
}

function stored(storage: Storage): RealSession {
  return RealSessionSchema.parse(JSON.parse(storage.getItem(realSessionKey) ?? "null"));
}

function seed(storage: Storage, value: RealSession) {
  storage.setItem(realSessionKey, JSON.stringify(value));
}

function main() {
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

  const original = session();
  seed(storage, original);

  updateSession({ rawInput: "更新后的输入" });
  assert.deepEqual(stored(storage).snapshot, original.snapshot, "transient updates must not persist the refreshed display clock");

  const staleDraft = createItineraryDraft(original);
  const firstCommit = SnapshotSchema.parse({ ...original.snapshot, revision: 1 });
  const committed = commitSnapshot(firstCommit, 0);
  assert.equal(committed.snapshot.revision, 1);
  assert.equal(stored(storage).snapshot.revision, 1);

  const afterFirstCommit = storage.getItem(realSessionKey);
  assert.throws(
    () => commitSnapshot(SnapshotSchema.parse({ ...firstCommit, revision: 3 }), 1),
    /版本不连续/,
  );
  assert.equal(storage.getItem(realSessionKey), afterFirstCommit, "a revision gap must not change storage");

  assert.throws(
    () => commitSnapshot(SnapshotSchema.parse({ ...original.snapshot, revision: 1 }), 0),
    /另一个标签页修改了你的行程/,
  );
  assert.equal(storage.getItem(realSessionKey), afterFirstCommit, "a stale writer must not change storage");

  assert.throws(
    () => saveItineraryDraft(staleDraft),
    /行程已在其他页面更新/,
  );
  assert.equal(stored(storage).snapshot.revision, 1, "a stale draft must not overwrite the committed snapshot");

  const stalePendingPlanCommit = SnapshotSchema.parse({ ...original.snapshot, revision: 1 });
  assert.throws(
    () => commitSnapshot(stalePendingPlanCommit, original.snapshot.revision),
    /另一个标签页修改了你的行程/,
  );
  assert.equal(stored(storage).snapshot.revision, 1, "a plan based on a stale snapshot must not be accepted");

  if (false) {
    // @ts-expect-error snapshot writes must go through commitSnapshot
    updateSession({ snapshot: original.snapshot });
  }

  console.log("Session state boundary tests passed.");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
