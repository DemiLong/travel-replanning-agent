"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  MapPin,
  CloudRain,
  Clock3,
  LockKeyhole,
  Compass,
  Check,
  Footprints,
  Wallet,
  Route,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { demo } from "@/data/demo";
import { Workflow } from "./workflows";
import { loadTrip, saveTrip, logEvent } from "@/services/trip-service";
import { type Snapshot, type ItineraryEvent } from "@/types";

export function Timeline({
  events,
  compact = false,
}: {
  events: ItineraryEvent[];
  compact?: boolean;
}) {
  return (
    <div className={`timeline ${compact ? "compact" : ""}`}>
      {events.map((e) => (
        <div
          className={`event ${e.status} ${e.locked ? "protected" : ""}`}
          key={e.id}
        >
          <div className="event-time">
            {e.startTime}
            <small>{e.endTime}</small>
          </div>
          <div className="event-marker">
            {e.status === "completed" ? (
              <Check size={15} />
            ) : e.locked ? (
              <LockKeyhole size={14} />
            ) : (
              <span />
            )}
          </div>
          <div className="event-body">
            <div className="event-title">
              <h3>{e.name}</h3>
              <span className={`badge ${e.locked ? "locked" : ""}`}>
                {e.locked ? (
                  <>
                    <LockKeyhole size={12} /> Locked
                  </>
                ) : (
                  e.status
                )}
              </span>
            </div>
            <p>
              <MapPin size={13} />
              {e.location} <span>·</span> {e.indoorOutdoor} <span>·</span> ฿
              {e.estimatedCost}
            </p>
            {!compact && e.constraint !== "Original itinerary" && (
              <div className="event-reason">
                {e.reason}
                <small>{e.constraint}</small>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TravelApp({ page }: { page: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(demo);
  const [error, setError] = useState("");
  useEffect(() => {
    loadTrip()
      .then(setSnapshot)
      .catch((e) => setError(e.message));
  }, []);
  const start = async () => {
    try {
      await saveTrip(
        { ...structuredClone(demo), revision: snapshot.revision + 1 },
        snapshot.revision,
      );
      await logEvent("trip_created", { tripId: demo.trip.id, mode: "demo" });
      localStorage.removeItem("travel-result");
      window.location.href = "/trip";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the demo.");
    }
  };
  return (
    <div className="site">
      <header className="header">
        <Link className="brand" href="/">
          <span className="brand-icon">
            <Route size={24} />
          </span>
          day<span className="brand-light">shift</span>
          <span className="brand-label">TRAVEL REPLANNING</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link className={page === "trip" ? "active" : ""} href="/trip">
            My day
          </Link>
          <Link
            className={page === "onboarding" ? "active" : ""}
            href="/onboarding"
          >
            Preferences
          </Link>
          <Link href="/evals">
            Agent evals
            <ArrowUpRight size={14} />
          </Link>
        </nav>
        <span className="demo-label">
          <Compass size={14} /> Bangkok demo
        </span>
      </header>
      <main>
        {error && (
          <div className="workspace error-box" role="alert">
            {error}
          </div>
        )}
        {page === "home" ? (
          <>
            <section className="hero">
              <div className="hero-copy">
                <span className="eyebrow">A LITTLE CHANGE OF PLANS</span>
                <h1>
                  Your day changed.
                  <br />
                  <em>
                    Your trip is still
                    <br />
                    yours.
                  </em>
                </h1>
                <p>
                  Rain happens. Energy dips. Plans shift.
                  <br />
                  Find a better way to spend the rest of today—
                  <br className="desktop" />
                  without starting over.
                </p>
                <button className="primary" onClick={start}>
                  Try Bangkok Demo <ArrowRight size={18} />
                </button>
                <Link className="text-link" href="/onboarding">
                  Make it your kind of day <ArrowUpRight size={16} />
                </Link>
                <div className="hero-note">
                  <ShieldCheck size={17} /> Your reservations stay protected.
                </div>
              </div>
              <div className="hero-visual">
                <img
                  src="/bangkok-inspired.png"
                  alt="Illustration of a Bangkok-inspired riverfront at golden hour"
                />
                <div className="photo-location">
                  <MapPin size={15} /> BANGKOK · ILLUSTRATION
                </div>
                <div className="floating-plan">
                  <span className="eyebrow">15:00 · A NEW DIRECTION</span>
                  <div>
                    <CloudRain size={22} />
                    <p>
                      A rainy afternoon?
                      <strong>Let’s take it a little slower.</strong>
                    </p>
                  </div>
                  <div className="mini-change">
                    <span>Temple hopping</span>
                    <ArrowRight size={15} />
                    <b>Coffee & a little rest</b>
                  </div>
                  <footer>
                    <LockKeyhole size={13} /> 19:00 dinner · still on
                  </footer>
                </div>
              </div>
            </section>
            <div className="intro-steps">
              <div>
                <b>01</b>
                <span>Tell us what changed</span>
              </div>
              <div>
                <b>02</b>
                <span>Compare a thoughtful new plan</span>
              </div>
              <div>
                <b>03</b>
                <span>Accept. Enjoy your day.</span>
              </div>
            </div>
          </>
        ) : page === "trip" ? (
          <div className="workspace">
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  {snapshot.state.currentDate} · DEMO DATA
                </span>
                <h1>
                  A softer afternoon
                  <br />
                  in Bangkok.
                </h1>
                <p>Your plans can change. The good parts can stay.</p>
              </div>
              <button className="secondary" onClick={start}>
                <RotateCcw size={16} /> Reset demo
              </button>
            </div>
            <div className="trip-grid">
              <section className="card itinerary-card">
                <div className="card-heading">
                  <h2>Today’s itinerary</h2>
                  <span>{snapshot.itinerary.length} stops</span>
                </div>
                <Timeline events={snapshot.itinerary} />
              </section>
              <aside>
                <div className="state-card">
                  <span className="eyebrow">RIGHT HERE, RIGHT NOW</span>
                  <h2>
                    <Clock3 size={23} />
                    {snapshot.state.currentTime}
                    <span>Bangkok time</span>
                  </h2>
                  <div className="state-location">
                    <MapPin size={16} />
                    {snapshot.state.currentLocation}
                  </div>
                  <div className="state-tiles">
                    <div>
                      <CloudRain />
                      <b>
                        {snapshot.state.weather === "rain"
                          ? "Rainy"
                          : snapshot.state.weather}
                      </b>
                      <small>Weather</small>
                    </div>
                    <div>
                      <Footprints />
                      <b>{snapshot.state.energyLevel} energy</b>
                      <small>Your pace</small>
                    </div>
                  </div>
                  <div className="budget-line">
                    <Wallet size={17} />
                    <span>Remaining budget</span>
                    <b>฿{snapshot.state.remainingBudget.toLocaleString()}</b>
                  </div>
                  <Link className="primary full" href="/replan">
                    My plans changed <ArrowRight size={18} />
                  </Link>
                  <p className="small-note">
                    A few details. A better rest of your day.
                  </p>
                </div>
                <div className="reservation-note">
                  <LockKeyhole size={20} />
                  <div>
                    <b>Your dinner is protected</b>
                    <p>19:00–20:30 · We’ll plan around your reservation.</p>
                  </div>
                </div>
                <div className="demo-note">
                  <b>Demo data</b>
                  <p>
                    Sample hours, costs and travel estimates. No live weather or
                    location tracking.
                  </p>
                </div>
              </aside>
            </div>
          </div>
        ) : (
          <Workflow page={page} />
        )}
      </main>
      <footer className="site-footer">
        <span>
          dayshift <span> / </span> Dynamic Travel Replanning Agent
        </span>
        <span>Made for the unexpected.</span>
        {page === "home" && (
          <small>
            Bangkok-inspired image generated with AI. An imagined scene, not a
            documentary photograph.
          </small>
        )}
      </footer>
    </div>
  );
}
