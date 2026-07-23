"use client";

import { useCallback, useEffect, useState } from "react";

type VisitorEvent = {
  visitor: string;
  session: string | null;
  type: string;
  path: string;
  country: string | null;
  userAgent: string | null;
  jobId: string | null;
  createdAt: string;
};

type VisitorActivity = {
  summary: {
    visitors: number;
    pageViews: number;
    generations: number;
    interactions: number;
  };
  events: VisitorEvent[];
};

function eventLabel(type: string) {
  return type.replace(/_/gu, " ");
}

function compactDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function VisitorDashboard() {
  const [activity, setActivity] = useState<VisitorActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/visitors", { cache: "no-store" });
      const responseText = await response.text();
      let payload: VisitorActivity | { error?: { message?: string } } | null = null;
      try {
        payload = JSON.parse(responseText) as VisitorActivity | { error?: { message?: string } };
      } catch {
        throw new Error("Visitor activity could not be loaded.");
      }
      if (!response.ok || !("summary" in payload)) {
        throw new Error(
          "error" in payload && payload.error?.message
            ? payload.error.message
            : "Visitor activity could not be loaded.",
        );
      }
      setActivity(payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Visitor activity could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [load]);

  return (
    <main className="visitor-dashboard">
      <header className="visitor-header">
        <div>
          <p className="visitor-kicker">Palimpsest / private telemetry</p>
          <h1>Visitor activity</h1>
          <p>Last 24 hours and the latest 160 recorded events.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "refreshing…" : "refresh"}
        </button>
      </header>

      {error ? (
        <p className="visitor-error" role="alert">{error}</p>
      ) : null}

      {activity ? (
        <>
          <section className="visitor-summary" aria-label="Visitor activity summary">
            <div><strong>{activity.summary.visitors}</strong><span>visitors</span></div>
            <div><strong>{activity.summary.pageViews}</strong><span>page views</span></div>
            <div><strong>{activity.summary.interactions}</strong><span>interactions</span></div>
            <div><strong>{activity.summary.generations}</strong><span>generation requests</span></div>
          </section>

          <p className="visitor-note">
            Visitor IDs are salted, pseudonymous network identifiers. Prompts, uploads, and raw IP addresses are not recorded.
          </p>

          <section className="visitor-events" aria-label="Latest visitor events" aria-live="polite">
            {activity.events.length === 0 ? (
              <p className="visitor-empty">No activity has been recorded yet.</p>
            ) : (
              activity.events.map((event, index) => (
                <article className="visitor-event" key={`${event.createdAt}-${event.visitor}-${index}`}>
                  <time dateTime={event.createdAt}>{compactDate(event.createdAt)}</time>
                  <div className="visitor-event-main">
                    <strong>{eventLabel(event.type)}</strong>
                    <span>{event.path}</span>
                    {event.jobId ? <code>job {event.jobId.slice(0, 8)}</code> : null}
                  </div>
                  <dl>
                    <div><dt>visitor</dt><dd>{event.visitor}</dd></div>
                    <div><dt>session</dt><dd>{event.session ?? "—"}</dd></div>
                    <div><dt>country</dt><dd>{event.country ?? "—"}</dd></div>
                    <div><dt>browser</dt><dd title={event.userAgent ?? undefined}>{event.userAgent ?? "—"}</dd></div>
                  </dl>
                </article>
              ))
            )}
          </section>
        </>
      ) : loading && !error ? (
        <p className="visitor-loading">Loading visitor activity…</p>
      ) : null}
    </main>
  );
}
