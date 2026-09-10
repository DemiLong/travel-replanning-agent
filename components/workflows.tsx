"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Check,
  ShieldCheck,
  LockKeyhole,
  LoaderCircle,
  RotateCcw,
  ArrowLeft,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Timeline } from "./travel-app";
import { demo } from "@/data/demo";
import { places } from "@/data/places";
import { districts } from "@/services/place-service";
import {
  getConfig,
  loadTrip,
  saveTrip,
  localTrip,
  logEvent,
  recordResult,
  requestHeaders,
} from "@/services/trip-service";
import {
  SnapshotSchema,
  ReplanningRequestSchema,
  ProposedPlanSchema,
  AgentResultSchema,
  type Snapshot,
  type AgentResult,
  type ReplanningRequest,
  type UserProfile,
} from "@/types";

export function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          aria-label={label}
          className="w-full h-12 bg-white text-sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
const options = (values: readonly string[]) =>
  values.map((value) => ({
    value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
  }));
const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";
const reasonLabels = {
  late: "I’m running late",
  weather: "Weather changed",
  tired: "I’m tired",
  closed: "A place is closed",
  discovery: "I found somewhere new",
  changed_mind: "I changed my mind",
  other: "Other",
};
type SavedResult = {
  result: AgentResult;
  base: Snapshot;
  request: ReplanningRequest;
  accepted: boolean;
};

