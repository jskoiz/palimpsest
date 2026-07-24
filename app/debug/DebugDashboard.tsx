"use client";

/* eslint-disable @next/next/no-img-element -- Debug thumbnails use immutable R2 blob URLs. */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DebugJob = {
  id: string;
  kind: "edit" | "revert";
  author: string;
  state: string;
  region: Region | null;
  reservationActive: boolean;
  prompt: string | null;
  displaySummary: string;
  error: { code: string; message: string | null } | null;
  requestId: string | null;
  submittedAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryable: boolean;
};

type DebugRevision = {
  id: string;
  sequence: number;
  author: string;
  prompt: string;
  createdAt: string;
  origin: string;
  sharePath: string;
};

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

type DebugSnapshot = {
  generatedAt: string;
  activity: {
    queue: { queued: number; active: number };
    activeRegions: Array<{
      jobId: string;
      author: string;
      state: string;
      region: Region;
      reservationActive: boolean;
      updatedAt: string;
    }>;
    jobs: DebugJob[];
    recent: DebugRevision[];
  };
  visitors: {
    summary: {
      visitors: number;
      pageViews: number;
      generations: number;
      interactions: number;
    };
    events: VisitorEvent[];
  };
  uploads: Array<{
    id: string;
    url: string;
    contentType: string;
    byteLength: number;
    width: number;
    height: number;
    createdAt: string;
  }>;
};

type RetryCapability = {
  token: string;
  requestKey?: string;
};

type RetryJob = {
  id: string;
  state: string;
  retryToken?: string;
  error: { message?: string } | null;
  message: string | null;
};

const RETRY_CAPABILITIES_STORAGE_KEY = "palimpsest:retry-capabilities:v1";
const FAILURE_STATES = new Set(["failed", "rejected", "stale"]);
const ACTIVE_STATES = new Set(["queued", "moderating", "generating", "committing"]);

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function eventLabel(value: string) {
  return value.replaceAll("_", " ");
}

function jobState(job: DebugJob) {
  if (FAILURE_STATES.has(job.state)) return "failed";
  if (job.state === "succeeded") return "done";
  if (!job.reservationActive && ACTIVE_STATES.has(job.state)) return "recovering";
  if (job.state === "queued") return "reserved";
  if (job.state === "moderating") return "starting";
  if (job.state === "committing") return "finishing";
  return job.state;
}

function compactId(value: string | null) {
  return value ? value.slice(0, 12) : "—";
}

function regionLabel(region: Region | null) {
  return region
    ? `${region.x},${region.y} · ${region.width}×${region.height}`
    : "full canvas";
}

async function readJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as
    | T
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && "error" in payload
        ? payload.error?.message ?? "The request could not be completed."
        : "The request could not be completed.",
    );
  }
  return payload as T;
}

function readRetryCapabilities() {
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(RETRY_CAPABILITIES_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, RetryCapability] =>
          Boolean(
            entry[1] &&
              typeof entry[1] === "object" &&
              "token" in entry[1] &&
              typeof entry[1].token === "string" &&
              (!("requestKey" in entry[1]) ||
                typeof entry[1].requestKey === "string"),
          ),
      ),
    );
  } catch {
    return {};
  }
}

export function DebugDashboard() {
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [retryCapabilities, setRetryCapabilities] = useState<
    Record<string, RetryCapability>
  >({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await readJson<DebugSnapshot>("/api/debug", {
        cache: "no-store",
      });
      setSnapshot(next);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Debug data could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      setRetryCapabilities(readRetryCapabilities());
      void load();
    }, 0);
    const interval = window.setInterval(() => void load(), 20_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [load]);

  const saveRetryCapabilities = useCallback(
    (next: Record<string, RetryCapability>) => {
      setRetryCapabilities(next);
      try {
        window.sessionStorage.setItem(
          RETRY_CAPABILITIES_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // The current page retains capabilities if session storage is unavailable.
      }
    },
    [],
  );

  const retryJob = useCallback(
    async (job: DebugJob) => {
      const capability = retryCapabilities[job.id];
      if (!job.retryable || !capability || retryingJobId) return;

      const requestKey = capability.requestKey ?? crypto.randomUUID();
      saveRetryCapabilities({
        ...retryCapabilities,
        [job.id]: { ...capability, requestKey },
      });
      setRetryingJobId(job.id);
      setRetryNotice(null);
      try {
        const payload = await readJson<{ job: RetryJob }>(
          `/api/jobs/${encodeURIComponent(job.id)}/retry`,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": requestKey,
              "X-Palimpsest-Retry-Token": capability.token,
            },
          },
        );
        const nextCapabilities = { ...retryCapabilities };
        delete nextCapabilities[job.id];
        if (payload.job.retryToken) {
          nextCapabilities[payload.job.id] = {
            token: payload.job.retryToken,
          };
        }
        saveRetryCapabilities(nextCapabilities);
        setRetryNotice(
          FAILURE_STATES.has(payload.job.state)
            ? payload.job.error?.message ??
                payload.job.message ??
                "The retry ended without an accepted revision."
            : "Retry reserved. The queue worker has been asked to start.",
        );
        void fetch("/api/queue/drain", { method: "POST" }).catch(() => undefined);
        await load();
      } catch (retryError) {
        setRetryNotice(
          retryError instanceof Error
            ? retryError.message
            : "This retry could not be started.",
        );
      } finally {
        setRetryingJobId(null);
      }
    },
    [
      load,
      retryCapabilities,
      retryingJobId,
      saveRetryCapabilities,
    ],
  );

  const failures = useMemo(
    () => snapshot?.activity.jobs.filter((job) => FAILURE_STATES.has(job.state)) ?? [],
    [snapshot],
  );
  const inProcess = useMemo(
    () =>
      snapshot?.activity.jobs.filter((job) => ACTIVE_STATES.has(job.state)).length ??
      0,
    [snapshot],
  );

  return (
    <main className="debug-dashboard">
      <header className="debug-header">
        <div>
          <Link className="debug-back" href="/">← live canvas</Link>
          <h1>debug</h1>
          <p>Operations, uploads, failures, and audience activity in one place.</p>
        </div>
        <div className="debug-refresh">
          {snapshot ? (
            <span>updated {formatDate(snapshot.generatedAt)}</span>
          ) : null}
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "refreshing…" : "refresh"}
          </button>
        </div>
      </header>

      {error ? (
        <p className="debug-error" role="alert">
          {error}
        </p>
      ) : null}
      {retryNotice ? (
        <p className="debug-notice" role="status">
          {retryNotice}
        </p>
      ) : null}

      {snapshot ? (
        <div className="debug-content">
          <section className="debug-summary" aria-label="Debug summary">
            <div>
              <strong>{inProcess}</strong>
              <span>in process</span>
            </div>
            <div className={failures.length ? "is-alert" : ""}>
              <strong>{failures.length}</strong>
              <span>failures</span>
            </div>
            <div>
              <strong>{snapshot.uploads.length}</strong>
              <span>recent uploads</span>
            </div>
            <div>
              <strong>{snapshot.visitors.summary.visitors}</strong>
              <span>viewers / 24h</span>
            </div>
            <div>
              <strong>{snapshot.visitors.summary.pageViews}</strong>
              <span>page views / 24h</span>
            </div>
            <div>
              <strong>{snapshot.activity.recent.length}</strong>
              <span>recent revisions</span>
            </div>
          </section>

          <section className="debug-section" aria-labelledby="system-title">
            <div className="debug-section-head">
              <div>
                <h2 id="system-title">system</h2>
                <p>Current queue and reservation health.</p>
              </div>
              <span>{snapshot.activity.activeRegions.length} locked regions</span>
            </div>
            <dl className="debug-system">
              <div>
                <dt>queued</dt>
                <dd>{snapshot.activity.queue.queued}</dd>
              </div>
              <div>
                <dt>active workers</dt>
                <dd>{snapshot.activity.queue.active}</dd>
              </div>
              <div>
                <dt>recovering locks</dt>
                <dd>
                  {
                    snapshot.activity.activeRegions.filter(
                      (region) => !region.reservationActive,
                    ).length
                  }
                </dd>
              </div>
              <div>
                <dt>generation requests / 24h</dt>
                <dd>{snapshot.visitors.summary.generations}</dd>
              </div>
            </dl>
          </section>

          <section className="debug-section" aria-labelledby="failures-title">
            <div className="debug-section-head">
              <div>
                <h2 id="failures-title">failures</h2>
                <p>Terminal attempts are hidden from the live canvas and retained here.</p>
              </div>
              <span>{failures.length} recent</span>
            </div>
            {failures.length ? (
              <div className="debug-failures">
                {failures.map((job) => {
                  const canRetry = Boolean(
                    job.retryable && retryCapabilities[job.id],
                  );
                  return (
                    <article key={job.id}>
                      <div className="debug-failure-head">
                        <div>
                          <strong>{job.author}</strong>
                          <span>{job.error?.code ?? job.state}</span>
                        </div>
                        <time dateTime={job.updatedAt}>
                          {formatDate(job.updatedAt)}
                        </time>
                      </div>
                      <p>
                        {job.error?.message ??
                          "This contribution did not become an accepted revision."}
                      </p>
                      <dl>
                        <div>
                          <dt>job</dt>
                          <dd title={job.id}>{compactId(job.id)}</dd>
                        </div>
                        <div>
                          <dt>request</dt>
                          <dd title={job.requestId ?? undefined}>
                            {compactId(job.requestId)}
                          </dd>
                        </div>
                        <div>
                          <dt>region</dt>
                          <dd>{regionLabel(job.region)}</dd>
                        </div>
                        <div>
                          <dt>started</dt>
                          <dd>{job.startedAt ? formatDate(job.startedAt) : "never"}</dd>
                        </div>
                      </dl>
                      {job.retryable ? (
                        canRetry ? (
                          <button
                            type="button"
                            disabled={retryingJobId !== null}
                            onClick={() => void retryJob(job)}
                          >
                            {retryingJobId === job.id ? "retrying…" : "retry once"}
                          </button>
                        ) : (
                          <span className="debug-capability-note">
                            retry available only in the submitting browser
                          </span>
                        )
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="debug-empty">No recent failures.</p>
            )}
          </section>

          <section className="debug-section" aria-labelledby="uploads-title">
            <div className="debug-section-head">
              <div>
                <h2 id="uploads-title">recent uploads</h2>
                <p>Reference images supplied with recent contributions.</p>
              </div>
              <span>{snapshot.uploads.length} retained</span>
            </div>
            {snapshot.uploads.length ? (
              <div className="debug-uploads">
                {snapshot.uploads.map((upload) => (
                  <a href={upload.url} key={upload.id} target="_blank" rel="noreferrer">
                    <img
                      src={upload.url}
                      alt={`Reference upload from ${formatDate(upload.createdAt)}`}
                    />
                    <span>
                      <strong>{upload.width}×{upload.height}</strong>
                      <small>
                        {formatBytes(upload.byteLength)} · {formatDate(upload.createdAt)}
                      </small>
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              <p className="debug-empty">No reference uploads are currently retained.</p>
            )}
          </section>

          <section className="debug-section" aria-labelledby="jobs-title">
            <div className="debug-section-head">
              <div>
                <h2 id="jobs-title">job log</h2>
                <p>Active work plus the latest 24 terminal attempts.</p>
              </div>
              <span>{snapshot.activity.jobs.length} entries</span>
            </div>
            <div className="debug-table-wrap">
              <table className="debug-table">
                <thead>
                  <tr>
                    <th>updated</th>
                    <th>state</th>
                    <th>contributor</th>
                    <th>region</th>
                    <th>job / request</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.activity.jobs.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <time dateTime={job.updatedAt}>{formatDate(job.updatedAt)}</time>
                      </td>
                      <td>
                        <span className={`debug-state is-${jobState(job)}`}>
                          {jobState(job)}
                        </span>
                        {job.error?.code ? <small>{job.error.code}</small> : null}
                      </td>
                      <td>{job.author}</td>
                      <td>{regionLabel(job.region)}</td>
                      <td>
                        <code title={job.id}>{compactId(job.id)}</code>
                        <small title={job.requestId ?? undefined}>
                          req {compactId(job.requestId)}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="debug-section" aria-labelledby="revisions-title">
            <div className="debug-section-head">
              <div>
                <h2 id="revisions-title">accepted revisions</h2>
                <p>The latest permanent changes to the canvas.</p>
              </div>
              <span>{snapshot.activity.recent.length} shown</span>
            </div>
            <div className="debug-revisions">
              {snapshot.activity.recent.map((revision) => (
                <a href={revision.sharePath} key={revision.id}>
                  <span>r{String(revision.sequence).padStart(3, "0")}</span>
                  <strong>{revision.author}</strong>
                  <p>{revision.prompt}</p>
                  <time dateTime={revision.createdAt}>
                    {formatDate(revision.createdAt)}
                  </time>
                </a>
              ))}
            </div>
          </section>

          <section className="debug-section" aria-labelledby="audience-title">
            <div className="debug-section-head">
              <div>
                <h2 id="audience-title">viewer stats</h2>
                <p>Privacy-bounded activity from the last 24 hours.</p>
              </div>
              <span>{snapshot.visitors.summary.interactions} interactions</span>
            </div>
            <p className="debug-privacy-note">
              Viewer and session IDs are shortened, salted pseudonyms. Raw IP
              addresses are never stored.
            </p>
          </section>

          <section className="debug-section" aria-labelledby="events-title">
            <div className="debug-section-head">
              <div>
                <h2 id="events-title">event log</h2>
                <p>Latest recorded page views and interactions.</p>
              </div>
              <span>{snapshot.visitors.events.length} events</span>
            </div>
            {snapshot.visitors.events.length ? (
              <div className="debug-events">
                {snapshot.visitors.events.map((event, index) => (
                  <article
                    key={`${event.createdAt}-${event.visitor}-${index}`}
                  >
                    <time dateTime={event.createdAt}>
                      {formatDate(event.createdAt)}
                    </time>
                    <div className="debug-event-main">
                      <strong>{eventLabel(event.type)}</strong>
                      <span>{event.path}</span>
                      {event.jobId ? (
                        <code title={event.jobId}>job {compactId(event.jobId)}</code>
                      ) : null}
                    </div>
                    <dl>
                      <div>
                        <dt>viewer</dt>
                        <dd>{event.visitor}</dd>
                      </div>
                      <div>
                        <dt>session</dt>
                        <dd>{event.session ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>country</dt>
                        <dd>{event.country ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>browser</dt>
                        <dd title={event.userAgent ?? undefined}>
                          {event.userAgent ?? "—"}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            ) : (
              <p className="debug-empty">No viewer events have been recorded yet.</p>
            )}
          </section>
        </div>
      ) : loading && !error ? (
        <p className="debug-loading">Loading debug data…</p>
      ) : null}
    </main>
  );
}