export function Workflow({ page }: { page: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    loadTrip()
      .then(setSnapshot)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  if (error)
    return (
      <div className="workspace narrow">
        <h1>Let’s get your day back.</h1>
        <div role="alert" className="error-box">
          {error}
        </div>
        <button className="secondary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!snapshot)
    return (
      <div className="workspace busy" role="status">
        <LoaderCircle />
        Loading your trip…
      </div>
    );
  return page === "onboarding" ? (
    <Onboarding snapshot={snapshot} />
  ) : page === "replan" ? (
    <ReplanForm snapshot={snapshot} />
  ) : (
    <Result />
  );
}

function Onboarding({ snapshot }: { snapshot: Snapshot }) {
  const [profile, setProfile] = useState(snapshot.profile),
    [trip, setTrip] = useState(snapshot.trip),
    [dislikes, setDislikes] = useState(profile.dislikes.join(", ")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editing =
    typeof window !== "undefined" &&
    Boolean(localStorage.getItem("travel-snapshot"));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const spent = snapshot.itinerary
        .filter((e) => e.status === "completed")
        .reduce((s, e) => s + e.estimatedCost, 0);
      if (profile.dailyBudget < spent)
        throw new Error(
          `Today’s completed stops already cost ฿${spent}. Set a daily budget at least this high.`,
        );
      if (
        editing &&
        (trip.startDate > snapshot.state.currentDate ||
          trip.endDate < snapshot.state.currentDate)
      )
        throw new Error(
          "Your travel dates must include the current itinerary date.",
        );
      const next = SnapshotSchema.parse({
        ...snapshot,
        profile: {
          ...profile,
          dislikes: dislikes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
        trip,
        state: {
          ...snapshot.state,
          currentDate: editing ? snapshot.state.currentDate : trip.startDate,
          remainingBudget: Math.max(0, profile.dailyBudget - spent),
        },
        revision: snapshot.revision + 1,
      });
      await saveTrip(next, snapshot.revision);
      await logEvent(editing ? "preference_saved" : "trip_created", {
        tripId: trip.id,
      });
      localStorage.removeItem("travel-result");
      location.href = "/trip";
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace narrow">
      <div className="page-heading">
        <div>
          <span className="eyebrow">MAKE ROOM FOR WHAT YOU LOVE</span>
          <h1>Your kind of travel.</h1>
          <p>A few preferences help keep a change of plans feeling like you.</p>
        </div>
      </div>
      <form className="card form-card" onSubmit={submit}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="city">Destination</label>
            <input id="city" value="Bangkok" readOnly />
            <small className="muted">Bangkok is the first demo city.</small>
          </div>
          <div className="field">
            <label htmlFor="budget">Daily budget · THB</label>
            <input
              required
              id="budget"
              type="number"
              min="0"
              max="100000"
              value={profile.dailyBudget}
              onChange={(e) =>
                setProfile({ ...profile, dailyBudget: Number(e.target.value) })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="start">Trip starts</label>
            <input
              required
              id="start"
              type="date"
              value={trip.startDate}
              onChange={(e) => setTrip({ ...trip, startDate: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="end">Trip ends</label>
            <input
              required
              id="end"
              type="date"
              min={trip.startDate}
              value={trip.endDate}
              onChange={(e) => setTrip({ ...trip, endDate: e.target.value })}
            />
          </div>
          <Choice
            label="Travel pace"
            value={profile.travelPace}
            onChange={(v) =>
              setProfile({
                ...profile,
                travelPace: v as UserProfile["travelPace"],
              })
            }
            options={options(["relaxed", "balanced", "packed"])}
          />
          <Choice
            label="Walking tolerance"
            value={profile.walkingTolerance}
            onChange={(v) =>
              setProfile({
                ...profile,
                walkingTolerance: v as UserProfile["walkingTolerance"],
              })
            }
            options={options(["low", "medium", "high"])}
          />
          <div className="field field-wide">
            <span>Your interests</span>
            <div className="interest-grid">
              {[
                "food",
                "coffee",
                "shopping",
                "markets",
                "museums",
                "culture",
                "nightlife",
                "nature",
                "local neighborhoods",
              ].map((interest) => (
                <label key={interest} className="interest">
                  <Checkbox
                    checked={profile.interests.includes(interest)}
                    onCheckedChange={(checked) =>
                      setProfile({
                        ...profile,
                        interests: checked
                          ? [...profile.interests, interest]
                          : profile.interests.filter((i) => i !== interest),
                      })
                    }
                  />
                  {interest}
                </label>
              ))}
            </div>
          </div>
          <div className="field field-wide">
            <label htmlFor="dislikes">Anything you’d rather skip?</label>
            <input
              id="dislikes"
              maxLength={1200}
              value={dislikes}
              onChange={(e) => setDislikes(e.target.value)}
              placeholder="Packed schedules, shopping… (separate with commas)"
            />
          </div>
          {profile.preferences.length > 0 && (
            <div className="field field-wide">
              <span>Remembered preferences</span>
              {profile.preferences.map((p) => (
                <div className="success-box" key={p}>
                  {p}
                </div>
              ))}
            </div>
          )}
        </div>
        {error && (
          <div role="alert" className="error-box">
            {error}
          </div>
        )}
        <div className="form-actions">
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save preferences" : "Create my trip"}
            <ArrowRight size={18} />
          </button>
          <Link className="secondary" href="/trip">
            Back to my day
          </Link>
        </div>
        <p className="small-note">
          Demo itinerary · Preferences persist in this browser; cloud storage
          when configured.
        </p>
      </form>
    </div>
  );
}

function ReplanForm({ snapshot }: { snapshot: Snapshot }) {
  const [request, setRequest] = useState<ReplanningRequest>({
    reason: "tired",
    freeText: "It's 3 PM, I'm tired and it's raining.",
    currentState: snapshot.state,
    closedPlaceIds: [],
    variation: 0,
  });
  const [mode, setMode] = useState<"demo" | "live">("demo"),
    [live, setLive] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    getConfig()
      .then((c) => setLive(c.liveAvailable))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const state = request.currentState;
  function stateChange(key: string, value: unknown) {
    setRequest({ ...request, currentState: { ...state, [key]: value } });
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const parsed = ReplanningRequestSchema.parse(request);
      if (parsed.reason === "closed" && !parsed.closedPlaceIds.length)
        throw new Error(
          "Select the place that is closed so we can exclude it.",
        );
      await logEvent("replan_started", { mode, tripId: snapshot.trip.id });
      const response = await fetch("/api/replan", {
        method: "POST",
        headers: await requestHeaders(),
        body: JSON.stringify({ snapshot, request: parsed, mode }),
        signal: AbortSignal.timeout(90000),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "Could not generate a plan.");
      const result = AgentResultSchema.parse(body);
      if (result.plan) ProposedPlanSchema.parse(result.plan);
      await recordResult(result);
      localStorage.setItem(
        "travel-result",
        JSON.stringify({
          result,
          base: snapshot,
          request: parsed,
          accepted: false,
        } satisfies SavedResult),
      );
      location.href = "/result";
    } catch (e) {
      setError(
        e instanceof Error && e.name === "TimeoutError"
          ? "Planning took too long. Please retry or use Demo mode."
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">A CHANGE OF PLANS, NOT A LOST DAY</span>
          <h1>What changed?</h1>
          <p>Tell us where you’re at. We’ll take it from here.</p>
        </div>
        <Link className="secondary" href="/trip">
          <ArrowLeft size={16} />
          My day
        </Link>
      </div>
      <div className="trip-grid">
        <form onSubmit={submit} className="card form-card">
          <fieldset
            disabled={busy}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <div className="field">
              <span id="disruption-label">What’s happening?</span>
              <RadioGroup
                aria-labelledby="disruption-label"
                className="reason-options"
                value={request.reason}
                onValueChange={(v) =>
                  setRequest({
                    ...request,
                    reason: v as ReplanningRequest["reason"],
                  })
                }
              >
                {Object.entries(reasonLabels).map(([value, label]) => (
                  <label key={value} className="reason-option">
                    <RadioGroupItem value={value} />
                    {label}
                  </label>
                ))}
              </RadioGroup>
            </div>
            <div className="field" style={{ marginTop: 22 }}>
              <label htmlFor="description">In your own words</label>
              <textarea
                id="description"
                maxLength={2000}
                value={request.freeText}
                onChange={(e) =>
                  setRequest({ ...request, freeText: e.target.value })
                }
              />
              <small className="muted">
                Set time, weather and energy below as well. These fields are the
                source of truth.
              </small>
            </div>
            {request.reason === "closed" && (
              <div className="field" style={{ marginTop: 20 }}>
                <span>Which places are closed?</span>
                <div className="interest-grid">
                  {places.map((p) => (
                    <label className="interest" key={p.id}>
                      <Checkbox
                        checked={request.closedPlaceIds.includes(p.id)}
                        onCheckedChange={(checked) =>
                          setRequest({
                            ...request,
                            closedPlaceIds: checked
                              ? [...request.closedPlaceIds, p.id]
                              : request.closedPlaceIds.filter(
                                  (id) => id !== p.id,
                                ),
                          })
                        }
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="form-grid" style={{ marginTop: 24 }}>
              <div className="field">
                <label htmlFor="current-time">Current time · Bangkok</label>
                <input
                  required
                  id="current-time"
                  type="time"
                  value={state.currentTime}
                  onChange={(e) => stateChange("currentTime", e.target.value)}
                />
              </div>
              <Choice
                label="Current location"
                value={state.currentLocation}
                onChange={(v) => stateChange("currentLocation", v)}
                options={options(districts)}
              />
              <Choice
                label="Energy level"
                value={state.energyLevel}
                onChange={(v) => stateChange("energyLevel", v)}
                options={options(["low", "medium", "high"])}
              />
              <Choice
                label="Weather"
                value={state.weather}
                onChange={(v) => stateChange("weather", v)}
                options={options(["rain", "sunny", "hot"])}
              />
              <div className="field">
                <label htmlFor="remaining-budget">Remaining budget · THB</label>
                <input
                  required
                  id="remaining-budget"
                  type="number"
                  min="0"
                  max="100000"
                  value={state.remainingBudget}
                  onChange={(e) =>
                    stateChange("remainingBudget", Number(e.target.value))
                  }
                />
              </div>
              <Choice
                label="Planning mode"
                value={mode}
                onChange={(v) => setMode(v as "demo" | "live")}
                options={[
                  { value: "demo", label: "Demo · simulated planner" },
                  ...(live
                    ? [{ value: "live", label: "Live · OpenAI planner" }]
                    : []),
                ]}
              />
            </div>
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            <div className="form-actions">
              <button className="primary full" disabled={busy}>
                {busy ? (
                  <>
                    <LoaderCircle size={18} />
                    Checking a new direction…
                  </>
                ) : (
                  <>
                    Replan my day
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </div>
          </fieldset>
          {busy && (
            <div className="busy" role="status">
              Reading your trip → proposing a plan → checking constraints.
              <br />
              Up to two corrections if needed.
            </div>
          )}
        </form>
        <aside>
          <div className="state-card">
            <LockKeyhole size={25} />
            <h2 style={{ fontSize: 23, marginTop: 16 }}>
              The important things stay.
            </h2>
            <p style={{ marginTop: 16, fontSize: 14 }}>
              Your locked reservations keep their original time and place. Every
              proposed plan is checked before you see it.
            </p>
            {snapshot.itinerary
              .filter((e) => e.locked && e.status !== "completed")
              .map((e) => (
                <div className="reservation-note" key={e.id}>
                  <LockKeyhole size={17} />
                  <div>
                    <b>
                      {e.startTime} · {e.name}
                    </b>
                    <p>
                      {e.location} · ฿{e.estimatedCost}
                    </p>
                  </div>
                </div>
              ))}
          </div>
          <div className="demo-note">
            <b>
              {mode === "demo" ? "Simulated planner" : "Live OpenAI planner"} ·
              Demo data
            </b>
            <p>
              {mode === "demo"
                ? "No model call is made in Demo mode. Choices use the selected state and preferences; free text interpretation requires Live mode."
                : "Your trip context is sent to the server-side model. Place data remains simulated."}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Result() {
  const [saved, setSaved] = useState<SavedResult | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [remember, setRemember] = useState(false),
    [preference, setPreference] = useState(
      "I like plans with more resting time.",
    ),
    [notice, setNotice] = useState("");
  useEffect(() => {
    try {
      const raw = localStorage.getItem("travel-result");
      if (raw) {
        const s = JSON.parse(raw) as SavedResult;
        SnapshotSchema.parse(s.base);
        AgentResultSchema.parse(s.result);
        ReplanningRequestSchema.parse(s.request);
        if (s.result.plan) ProposedPlanSchema.parse(s.result.plan);
        setSaved(s);
      }
    } catch {
      setError("This saved result could not be read. Please replan your day.");
    }
  }, []);
  if (!saved)
    return (
      <div className="workspace narrow">
        <h1>Your next plan starts here.</h1>
        <p className="muted" style={{ margin: "20px 0" }}>
          {error ||
            "Report a change to compare your original day with a new plan."}
        </p>
        <Link className="primary" href="/replan">
          My plans changed
          <ArrowRight size={17} />
        </Link>
      </div>
    );
  const { result, base, request, accepted } = saved,
    plan = result.plan;
  async function accept() {
    if (!saved || !plan) return;
    setBusy(true);
    setError("");
    try {
      const latest = await loadTrip();
      if (
        latest.revision !== base.revision ||
        JSON.stringify(latest) !== JSON.stringify(base)
      )
        throw new Error(
          "Your trip has changed since this plan was generated. Please replan using the latest itinerary.",
        );
      const check = await fetch("/api/validate", {
        method: "POST",
        headers: await requestHeaders(),
        body: JSON.stringify({
          snapshot: latest,
          request,
          mode: result.mode,
          plan,
        }),
      });
      const data = (await check.json()) as { ok: boolean };
      if (!check.ok || !data.ok)
        throw new Error(
          "This plan no longer passes the constraints. Please generate a fresh plan.",
        );
      const next = {
        ...latest,
        state: request.currentState,
        itinerary: [
          ...latest.itinerary.filter((e) => e.status === "completed"),
          ...plan.events,
        ],
        revision: latest.revision + 1,
      };
      await saveTrip(next, latest.revision);
      const updated = { ...saved, accepted: true };
      localStorage.setItem("travel-result", JSON.stringify(updated));
      setSaved(updated);
      await logEvent(
        "replan_accepted",
        { planId: result.id, mode: result.mode },
        `${result.id}-accepted`,
      );
      setNotice("Plan accepted. Your day is updated.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function another() {
    if (!saved) return;
    setBusy(true);
    setError("");
    try {
      await logEvent(
        "replan_rejected",
        { planId: result.id, mode: result.mode },
        `${result.id}-rejected`,
      );
      const latest = await loadTrip();
      const nextRequest = {
        ...request,
        variation: Math.min(100, request.variation + 1),
      };
      await logEvent("replan_started", { mode: result.mode });
      const response = await fetch("/api/replan", {
        method: "POST",
        headers: await requestHeaders(),
        body: JSON.stringify({
          snapshot: latest,
          request: nextRequest,
          mode: result.mode,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error);
      const next = AgentResultSchema.parse(body);
      if (next.plan) ProposedPlanSchema.parse(next.plan);
      await recordResult(next);
      const updated = {
        result: next,
        base: latest,
        request: nextRequest,
        accepted: false,
      };
      localStorage.setItem("travel-result", JSON.stringify(updated));
      setSaved(updated);
      setNotice("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function savePreference() {
    setBusy(true);
    setError("");
    try {
      if (!preference.trim())
        throw new Error("Write a preference to remember.");
      const latest = await loadTrip();
      await saveTrip(
        {
          ...latest,
          profile: {
            ...latest.profile,
            preferences: [
              ...new Set([...latest.profile.preferences, preference.trim()]),
            ],
          },
          revision: latest.revision + 1,
        },
        latest.revision,
      );
      await logEvent("preference_saved", { planId: result.id });
      setRemember(false);
      setNotice("Preference remembered for your next replan.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {result.mode === "demo" ? "SIMULATED PLANNER" : "OPENAI PLANNER"} ·
            DEMO PLACE DATA
          </span>
          <h1>{result.ok ? plan?.summary : "Let’s adjust the constraints."}</h1>
          <p>
            {result.ok
              ? "A thoughtful change of direction, with your dinner right where it belongs."
              : result.message}
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" className="error-box">
          {error}
        </div>
      )}
      {notice && (
        <div className="success-box" role="status">
          <Check size={18} style={{ display: "inline", marginRight: 10 }} />
          {notice}
        </div>
      )}
      {!result.ok ? (
        <>
          <div className="error-box">
            <b>No invalid plan has been applied.</b>
            <ul>
              {[
                ...new Set(
                  result.attempts.flatMap((a) =>
                    a.violations.map((v) => v.message),
                  ),
                ),
              ].map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
          <Link href="/replan" className="primary">
            Adjust time, budget or state
            <ArrowRight size={16} />
          </Link>
        </>
      ) : (
        plan && (
          <>
            <div
              className="success-box"
              style={{ display: "flex", gap: 12, alignItems: "center" }}
            >
              <ShieldCheck size={23} />
              <div>
                <b>All hard constraints passed</b>
                <p style={{ fontSize: 13 }}>
                  Reservations · No overlaps · Transfers · Opening hours ·
                  Budget · Future times
                </p>
              </div>
            </div>
            <div className="compare-grid">
              <section className="card">
                <div className="card-heading">
                  <h2>Before</h2>
                  <span>Original remaining day</span>
                </div>
                <Timeline
                  events={base.itinerary.filter(
                    (e) => e.status !== "completed",
                  )}
                  compact
                />
              </section>
              <section className="card">
                <div className="card-heading">
                  <h2>After</h2>
                  <span>
                    ฿{plan.events.reduce((s, e) => s + e.estimatedCost, 0)} / ฿
                    {request.currentState.remainingBudget}
                  </span>
                </div>
                <Timeline events={plan.events} />
              </section>
            </div>
            <div className="change-list">
              {plan.movedEvents.map((e) => (
                <div key={e.eventId}>
                  <b>
                    {e.name} → {e.suggestedDate}, {e.suggestedStart}
                  </b>
                  <p>{e.reason}</p>
                  <p>
                    {e.constraint} · {e.note}
                  </p>
                </div>
              ))}
              {plan.removedEvents.map((e) => (
                <div key={e.eventId}>
                  <b>{e.name} · Removed from today</b>
                  <p>{e.reason}</p>
                  <p>{e.constraint}</p>
                </div>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 22 }}>
              {plan.explanation}
            </p>
            {!accepted ? (
              <div className="form-actions">
                <button disabled={busy} className="primary" onClick={accept}>
                  {busy ? "Working…" : "Accept plan"}
                  <Check size={17} />
                </button>
                <button disabled={busy} className="secondary" onClick={another}>
                  <RotateCcw size={16} />
                  Try another plan
                </button>
                <Link href="/onboarding" className="secondary">
                  Adjust preferences
                </Link>
              </div>
            ) : (
              <>
                <div className="form-actions">
                  <Link href="/trip" className="primary">
                    Back to my updated day
                    <ArrowRight size={17} />
                  </Link>
                  <button
                    className="secondary"
                    onClick={() => setRemember(!remember)}
                  >
                    Remember this preference
                  </button>
                </div>
                {remember && (
                  <div className="card form-card" style={{ marginTop: 20 }}>
                    <div className="field">
                      <label htmlFor="memory">
                        What should future plans remember?
                      </label>
                      <input
                        id="memory"
                        value={preference}
                        maxLength={300}
                        onChange={(e) => setPreference(e.target.value)}
                      />
                    </div>
                    <button
                      style={{ marginTop: 15 }}
                      className="primary"
                      disabled={busy}
                      onClick={savePreference}
                    >
                      Save preference
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )
      )}
      <details className="audit">
        <summary>
          Planning & validation details · {result.attempts.length} attempt
          {result.attempts.length === 1 ? "" : "s"}
        </summary>
        <p>
          {result.model} ·{" "}
          {result.mode === "demo"
            ? "Deterministic simulation; not evidence of model quality."
            : "Live model output verified by code."}
        </p>
        <pre>
          {JSON.stringify(
            { attempts: result.attempts, context: result.context },
            null,
            2,
          )}
        </pre>
      </details>
      <p className="small-note">
        Demo hours, costs and district travel estimates. Moved activities are
        suggestions only.
      </p>
    </div>
  );
}
