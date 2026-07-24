"use client";

/* eslint-disable @next/next/no-img-element -- Immutable R2 tile layers must remain raw pixels for exact canvas compositing. */

import type {
  ChangeEvent as ReactChangeEvent,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  activityJobIsInProcess,
  activityJobState,
  collaborationPollDelay,
  publicActivityJobs,
  queueRecoveryDelay,
  viewForActivityRegion,
} from "@/app/activity-ui.mjs";
import {
  ARTWORK_SIZE,
} from "@/lib/palimpsest/domain.mjs";
import {
  canvasViewCanPan,
  constrainCanvasView,
  EDIT_REGION_MAX_EDGE,
  EDIT_REGION_MIN_EDGE,
  GENERATION_FRAME_SIZE,
  generationFrameForRegion,
  initialReferencePlacementRegion,
  maskInGenerationFrame,
  positionEditRegion,
  REFERENCE_PLACEMENT_MIN_EDGE,
  resizeReferencePlacementRegion,
  resizeEditRegion,
  regionsOverlap,
  timelineIndexAtPosition,
} from "@/lib/palimpsest/geometry.mjs";
import { prepareReferencePixels } from "@/lib/palimpsest/reference-image.mjs";

type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Revision = {
  id: string;
  sequence: number;
  parentRevisionId: string | null;
  author: string;
  prompt: string;
  createdAt: string;
  origin: "seed" | "demo" | "openai" | "placement" | "revert";
  status: "accepted";
  region: Region | null;
  revertTargetRevisionId: string | null;
  provenance: string;
  sharePath: string;
};

const EMPTY_REVISIONS: Revision[] = [];

type Layer = {
  revisionId: string;
  blobId: string;
  url: string;
  sha256: string;
  maskUrl: string | null;
  frame: Region;
};

type Tile = {
  x: number;
  y: number;
  base: { blobId: string; url: string; sha256: string };
};

type ArtworkState = {
  artwork: { id: string; width: number; height: number; tileSize: number };
  headRevisionId: string;
  isCurrent: boolean;
  revision: Revision;
  tiles: Tile[];
  layers: Layer[];
};

type HistoryPayload = {
  artwork: {
    id: string;
    title: string;
    width: number;
    height: number;
    tileSize: number;
    columns: number;
    rows: number;
  };
  revisions: Revision[];
  headRevisionId: string;
  editing: {
    generationAvailable: boolean;
  };
};

type ActivityPayload = {
  queue: { queued: number; active: number };
  jobs: ActivityJob[];
  recent: Revision[];
  activeRegions: ActiveRegion[];
};

type ActivityJob = {
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

type ActiveRegion = {
  jobId: string;
  author: string;
  state: string;
  region: Region;
  reservationActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type Job = {
  id: string;
  state:
    | "queued"
    | "moderating"
    | "generating"
    | "committing"
    | "succeeded"
    | "stale"
    | "rejected"
    | "failed";
  position: number | null;
  resultRevisionId: string | null;
  message: string | null;
  error: { code: string; message: string } | null;
  submittedAt: string;
  updatedAt: string;
  retryToken?: string;
};

type RetryCapability = {
  token: string;
  requestKey?: string;
};

type PendingEdit = {
  jobId: string;
  author: string;
  prompt: string;
  region: Region | null;
};

type LocalSubmissionFailure = {
  id: string;
  author: string;
  prompt: string;
  region: Region;
  errorCode: string | null;
  errorMessage: string;
  requestId: string | null;
  updatedAt: string;
  idempotencyKey: string | null;
  retryToken: string | null;
  payloadFingerprint: string;
};

type Stroke = {
  width: number;
  points: Array<{ x: number; y: number }>;
};

type ReferenceImage = {
  blob: Blob;
  fileName: string;
  height: number;
  previewUrl: string;
  sourceBlob: Blob;
  width: number;
};

const terminalJobStates = new Set(["succeeded", "stale", "rejected", "failed"]);

const AUTO_HIDE = true;
const IDLE_HIDE_MS = 4000;
const DEEP_IDLE_MS = 30000;
const BRUSH_WIDTH = 30;
const PATCH_SIZE_STEP = 32;
const DEFAULT_REGION = { x: 800, y: 832, width: 448, height: 384 };
const WELCOME_STORAGE_KEY = "palimpsest:welcome:v1";
const RETRY_CAPABILITIES_STORAGE_KEY = "palimpsest:retry-capabilities:v1";
const VISITOR_SESSION_STORAGE_KEY = "palimpsest:visitor-session:v1";
const REFERENCE_IMAGE_SIZE = 1024;
const REFERENCE_PREVIEW_FILL = 0.72;
const REFERENCE_DECODE_MAX_EDGE = 1536;
const REFERENCE_MAX_ASPECT_RATIO = 8;
const MAX_REFERENCE_UPLOAD_BYTES = 10 * 1024 * 1024;
const REFERENCE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const EMPTY_ACTIVITY: ActivityPayload = {
  queue: { queued: 0, active: 0 },
  jobs: [],
  recent: [],
  activeRegions: [],
};

type VisitorInteraction =
  | "guide_opened"
  | "queue_opened"
  | "history_opened"
  | "contribution_opened"
  | "patch_confirmed"
  | "mask_confirmed"
  | "reference_added";

function visitorSessionId(): string | null {
  try {
    const existing = window.sessionStorage.getItem(VISITOR_SESSION_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(VISITOR_SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return null;
  }
}

function trackVisitorInteraction(event: VisitorInteraction) {
  const sessionId = visitorSessionId();
  void fetch("/api/visitors/events", {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "X-Palimpsest-Session": sessionId } : {}),
    },
    body: JSON.stringify({ event }),
  }).catch(() => {
    // Visitor telemetry is intentionally best-effort and never blocks creation.
  });
}

function pad3(value: number) {
  return String(value).padStart(3, "0");
}

function seqTag(sequence: number) {
  return `r${pad3(sequence)}`;
}

function compactTime(date: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function regionStyle(region: Region): CSSProperties {
  return {
    left: `${(region.x / ARTWORK_SIZE) * 100}%`,
    top: `${(region.y / ARTWORK_SIZE) * 100}%`,
    width: `${(region.width / ARTWORK_SIZE) * 100}%`,
    height: `${(region.height / ARTWORK_SIZE) * 100}%`,
  };
}

function referencePreviewStyle(): CSSProperties {
  const offset = ((1 - REFERENCE_PREVIEW_FILL) / 2) * 100;
  return {
    position: "absolute",
    width: `${REFERENCE_PREVIEW_FILL * 100}%`,
    height: `${REFERENCE_PREVIEW_FILL * 100}%`,
    left: `${offset}%`,
    top: `${offset}%`,
  };
}

function findOpenRegion(sequence: number, activeRegions: ActiveRegion[]) {
  const centered = positionEditRegion(
    DEFAULT_REGION,
    DEFAULT_REGION.x,
    DEFAULT_REGION.y,
  );
  const limitX = ARTWORK_SIZE - centered.width;
  const limitY = ARTWORK_SIZE - centered.height;
  const phase = sequence * 0.71;
  for (let index = 0; index < 36; index += 1) {
    const progress = index / 35;
    const angle = phase + index * 2.399963229728653;
    const candidate = positionEditRegion(
      centered,
      limitX / 2 + Math.cos(angle) * (limitX / 2) * Math.sqrt(progress),
      limitY / 2 + Math.sin(angle) * (limitY / 2) * Math.sqrt(progress),
    );
    if (!activeRegions.some((active) => regionsOverlap(candidate, active.region))) {
      return candidate;
    }
  }
  return centered;
}

function activitySignature(activity: ActivityPayload) {
  return JSON.stringify({
    queue: activity.queue,
    jobs: activity.jobs.map((job) => [
      job.id,
      job.author,
      job.state,
      job.region?.x ?? null,
      job.region?.y ?? null,
      job.region?.width ?? null,
      job.region?.height ?? null,
      job.reservationActive,
      job.displaySummary,
      job.error?.code ?? null,
      job.error?.message ?? null,
      job.requestId,
      job.submittedAt,
      job.updatedAt,
      job.startedAt,
      job.completedAt,
      job.retryable,
    ]),
    recent: activity.recent.map((revision) => [revision.id, revision.createdAt]),
    activeRegions: activity.activeRegions.map((active) => [
      active.jobId,
      active.author,
      active.state,
      active.region.x,
      active.region.y,
      active.region.width,
      active.region.height,
      active.reservationActive,
      active.updatedAt,
    ]),
  });
}

function jobStateLabel(state: string) {
  if (state === "queued") return "reserved";
  if (state === "moderating") return "planning";
  if (state === "committing") return "finishing";
  if (state === "generating") return "generating";
  return state;
}

function activeStateLabel(active: ActiveRegion) {
  return active.reservationActive ? jobStateLabel(active.state) : "recovering";
}

function overlapMessage(active: ActiveRegion) {
  let message: string;
  if (!active.reservationActive) {
    message = `${active.author}'s edit is recovering here — this area stays unavailable until recovery finishes.`;
  } else if (active.state === "queued") {
    message = `${active.author} reserved this area — it stays locked until the edit finishes.`;
  } else if (active.state === "moderating") {
    message = `${active.author} is planning an edit here — this area is locked.`;
  } else if (active.state === "committing") {
    message = `${active.author} is finishing an edit here — this area is locked.`;
  } else {
    message = `${active.author} is generating here — this area is locked.`;
  }
  return `${message} Your patch stays exactly where you placed it; wait for the lock to clear or move it yourself.`;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string; requestId?: string } }
    | null;
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    throw new PalimpsestRequestError(
      error?.message ?? "Palimpsest could not complete that request.",
      error?.code ?? null,
      error?.requestId ?? response.headers.get("x-request-id"),
    );
  }
  return body as T;
}

class PalimpsestRequestError extends Error {
  code: string | null;
  requestId: string | null;

  constructor(message: string, code: string | null, requestId: string | null) {
    super(message);
    this.name = "PalimpsestRequestError";
    this.code = code;
    this.requestId = requestId;
  }
}

function ArtworkLayers({
  state,
  className = "",
}: {
  state: ArtworkState;
  className?: string;
}) {
  return (
    <div
      className={`artwork-layers ${className}`}
      role="img"
      aria-label={`Palimpsest, revision ${state.revision.sequence}, ${state.revision.prompt}`}
    >
      {state.tiles.map((tile) => (
        <img
          key={`${tile.x}-${tile.y}-${tile.base.blobId}`}
          className="artwork-base-tile"
          src={tile.base.url}
          alt=""
          draggable={false}
          crossOrigin="anonymous"
          data-tile={`${tile.x}-${tile.y}`}
          style={{
            left: `${((tile.x * state.artwork.tileSize) / state.artwork.width) * 100}%`,
            top: `${((tile.y * state.artwork.tileSize) / state.artwork.height) * 100}%`,
            width: `${(state.artwork.tileSize / state.artwork.width) * 100}%`,
            height: `${(state.artwork.tileSize / state.artwork.height) * 100}%`,
          }}
        />
      ))}
      {state.layers.map((layer) => (
        <img
          key={`${layer.revisionId}-${layer.blobId}`}
          className="artwork-global-layer"
          src={layer.url}
          alt=""
          draggable={false}
          crossOrigin="anonymous"
          style={{
            ...regionStyle(layer.frame),
            ...(layer.maskUrl
              ? {
                  maskImage: `url("${layer.maskUrl}")`,
                  WebkitMaskImage: `url("${layer.maskUrl}")`,
                  maskSize: "100% 100%",
                  WebkitMaskSize: "100% 100%",
                  maskRepeat: "no-repeat",
                  WebkitMaskRepeat: "no-repeat",
                }
              : {}),
          }}
        />
      ))}
    </div>
  );
}

type MobileDockIconName = "canvas" | "history" | "queue" | "contribute";

function MobileDockIcon({ name }: { name: MobileDockIconName }) {
  if (name === "canvas") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
        <circle cx="16.5" cy="16.5" r="1.5" className="is-filled" />
      </svg>
    );
  }
  if (name === "history") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 8.5A8.5 8.5 0 1 1 3.8 15" />
        <path d="M4 4.5v4h4" />
        <path d="M12 7.5v5l3.25 1.75" />
      </svg>
    );
  }
  if (name === "queue") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="5" cy="7" r="1" className="is-filled" />
        <circle cx="5" cy="12" r="1" className="is-filled" />
        <circle cx="5" cy="17" r="1" className="is-filled" />
        <path d="M9 7h11M9 12h11M9 17h11" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v9M7.5 12h9" />
    </svg>
  );
}

function WelcomeDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    offset: number;
  } | null>(null);

  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open || dialog.classList.contains("is-closing")) return;
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    dragRef.current = null;
    dialog.classList.remove("is-dragging");
    dialog.classList.add("is-closing");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      onClose();
      return;
    }
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      onClose();
    }, 220);
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let focusFrame = 0;
    if (open && !dialog.open) {
      if (dismissTimerRef.current) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      dialog.classList.remove("is-closing", "is-dragging");
      dialog.style.removeProperty("--drawer-drag");
      dialog.showModal();
      focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    } else if (!open && dialog.open) {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      dragRef.current = null;
      dialog.close();
      dialog.classList.remove("is-closing", "is-dragging");
      dialog.style.removeProperty("--drawer-drag");
    }
    return () => {
      if (focusFrame) window.cancelAnimationFrame(focusFrame);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current);
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    [],
  );

  const drawerDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.classList.contains("is-closing")) return;
    dragCleanupRef.current?.();
    const pointerId = event.pointerId;
    dragRef.current = { pointerId, startY: event.clientY, offset: 0 };
    dialog.classList.add("is-dragging");
    event.preventDefault();

    const move = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current;
      const currentDialog = dialogRef.current;
      if (!currentDialog || !drag || pointerEvent.pointerId !== pointerId) return;
      drag.offset = Math.max(0, pointerEvent.clientY - drag.startY);
      currentDialog.style.setProperty("--drawer-drag", `${drag.offset}px`);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const finish = (pointerEvent: PointerEvent, allowDismiss: boolean) => {
      const drag = dragRef.current;
      const currentDialog = dialogRef.current;
      if (!currentDialog || !drag || pointerEvent.pointerId !== pointerId) return;
      drag.offset = Math.max(drag.offset, pointerEvent.clientY - drag.startY);
      cleanup();
      dragCleanupRef.current = null;
      dragRef.current = null;
      currentDialog.classList.remove("is-dragging");
      const threshold = Math.min(160, currentDialog.clientHeight * 0.2);
      if (allowDismiss && drag.offset >= threshold) {
        requestClose();
      } else {
        currentDialog.style.removeProperty("--drawer-drag");
      }
    };
    const up = (pointerEvent: PointerEvent) => finish(pointerEvent, true);
    const cancel = (pointerEvent: PointerEvent) => finish(pointerEvent, false);

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  return (
    <dialog
      ref={dialogRef}
      id="welcome-dialog"
      className="mono-welcome"
      data-testid="welcome-drawer"
      aria-labelledby="welcome-title"
      aria-describedby="welcome-description"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const outside =
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom;
        if (outside) requestClose();
      }}
    >
      <div
        className="mono-welcome-grab"
        data-testid="welcome-drawer-handle"
        aria-hidden="true"
        onPointerDown={drawerDragStart}
      >
        <span />
      </div>
      <div className="mono-welcome-scroll">
        <div className="mono-welcome-inner">
          <div className="mono-welcome-head">
            <span id="welcome-title" className="mono-welcome-kicker">
              guide
            </span>
            <button
              ref={closeButtonRef}
              type="button"
              className="mono-welcome-close"
              aria-label="Close welcome guide"
              onClick={requestClose}
            >
              ×
            </button>
          </div>

          <div className="mono-welcome-guide">
            <div className="mono-welcome-intro">
              <p id="welcome-description" className="mono-welcome-summary">
                A palimpsest is a surface rewritten while traces of what came before
                remain. Here, every accepted edit becomes the next revision; earlier
                versions stay available.
              </p>
              <p className="mono-welcome-credit">
                Made by{" "}
                <a href="https://x.com/saboorow" target="_blank" rel="noreferrer">
                  @saboorow on X
                </a>
                . Open source at{" "}
                <a
                  href="https://github.com/jskoiz/palimpsest"
                  target="_blank"
                  rel="noreferrer"
                >
                  jskoiz/palimpsest
                </a>
                .
              </p>
            </div>

            <div className="mono-welcome-path">
              <section>
                <span>01</span>
                <h2>Move</h2>
                <p>
                  Drag when the artwork extends past the window. Scroll or use − and +
                  to zoom.
                </p>
              </section>
              <section>
                <span>02</span>
                <h2>History</h2>
                <p>Open History and drag the timeline to inspect any revision.</p>
              </section>
              <section>
                <span>03</span>
                <h2>Contribute</h2>
                <p>
                  Place and resize the patch, then paint what may change. Add an image
                  as a visual reference. GPT Image makes the edit, GPT-5.6 reviews it,
                  and only active work is locked.
                </p>
              </section>
            </div>
          </div>

          <div className="mono-welcome-footer">
            <div className="mono-welcome-controls" aria-label="Quick controls">
              <span className="mono-welcome-controls-label">quick controls</span>
              <dl>
                <div>
                  <dt><kbd>drag</kbd></dt>
                  <dd>move</dd>
                </div>
                <div>
                  <dt><kbd>←</kbd> <kbd>→</kbd></dt>
                  <dd>history</dd>
                </div>
                <div>
                  <dt><kbd>space</kbd></dt>
                  <dd>play</dd>
                </div>
                <div>
                  <dt><kbd>C</kbd></dt>
                  <dd>contribute</dd>
                </div>
                <div>
                  <dt><kbd>Q</kbd></dt>
                  <dd>queue</dd>
                </div>
              </dl>
            </div>

            <div className="mono-welcome-touch" aria-label="Touch controls">
              <div>
                <strong>drag the artwork</strong>
                <span>move around the canvas</span>
              </div>
              <div>
                <strong>use − and +</strong>
                <span>zoom with clear tap targets</span>
              </div>
              <div>
                <strong>use the bottom dock</strong>
                <span>open History, Queue, or Contribute</span>
              </div>
            </div>

            <div className="mono-welcome-foot">
              <button type="button" className="mono-welcome-enter" onClick={requestClose}>
                done →
              </button>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("An artwork layer could not be prepared."));
    image.src = source;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, message: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(message))), "image/png");
  });
}

async function normalizeReferenceImage(
  file: File,
): Promise<{
  blob: Blob;
  height: number;
  width: number;
}> {
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error("That reference image could not be opened. Use a PNG, JPEG, or WebP file.");
  }
  try {
    if (image.width < 1 || image.height < 1) {
      throw new Error("That reference image has no visible pixels.");
    }
    const decodeScale = Math.min(
      1,
      REFERENCE_DECODE_MAX_EDGE / Math.max(image.width, image.height),
    );
    const decodedWidth = Math.max(1, Math.round(image.width * decodeScale));
    const decodedHeight = Math.max(1, Math.round(image.height * decodeScale));
    const decoded = document.createElement("canvas");
    decoded.width = decodedWidth;
    decoded.height = decodedHeight;
    const context = decoded.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot prepare reference images.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, decodedWidth, decodedHeight);
    const original = context.getImageData(0, 0, decodedWidth, decodedHeight);
    const prepared = prepareReferencePixels({
      data: original.data,
      width: decodedWidth,
      height: decodedHeight,
    });
    const { bounds } = prepared;
    const aspectRatio = bounds.width / bounds.height;
    if (
      aspectRatio > REFERENCE_MAX_ASPECT_RATIO ||
      aspectRatio < 1 / REFERENCE_MAX_ASPECT_RATIO
    ) {
      throw new Error(
        "Crop this image so its width and height are within an 8:1 ratio.",
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    const cropContext = canvas.getContext("2d");
    if (!cropContext) throw new Error("This browser cannot prepare reference images.");
    cropContext.putImageData(
      new ImageData(prepared.data, decodedWidth, decodedHeight),
      -bounds.x,
      -bounds.y,
    );
    const blob = await canvasBlob(canvas, "The reference image could not be encoded.");
    return {
      blob,
      height: bounds.height,
      width: bounds.width,
    };
  } finally {
    image.close();
  }
}

async function referenceGuideLayer(
  reference: Blob,
  region: Region,
  frame: Region,
): Promise<Blob> {
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(reference);
  } catch {
    throw new Error("The prepared reference guide could not be opened.");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = REFERENCE_IMAGE_SIZE;
    canvas.height = REFERENCE_IMAGE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare reference guides.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const editableArea = maskInGenerationFrame(region, [], frame).region;
    const width = Math.max(1, Math.round(editableArea.width * REFERENCE_PREVIEW_FILL));
    const height = Math.max(1, Math.round(editableArea.height * REFERENCE_PREVIEW_FILL));
    context.drawImage(
      image,
      editableArea.x + Math.round((editableArea.width - width) / 2),
      editableArea.y + Math.round((editableArea.height - height) / 2),
      width,
      height,
    );
    return canvasBlob(canvas, "The positioned reference guide could not be encoded.");
  } finally {
    image.close();
  }
}

async function flattenArtworkFrame(state: ArtworkState, frame: Region): Promise<Blob> {
  const composite = document.createElement("canvas");
  composite.width = state.artwork.width;
  composite.height = state.artwork.height;
  const context = composite.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare image edits.");

  const baseImages = await Promise.all(
    state.tiles.map(async (tile) => ({ tile, image: await loadImage(tile.base.url) })),
  );
  for (const { tile, image } of baseImages) {
    context.drawImage(
      image,
      tile.x * state.artwork.tileSize,
      tile.y * state.artwork.tileSize,
      state.artwork.tileSize,
      state.artwork.tileSize,
    );
  }

  const layerImages = await Promise.all(
    state.layers.map(async (layer) => ({
      layer,
      image: await loadImage(layer.url),
      mask: layer.maskUrl ? await loadImage(layer.maskUrl) : null,
    })),
  );
  for (const { layer, image, mask } of layerImages) {
    if (!mask) {
      context.drawImage(
        image,
        layer.frame.x,
        layer.frame.y,
        layer.frame.width,
        layer.frame.height,
      );
      continue;
    }
    const offscreen = document.createElement("canvas");
    offscreen.width = layer.frame.width;
    offscreen.height = layer.frame.height;
    const layerContext = offscreen.getContext("2d");
    if (!layerContext) throw new Error("This browser cannot prepare image edits.");
    layerContext.drawImage(image, 0, 0, layer.frame.width, layer.frame.height);
    layerContext.globalCompositeOperation = "destination-in";
    layerContext.drawImage(mask, 0, 0, layer.frame.width, layer.frame.height);
    context.drawImage(offscreen, layer.frame.x, layer.frame.y);
  }

  const source = document.createElement("canvas");
  source.width = GENERATION_FRAME_SIZE;
  source.height = GENERATION_FRAME_SIZE;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) throw new Error("This browser cannot prepare image edits.");
  sourceContext.imageSmoothingEnabled = true;
  sourceContext.imageSmoothingQuality = "high";

  const sourceLeft = Math.max(0, frame.x);
  const sourceTop = Math.max(0, frame.y);
  const sourceRight = Math.min(state.artwork.width, frame.x + frame.width);
  const sourceBottom = Math.min(state.artwork.height, frame.y + frame.height);
  const sourceWidth = sourceRight - sourceLeft;
  const sourceHeight = sourceBottom - sourceTop;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("The artwork frame does not intersect the canvas.");
  }

  const scaleX = GENERATION_FRAME_SIZE / frame.width;
  const scaleY = GENERATION_FRAME_SIZE / frame.height;
  const destinationLeft = Math.round((sourceLeft - frame.x) * scaleX);
  const destinationTop = Math.round((sourceTop - frame.y) * scaleY);
  const destinationRight = Math.round((sourceRight - frame.x) * scaleX);
  const destinationBottom = Math.round((sourceBottom - frame.y) * scaleY);
  const destinationWidth = destinationRight - destinationLeft;
  const destinationHeight = destinationBottom - destinationTop;

  sourceContext.drawImage(
    composite,
    sourceLeft,
    sourceTop,
    sourceWidth,
    sourceHeight,
    destinationLeft,
    destinationTop,
    destinationWidth,
    destinationHeight,
  );

  // Keep edge-aligned edit regions centered in the provider frame. Any virtual
  // context outside the 2048px artwork repeats the nearest canvas pixels rather
  // than becoming transparent, so the image model sees continuous surroundings.
  if (destinationLeft > 0) {
    sourceContext.drawImage(
      composite,
      sourceLeft,
      sourceTop,
      1,
      sourceHeight,
      0,
      destinationTop,
      destinationLeft,
      destinationHeight,
    );
  }
  if (destinationRight < GENERATION_FRAME_SIZE) {
    sourceContext.drawImage(
      composite,
      sourceRight - 1,
      sourceTop,
      1,
      sourceHeight,
      destinationRight,
      destinationTop,
      GENERATION_FRAME_SIZE - destinationRight,
      destinationHeight,
    );
  }
  if (destinationTop > 0) {
    sourceContext.drawImage(
      composite,
      sourceLeft,
      sourceTop,
      sourceWidth,
      1,
      destinationLeft,
      0,
      destinationWidth,
      destinationTop,
    );
  }
  if (destinationBottom < GENERATION_FRAME_SIZE) {
    sourceContext.drawImage(
      composite,
      sourceLeft,
      sourceBottom - 1,
      sourceWidth,
      1,
      destinationLeft,
      destinationBottom,
      destinationWidth,
      GENERATION_FRAME_SIZE - destinationBottom,
    );
  }

  const fillCorner = (
    sourceX: number,
    sourceY: number,
    destinationX: number,
    destinationY: number,
    width: number,
    height: number,
  ) => {
    if (width <= 0 || height <= 0) return;
    sourceContext.drawImage(
      composite,
      sourceX,
      sourceY,
      1,
      1,
      destinationX,
      destinationY,
      width,
      height,
    );
  };
  fillCorner(sourceLeft, sourceTop, 0, 0, destinationLeft, destinationTop);
  fillCorner(
    sourceRight - 1,
    sourceTop,
    destinationRight,
    0,
    GENERATION_FRAME_SIZE - destinationRight,
    destinationTop,
  );
  fillCorner(
    sourceLeft,
    sourceBottom - 1,
    0,
    destinationBottom,
    destinationLeft,
    GENERATION_FRAME_SIZE - destinationBottom,
  );
  fillCorner(
    sourceRight - 1,
    sourceBottom - 1,
    destinationRight,
    destinationBottom,
    GENERATION_FRAME_SIZE - destinationRight,
    GENERATION_FRAME_SIZE - destinationBottom,
  );
  return canvasBlob(source, "The artwork frame could not be encoded.");
}

async function providerMask(
  region: Region,
  frame: Region,
  strokes: Stroke[],
  fill: boolean,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = GENERATION_FRAME_SIZE;
  canvas.height = GENERATION_FRAME_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare a mask.");
  context.fillStyle = "#111111";
  context.fillRect(0, 0, GENERATION_FRAME_SIZE, GENERATION_FRAME_SIZE);
  context.globalCompositeOperation = "destination-out";
  const generationMask = maskInGenerationFrame(region, strokes, frame);
  const frameRegion = generationMask.region;
  if (fill) {
    context.clearRect(
      frameRegion.x,
      frameRegion.y,
      frameRegion.width,
      frameRegion.height,
    );
  } else {
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of generationMask.strokes) {
      const first = stroke.points[0];
      if (!first) continue;
      context.lineWidth = stroke.width;
      context.beginPath();
      context.moveTo(frameRegion.x + first.x, frameRegion.y + first.y);
      if (stroke.points.length === 1) {
        context.lineTo(frameRegion.x + first.x + 0.01, frameRegion.y + first.y + 0.01);
      } else {
        for (const point of stroke.points.slice(1)) {
          context.lineTo(frameRegion.x + point.x, frameRegion.y + point.y);
        }
      }
      context.stroke();
    }
  }
  context.globalCompositeOperation = "source-over";
  return canvasBlob(canvas, "The mask could not be encoded.");
}

export default function Palimpsest() {
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [activity, setActivity] = useState<ActivityPayload>(EMPTY_ACTIVITY);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedState, setSelectedState] = useState<ArtworkState | null>(null);
  const [currentState, setCurrentState] = useState<ArtworkState | null>(null);
  const [beforeState, setBeforeState] = useState<ArtworkState | null>(null);
  const stateCache = useRef(new Map<string, ArtworkState>());
  const [loadingError, setLoadingError] = useState<string | null>(null);

  const [chromeVisible, setChromeVisible] = useState(true);
  const [deepIdle, setDeepIdle] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [compareOn, setCompareOn] = useState(false);
  const [comparePos, setComparePos] = useState(55);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [timelineDragging, setTimelineDragging] = useState(false);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const [panPointerFocused, setPanPointerFocused] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [, setRetryCapabilitiesByJobId] = useState<
    Record<string, RetryCapability>
  >({});

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [editRegion, setEditRegion] = useState<Region>({ ...DEFAULT_REGION });
  const [editBase, setEditBase] = useState<{
    revisionId: string;
    state: ArtworkState;
  } | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [fillMask, setFillMask] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [displayName, setDisplayName] = useState("anonymous visitor");
  const [submitted, setSubmitted] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [localSubmissionFailure, setLocalSubmissionFailure] =
    useState<LocalSubmissionFailure | null>(null);

  const drainInFlight = useRef(false);
  const activityRequest = useRef<Promise<ActivityPayload> | null>(null);
  const activitySignatureRef = useRef(activitySignature(EMPTY_ACTIVITY));
  const idleTimer = useRef<number | null>(null);
  const deepTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const panStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const patchDrag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const patchResize = useRef<{
    pointerId: number;
    edgeOffsetX: number;
    edgeOffsetY: number;
  } | null>(null);
  const compareDrag = useRef(false);
  const timelineDrag = useRef<number | null>(null);
  const maskPointer = useRef<number | null>(null);
  const overlayCoverRef = useRef<HTMLDivElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const referencePreviewUrlRef = useRef<string | null>(null);

  const revisions = history?.revisions ?? EMPTY_REVISIONS;
  const selectedRevision = revisions[selectedIndex] ?? null;
  const headRevision = revisions.at(-1) ?? null;
  const previousRevision = selectedIndex > 0 ? revisions[selectedIndex - 1] : null;
  const panelOpen = historyOpen || queueOpen || editOpen || welcomeOpen;
  const chromeShown = chromeVisible || panelOpen;
  const showHistory =
    historyOpen && !queueOpen && !editOpen && !welcomeOpen && revisions.length > 0;
  const notCurrent = Boolean(selectedRevision && history && selectedRevision.id !== history.headRevisionId);
  const validMask = fillMask || strokes.length > 0;
  const patchCanMove =
    !submitted &&
    !isPreparing &&
    (step === 1 || (step === 3 && Boolean(referenceImage)));
  const patchCanResize =
    !submitted &&
    !isPreparing &&
    (step === 1 || (step === 3 && Boolean(referenceImage)));
  const patchMinimumEdge = referenceImage
    ? REFERENCE_PLACEMENT_MIN_EDGE
    : EDIT_REGION_MIN_EDGE;
  const activeReferenceBlob = referenceImage?.blob ?? null;
  const activeReferencePreviewUrl = referenceImage?.previewUrl ?? null;
  const referenceAspectRatio = referenceImage
    ? referenceImage.width / referenceImage.height
    : 1;
  const jobActive = Boolean(job && !terminalJobStates.has(job.state));
  const liveActivityJobs = publicActivityJobs(activity.jobs) as ActivityJob[];
  const queueTotal = liveActivityJobs.length;
  const queueBusy = liveActivityJobs.length > 0 || jobActive;
  const hasRecoverableWork =
    activity.queue.queued > 0 ||
    activity.activeRegions.some((active) => !active.reservationActive);
  const generationAvailable = Boolean(history?.editing.generationAvailable);
  const requestedModeAvailable = generationAvailable;
  const mobileSection = editOpen
    ? "contribute"
    : queueOpen
      ? "queue"
      : historyOpen
        ? "history"
        : "canvas";
  const canPanCanvas = canvasViewCanPan(view, viewport.width, viewport.height);
  const otherActiveRegions = activity.activeRegions.filter(
    (active) => active.jobId !== pendingEdit?.jobId,
  );
  const conflictingRegion = otherActiveRegions.find((active) =>
    regionsOverlap(editRegion, active.region),
  );
  const conflictingJobId = conflictingRegion?.jobId ?? null;
  const focusedJob = activity.jobs.find((activityJob) => activityJob.id === focusedJobId) ?? null;
  const focusedJobHasReservation = Boolean(
    focusedJob && activity.activeRegions.some((active) => active.jobId === focusedJob.id),
  );
  const latest = useRef({
    panelOpen,
    zoom: view.zoom,
    playing,
    selectedIndex,
    selectedRevisionId: selectedRevision?.id ?? null,
    revLen: revisions.length,
    editOpen,
    step,
    submitted,
    preparing: isPreparing,
    referenceActive: Boolean(referenceImage),
    editRegion,
    jobActive,
    history,
    currentState,
    welcomeOpen,
    activeRegions: activity.activeRegions,
    activityHasWork: liveActivityJobs.length > 0 || hasRecoverableWork,
  });
  useEffect(() => {
    latest.current = {
      panelOpen,
      zoom: view.zoom,
      playing,
      selectedIndex,
      selectedRevisionId: selectedRevision?.id ?? null,
      revLen: revisions.length,
      editOpen,
      step,
      submitted,
      preparing: isPreparing,
      referenceActive: Boolean(referenceImage),
      editRegion,
      jobActive,
      history,
      currentState,
      welcomeOpen,
      activeRegions: activity.activeRegions,
      activityHasWork: liveActivityJobs.length > 0 || hasRecoverableWork,
    };
  });

  useEffect(() => {
    const syncViewport = () => {
      const next = { width: window.innerWidth, height: window.innerHeight };
      setViewport((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
      setView((current) => constrainCanvasView(current, next.width, next.height));
    };
    syncViewport();
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, []);

  const armIdleTimers = useCallback(() => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (deepTimer.current) window.clearTimeout(deepTimer.current);
    if (!AUTO_HIDE) return;
    idleTimer.current = window.setTimeout(() => {
      if (!latest.current.panelOpen) setChromeVisible(false);
    }, IDLE_HIDE_MS);
    deepTimer.current = window.setTimeout(() => {
      if (!latest.current.panelOpen && latest.current.zoom === 1) setDeepIdle(true);
    }, DEEP_IDLE_MS);
  }, []);

  const wake = useCallback(() => {
    setChromeVisible(true);
    setDeepIdle(false);
    armIdleTimers();
  }, [armIdleTimers]);

  const closeWelcome = useCallback(() => {
    try {
      window.localStorage.setItem(WELCOME_STORAGE_KEY, "seen");
    } catch {
      // Private browsing and storage policies can make localStorage unavailable.
    }
    setWelcomeOpen(false);
    wake();
  }, [wake]);

  const openWelcome = useCallback(() => {
    setPlaying(false);
    setCompareOn(false);
    setQueueOpen(false);
    setHistoryOpen(false);
    setHoverIdx(-1);
    setDeepIdle(false);
    setChromeVisible(true);
    setWelcomeOpen(true);
    trackVisitorInteraction("guide_opened");
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const saveRetryCapabilities = useCallback(
    (update: (current: Record<string, RetryCapability>) => Record<string, RetryCapability>) => {
      setRetryCapabilitiesByJobId((current) => {
        const next = update(current);
        try {
          window.sessionStorage.setItem(
            RETRY_CAPABILITIES_STORAGE_KEY,
            JSON.stringify(next),
          );
        } catch {
          // The current page still retains capabilities when storage is unavailable.
        }
        return next;
      });
    },
    [],
  );

  const rememberRetryCapability = useCallback((jobId: string, token?: string) => {
    if (!token) return;
    saveRetryCapabilities((current) => ({
      ...current,
      [jobId]: { token },
    }));
  }, [saveRetryCapabilities]);

  const clearReferenceImage = useCallback(() => {
    if (referencePreviewUrlRef.current) {
      URL.revokeObjectURL(referencePreviewUrlRef.current);
      referencePreviewUrlRef.current = null;
    }
    if (referenceInputRef.current) referenceInputRef.current.value = "";
    setReferenceImage(null);
  }, []);

  const loadState = useCallback(async (revisionId: string) => {
    const cached = stateCache.current.get(revisionId);
    if (cached) return cached;
    const state = await fetchJson<ArtworkState>(
      `/api/artworks/palimpsest/state?revisionId=${encodeURIComponent(revisionId)}`,
    );
    stateCache.current.set(revisionId, state);
    return state;
  }, []);

  const refreshActivity = useCallback(() => {
    if (activityRequest.current) return activityRequest.current;
    const request = fetchJson<ActivityPayload>("/api/activity")
      .then((payload) => {
        const signature = activitySignature(payload);
        if (signature !== activitySignatureRef.current) {
          activitySignatureRef.current = signature;
          setActivity(payload);
        }
        return payload;
      })
      .finally(() => {
        activityRequest.current = null;
      });
    activityRequest.current = request;
    return request;
  }, []);

  const requestQueueDrain = useCallback(async () => {
    if (drainInFlight.current) return false;
    drainInFlight.current = true;
    try {
      const response = await fetch("/api/queue/drain", { method: "POST" });
      if (!response.ok) throw new Error("The queue could not be reached.");
      return true;
    } catch {
      // The durable job remains visible; bounded recovery clears a stopped worker.
      return false;
    } finally {
      drainInFlight.current = false;
    }
  }, []);

  const refreshHistory = useCallback(
    async (preferredRevisionId?: string | null) => {
      const payload = await fetchJson<HistoryPayload>(
        "/api/artworks/palimpsest/history",
      );
      stateCache.current.clear();
      setHistory(payload);
      const queryRevision =
        preferredRevisionId ??
        (typeof window !== "undefined"
          ? new URL(window.location.href).searchParams.get("revision")
          : null);
      const found = payload.revisions.findIndex((revision) => revision.id === queryRevision);
      const index = found >= 0 ? found : payload.revisions.length - 1;
      setSelectedIndex(index);
      const current = await loadState(payload.headRevisionId);
      setCurrentState(current);
      setSelectedState(
        payload.revisions[index]?.id === payload.headRevisionId
          ? current
          : await loadState(payload.revisions[index].id),
      );
      setLoadingError(null);
      return payload;
    },
    [loadState],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(WELCOME_STORAGE_KEY) !== "seen") {
          setWelcomeOpen(true);
        }
      } catch {
        setWelcomeOpen(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(
          window.sessionStorage.getItem(RETRY_CAPABILITIES_STORAGE_KEY) ?? "{}",
        ) as Record<string, unknown>;
        const capabilities = Object.fromEntries(
          Object.entries(stored).filter(
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
        setRetryCapabilitiesByJobId(capabilities);
      } catch {
        // Session storage can be disabled or contain an interrupted write.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      Promise.all([refreshHistory(), refreshActivity()]).catch((error: unknown) => {
        setLoadingError(error instanceof Error ? error.message : "The archive could not be opened.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshActivity, refreshHistory]);

  useEffect(() => {
    if (!hasRecoverableWork) return;
    let cancelled = false;
    let timer: number | null = null;
    let failedAttempts = 0;
    const recoverQueue = async () => {
      const drained = await requestQueueDrain();
      if (cancelled) return;
      const payload = await refreshActivity().catch(() => null);
      const stillRecoverable =
        payload &&
        (payload.queue.queued > 0 ||
          payload.activeRegions.some((active) => !active.reservationActive));
      if (cancelled || (payload && !stillRecoverable)) return;
      failedAttempts = drained ? 0 : failedAttempts + 1;
      timer = window.setTimeout(
        recoverQueue,
        queueRecoveryDelay(failedAttempts, Math.random()),
      );
    };
    timer = window.setTimeout(
      recoverQueue,
      queueRecoveryDelay(0, Math.random()),
    );
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [hasRecoverableWork, refreshActivity, requestQueueDrain]);

  useEffect(() => {
    armIdleTimers();
    const timers = [idleTimer, deepTimer, toastTimer, closeTimer];
    return () => {
      for (const timer of timers) {
        if (timer.current) window.clearTimeout(timer.current);
      }
    };
  }, [armIdleTimers]);

  useEffect(
    () => () => {
      if (referencePreviewUrlRef.current) {
        URL.revokeObjectURL(referencePreviewUrlRef.current);
        referencePreviewUrlRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedRevision) return;
    let active = true;
    loadState(selectedRevision.id)
      .then((state) => {
        if (active) {
          setSelectedState(state);
          setLoadingError(null);
        }
      })
      .catch((error: unknown) => {
        if (active) setLoadingError(error instanceof Error ? error.message : "That revision could not be opened.");
      });
    return () => {
      active = false;
    };
  }, [loadState, selectedRevision]);

  useEffect(() => {
    if (!playing || revisions.length === 0) return;
    const timer = window.setInterval(() => {
      const last = revisions.length - 1;
      const index = latest.current.selectedIndex;
      if (index >= last) {
        setPlaying(false);
        return;
      }
      setSelectedIndex(index + 1);
    }, 900);
    return () => window.clearInterval(timer);
  }, [playing, revisions.length]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (!document.hidden) void refreshActivity().catch(() => undefined);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshActivity]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      let hasWork = latest.current.activityHasWork;
      try {
        const payload = await refreshActivity();
        if (cancelled) return;
        hasWork =
          payload.queue.queued > 0 ||
          payload.queue.active > 0 ||
          payload.jobs.some(activityJobIsInProcess) ||
          payload.activeRegions.length > 0;
        const sharedHeadRevisionId = payload.recent[0]?.id ?? null;
        const current = latest.current;
        if (
          sharedHeadRevisionId &&
          current.history &&
          sharedHeadRevisionId !== current.history.headRevisionId
        ) {
          const followingHead =
            current.selectedRevisionId === current.history.headRevisionId;
          await refreshHistory(
            followingHead ? sharedHeadRevisionId : current.selectedRevisionId,
          );
        }
      } catch {
        // Collaboration is eventually consistent; the next bounded poll retries.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(
            poll,
            collaborationPollDelay(hasWork, document.hidden, Math.random()),
          );
        }
      }
    };
    timer = window.setTimeout(
      poll,
      collaborationPollDelay(latest.current.activityHasWork, document.hidden, Math.random()),
    );
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refreshActivity, refreshHistory]);

  useEffect(() => {
    if (!editOpen || submitted || !conflictingJobId) return;
    const active = latest.current.activeRegions.find(
      (region) => region.jobId === conflictingJobId,
    );
    if (!active) return;
    maskPointer.current = null;
    showToast(`${active.author} locked that area — your patch stayed exactly where you placed it.`);
  }, [conflictingJobId, editOpen, showToast, submitted]);

  useEffect(() => {
    if (!job || terminalJobStates.has(job.state)) return;
    const timer = window.setTimeout(async () => {
      try {
        const payload = await fetchJson<{ job: Job }>(`/api/jobs/${encodeURIComponent(job.id)}`);
        if (!terminalJobStates.has(payload.job.state)) {
          setJob(payload.job);
          return;
        }
        if (payload.job.state === "succeeded" && payload.job.resultRevisionId) {
          const refreshed = await refreshHistory(payload.job.resultRevisionId);
          const accepted = refreshed.revisions.find(
            (revision) => revision.id === payload.job.resultRevisionId,
          );
          if (accepted) {
            showToast(
              `${seqTag(accepted.sequence)} ${accepted.origin === "revert" ? "restored" : "accepted"} — ${accepted.author}`,
            );
          }
          setEditOpen(false);
          setEditBase(null);
          setSubmitted(false);
          setStep(1);
          setPrompt("");
          setStrokes([]);
          setFillMask(false);
          clearReferenceImage();
        } else {
          showToast(payload.job.message ?? payload.job.error?.message ?? "nothing was added to the work");
        }
        setJob(null);
        setPendingEdit(null);
        await refreshActivity();
      } catch {
        setJob((current) => (current ? { ...current } : current));
      }
    }, referenceImage ? 350 : 3000);
    return () => window.clearTimeout(timer);
  }, [
    clearReferenceImage,
    job,
    referenceImage,
    refreshActivity,
    refreshHistory,
    showToast,
  ]);

  useEffect(() => {
    if (!compareOn || selectedIndex <= 0) return;
    const previous = revisions[selectedIndex - 1];
    if (!previous) return;
    let active = true;
    loadState(previous.id)
      .then((state) => {
        if (active) setBeforeState(state);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [compareOn, loadState, revisions, selectedIndex]);

  useEffect(() => {
    if (!selectedRevision || !history || playing) return;
    const url = new URL(window.location.href);
    if (selectedRevision.id === history.headRevisionId) url.searchParams.delete("revision");
    else url.searchParams.set("revision", selectedRevision.id);
    window.history.replaceState({}, "", url);
  }, [history, playing, selectedRevision]);

  useEffect(() => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const { width, height } = editRegion;
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e0765f";
    context.clearRect(0, 0, width, height);
    context.fillStyle = `${accent}55`;
    context.strokeStyle = `${accent}99`;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (fillMask) {
      context.fillRect(0, 0, width, height);
    }
    for (const stroke of strokes) {
      const first = stroke.points[0];
      if (!first) continue;
      context.lineWidth = stroke.width;
      context.beginPath();
      context.moveTo(first.x, first.y);
      if (stroke.points.length === 1) {
        context.lineTo(first.x + 0.01, first.y + 0.01);
      } else {
        for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
  }, [editOpen, editRegion, fillMask, referenceImage, step, strokes, submitted]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((current) => {
      const zoom = Math.max(1, Math.min(4, current.zoom * factor));
      const scale = zoom / current.zoom;
      const next =
        zoom === current.zoom
          ? current
          : {
              zoom,
              x: cx - (cx - current.x) * scale,
              y: cy - (cy - current.y) * scale,
            };
      return constrainCanvasView(next, window.innerWidth, window.innerHeight);
    });
  }, []);

  const scrub = useCallback(
    (delta: number) => {
      if (!latest.current.revLen) return;
      setPlaying(false);
      setQueueOpen(false);
      setHistoryOpen(true);
      setSelectedIndex((index) =>
        Math.max(0, Math.min(latest.current.revLen - 1, index + delta)),
      );
      wake();
    },
    [wake],
  );

  const togglePlay = useCallback(() => {
    const current = latest.current;
    if (current.revLen < 2) return;
    const next = !current.playing;
    setQueueOpen(false);
    setHistoryOpen(true);
    setCompareOn(false);
    if (next && current.selectedIndex >= current.revLen - 1) setSelectedIndex(0);
    setPlaying(next);
    wake();
  }, [wake]);

  const toggleQueue = useCallback(() => {
    if (!queueOpen) trackVisitorInteraction("queue_opened");
    setQueueOpen((open) => !open);
    setEditOpen(false);
    setHistoryOpen(false);
    setPlaying(false);
    setCompareOn(false);
    setSubmitted(false);
    if (!localSubmissionFailure) clearReferenceImage();
    wake();
  }, [clearReferenceImage, localSubmissionFailure, queueOpen, wake]);

  const focusActivityJob = useCallback(
    (activityJob: ActivityJob) => {
      if (!activityJob.region) {
        showToast("This contribution applies to the whole revision, not one canvas region.");
        return;
      }
      setFocusedJobId(activityJob.id);
      setPlaying(false);
      setCompareOn(false);
      setView(
        constrainCanvasView(
          viewForActivityRegion(
            activityJob.region,
            window.innerWidth,
            window.innerHeight,
            ARTWORK_SIZE,
          ),
          window.innerWidth,
          window.innerHeight,
        ),
      );
      showToast(`${activityJobState(activityJob)} — showing ${activityJob.author}'s region`);
      wake();
    },
    [showToast, wake],
  );

  const openRecentRevision = useCallback(
    (revision: Revision) => {
      const index = revisions.findIndex((candidate) => candidate.id === revision.id);
      if (index < 0) return;
      setSelectedIndex(index);
      setQueueOpen(false);
      setHistoryOpen(true);
      setPlaying(false);
      setCompareOn(false);
      wake();
    },
    [revisions, wake],
  );

  const toggleHistory = useCallback(() => {
    if (!historyOpen) trackVisitorInteraction("history_opened");
    setHistoryOpen((open) => !open);
    setQueueOpen(false);
    setEditOpen(false);
    setEditBase(null);
    setPlaying(false);
    setCompareOn(false);
    setSubmitted(false);
    clearReferenceImage();
    wake();
  }, [clearReferenceImage, historyOpen, wake]);

  const openEditor = useCallback(async () => {
    const initial = latest.current;
    if (!initial.history || !initial.currentState || initial.jobActive) return;
    if (!initial.history.editing.generationAvailable) {
      showToast("image contributions are temporarily unavailable");
      return;
    }
    let activeRegions = initial.activeRegions;
    try {
      activeRegions = (await refreshActivity()).activeRegions;
    } catch {
      // The atomic server reservation remains authoritative if this refresh fails.
    }
    const current = latest.current;
    if (!current.history || !current.currentState || current.jobActive) return;
    setEditRegion(
      findOpenRegion(current.currentState.revision.sequence, activeRegions),
    );
    setEditBase({
      revisionId: current.currentState.revision.id,
      state: current.currentState,
    });
    setSelectedIndex(current.revLen - 1);
    setPlaying(false);
    setCompareOn(false);
    setQueueOpen(false);
    setHistoryOpen(false);
    setEditOpen(true);
    setStep(1);
    setStrokes([]);
    setFillMask(false);
    setPrompt("");
    clearReferenceImage();
    setLocalSubmissionFailure(null);
    setSubmitted(false);
    setSubmitError(null);
    setView({ zoom: 1, x: 0, y: 0 });
    trackVisitorInteraction("contribution_opened");
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    wake();
  }, [clearReferenceImage, refreshActivity, showToast, wake]);

  const closeEditor = useCallback(() => {
    setEditOpen(false);
    setSubmitted(false);
    if (!localSubmissionFailure) {
      setEditBase(null);
      clearReferenceImage();
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    wake();
  }, [clearReferenceImage, localSubmissionFailure, wake]);

  const closeAll = useCallback(() => {
    setEditOpen(false);
    if (!localSubmissionFailure) setEditBase(null);
    setQueueOpen(false);
    setHistoryOpen(false);
    setCompareOn(false);
    setPlaying(false);
    setSubmitted(false);
    setHoverIdx(-1);
    if (!localSubmissionFailure) clearReferenceImage();
    setView({ zoom: 1, x: 0, y: 0 });
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    wake();
  }, [clearReferenceImage, localSubmissionFailure, wake]);

  const returnToCurrent = useCallback(() => {
    if (!latest.current.revLen) return;
    setSelectedIndex(latest.current.revLen - 1);
    setPlaying(false);
    setCompareOn(false);
    wake();
  }, [wake]);

  const showCanvas = useCallback(() => {
    setEditOpen(false);
    setEditBase(null);
    setQueueOpen(false);
    setHistoryOpen(false);
    setFocusedJobId(null);
    setCompareOn(false);
    setPlaying(false);
    setSubmitted(false);
    setHoverIdx(-1);
    clearReferenceImage();
    if (latest.current.revLen) {
      setSelectedIndex(latest.current.revLen - 1);
    }
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    wake();
  }, [clearReferenceImage, wake]);

  const nudgePatch = useCallback((deltaX: number, deltaY: number) => {
    setEditRegion((region) =>
      positionEditRegion(region, region.x + deltaX, region.y + deltaY),
    );
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const current = latest.current;
      if (current.welcomeOpen) return;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          if (target?.closest?.("[role=slider], [data-canvas-pan], [data-patch-resize]")) {
            break;
          }
          if (current.editOpen) {
            const canMovePatch =
              current.step === 1 || (current.step === 3 && current.referenceActive);
            if (canMovePatch && !current.submitted && !current.preparing) {
              const amount = event.shiftKey ? 32 : 8;
              const deltas: Record<string, [number, number]> = {
                ArrowLeft: [-amount, 0],
                ArrowRight: [amount, 0],
                ArrowUp: [0, -amount],
                ArrowDown: [0, amount],
              };
              const [dx, dy] = deltas[event.key];
              nudgePatch(dx, dy);
              event.preventDefault();
            }
          } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            scrub(event.key === "ArrowLeft" ? -1 : 1);
            event.preventDefault();
          }
          break;
        }
        case " ":
          if (!current.editOpen) {
            event.preventDefault();
            togglePlay();
          }
          break;
        case "c":
        case "C":
          if (!current.editOpen) openEditor();
          break;
        case "q":
        case "Q":
          toggleQueue();
          break;
        case "Escape":
          closeAll();
          break;
        default:
          break;
      }
      wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAll, nudgePatch, openEditor, scrub, togglePlay, toggleQueue, wake]);

  const selectRevision = (index: number) => {
    setSelectedIndex(index);
    setPlaying(false);
    setCompareOn(false);
    wake();
  };

  const timelineIndexFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return timelineIndexAtPosition(
      event.clientX,
      bounds.left,
      bounds.width,
      revisions.length,
    );
  };

  const timelineDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    timelineDrag.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    setTimelineDragging(true);
    const index = timelineIndexFromPointer(event);
    setHoverIdx(index);
    selectRevision(index);
    event.preventDefault();
  };

  const timelineMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const index = timelineIndexFromPointer(event);
    setHoverIdx(index);
    if (timelineDrag.current === event.pointerId && index !== latest.current.selectedIndex) {
      selectRevision(index);
    }
  };

  const timelineUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (timelineDrag.current !== event.pointerId) return;
    timelineDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setTimelineDragging(false);
    setHoverIdx(-1);
  };

  const timelineKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = revisions.length - 1;
    let index: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      index = Math.max(0, selectedIndex - 1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      index = Math.min(last, selectedIndex + 1);
    } else if (event.key === "Home") {
      index = 0;
    } else if (event.key === "End") {
      index = last;
    }
    if (index === null) return;
    event.preventDefault();
    selectRevision(index);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".mono-welcome, .mono-activity-scroll")) return;
    const unit =
      event.deltaMode === 1
        ? event.deltaY * 33
        : event.deltaMode === 2
          ? event.deltaY * window.innerHeight
          : event.deltaY;
    const factor = Math.max(0.5, Math.min(2, Math.pow(1.12, -unit / 100)));
    zoomAt(event.clientX, event.clientY, factor);
    wake();
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, .mono-strip, .mono-compare-handle, .mono-welcome")) return;
    if (view.zoom > 1) setView({ zoom: 1, x: 0, y: 0 });
    else zoomAt(event.clientX, event.clientY, 2);
    wake();
  };

  const panDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    panStart.current = {
      pointerId: event.pointerId,
      x: event.clientX - view.x,
      y: event.clientY - view.y,
    };
    setPanning(true);
    setPanPointerFocused(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const panMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panStart.current || panStart.current.pointerId !== event.pointerId) return;
    const start = panStart.current;
    setView((current) =>
      constrainCanvasView(
        { ...current, x: event.clientX - start.x, y: event.clientY - start.y },
        window.innerWidth,
        window.innerHeight,
      ),
    );
  };

  const panUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panStart.current?.pointerId !== event.pointerId) return;
    panStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanning(false);
  };

  const panKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? 120 : 48;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [amount, 0],
      ArrowRight: [-amount, 0],
      ArrowUp: [0, amount],
      ArrowDown: [0, -amount],
    };
    if (event.key !== "Home" && !deltas[event.key]) return;
    event.preventDefault();
    event.stopPropagation();
    setPanPointerFocused(false);
    setView((current) => {
      const [deltaX, deltaY] = deltas[event.key] ?? [0, 0];
      const next =
        event.key === "Home"
          ? { ...current, x: 0, y: 0 }
          : { ...current, x: current.x + deltaX, y: current.y + deltaY };
      return constrainCanvasView(next, window.innerWidth, window.innerHeight);
    });
    wake();
  };

  const compareDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    compareDrag.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const compareMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!compareDrag.current) return;
    setComparePos(Math.max(2, Math.min(98, (event.clientX / window.innerWidth) * 100)));
  };

  const compareUp = () => {
    compareDrag.current = false;
  };

  const compareKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const delta = event.key === "ArrowLeft" ? -2 : 2;
    setComparePos((position) => Math.max(2, Math.min(98, position + delta)));
    event.preventDefault();
  };

  const artworkPoint = (event: ReactPointerEvent<Element>) => {
    const rect = overlayCoverRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * ARTWORK_SIZE,
      y: ((event.clientY - rect.top) / rect.height) * ARTWORK_SIZE,
    };
  };

  const patchDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!patchCanMove) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-patch-resize]")) return;
    const point = artworkPoint(event);
    if (!point) return;
    patchDrag.current = {
      pointerId: event.pointerId,
      x: point.x - editRegion.x,
      y: point.y - editRegion.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    event.preventDefault();
  };

  const patchMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!patchDrag.current || patchDrag.current.pointerId !== event.pointerId) return;
    const point = artworkPoint(event);
    if (!point) return;
    const offset = patchDrag.current;
    setEditRegion((region) =>
      positionEditRegion(region, point.x - offset.x, point.y - offset.y),
    );
  };

  const patchUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (patchDrag.current?.pointerId !== event.pointerId) return;
    patchDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizePatch = (desiredWidth: number, desiredHeight: number) => {
    setEditRegion((region) =>
      referenceImage
        ? resizeReferencePlacementRegion(
            region,
            desiredWidth,
            desiredHeight,
            referenceAspectRatio,
          )
        : resizeEditRegion(
            region,
            desiredWidth,
            desiredHeight,
            patchMinimumEdge,
          ),
    );
  };

  const resizePatchBy = (amount: number) => {
    setEditRegion((region) =>
      referenceImage
        ? resizeReferencePlacementRegion(
            region,
            region.width + amount,
            region.height + amount,
            referenceAspectRatio,
          )
        : resizeEditRegion(
            region,
            region.width + amount,
            region.height + amount,
            patchMinimumEdge,
          ),
    );
    wake();
  };

  const patchResizeDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!patchCanResize) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = artworkPoint(event);
    if (!point) return;
    patchResize.current = {
      pointerId: event.pointerId,
      edgeOffsetX: editRegion.x + editRegion.width - point.x,
      edgeOffsetY: editRegion.y + editRegion.height - point.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    event.stopPropagation();
    event.preventDefault();
  };

  const patchResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = patchResize.current;
    if (resize?.pointerId !== event.pointerId) return;
    const point = artworkPoint(event);
    if (!point) return;
    setEditRegion((region) =>
      referenceImage
        ? resizeReferencePlacementRegion(
            region,
            point.x + resize.edgeOffsetX - region.x,
            point.y + resize.edgeOffsetY - region.y,
            referenceAspectRatio,
          )
        : resizeEditRegion(
            region,
            point.x + resize.edgeOffsetX - region.x,
            point.y + resize.edgeOffsetY - region.y,
            patchMinimumEdge,
          ),
    );
    event.stopPropagation();
  };

  const patchResizeUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (patchResize.current?.pointerId !== event.pointerId) return;
    patchResize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.stopPropagation();
  };

  const patchResizeKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const amount = event.shiftKey ? PATCH_SIZE_STEP * 2 : PATCH_SIZE_STEP;
    let widthDelta = 0;
    let heightDelta = 0;
    if (event.key === "ArrowLeft") widthDelta = -amount;
    else if (event.key === "ArrowRight") widthDelta = amount;
    else if (event.key === "ArrowUp") heightDelta = -amount;
    else if (event.key === "ArrowDown") heightDelta = amount;
    else if (event.key === "Home") {
      resizePatch(patchMinimumEdge, patchMinimumEdge);
    } else if (event.key === "End") {
      resizePatch(EDIT_REGION_MAX_EDGE, EDIT_REGION_MAX_EDGE);
    } else {
      return;
    }
    if (widthDelta !== 0 || heightDelta !== 0) {
      setEditRegion((region) =>
        referenceImage
          ? resizeReferencePlacementRegion(
              region,
              region.width + widthDelta,
              region.height + heightDelta,
              referenceAspectRatio,
            )
          : resizeEditRegion(
              region,
              region.width + widthDelta,
              region.height + heightDelta,
              patchMinimumEdge,
            ),
      );
    }
    event.preventDefault();
    event.stopPropagation();
    wake();
  };

  const maskPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const { width, height } = editRegion;
    return {
      x: Math.round(Math.max(0, Math.min(width, ((event.clientX - rect.left) / rect.width) * width))),
      y: Math.round(Math.max(0, Math.min(height, ((event.clientY - rect.top) / rect.height) * height))),
    };
  };

  const maskDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (step !== 2 || submitted || conflictingRegion) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    maskPointer.current = event.pointerId;
    setFillMask(false);
    const point = maskPoint(event);
    setStrokes((current) => [...current, { width: BRUSH_WIDTH, points: [point] }]);
    event.preventDefault();
  };

  const maskMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (
      conflictingRegion ||
      maskPointer.current !== event.pointerId ||
      event.buttons === 0
    ) return;
    const point = maskPoint(event);
    setStrokes((current) => {
      const last = current.at(-1);
      const previous = last?.points.at(-1);
      if (!last || !previous) return current;
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < 2) return current;
      return [...current.slice(0, -1), { ...last, points: [...last.points, point] }];
    });
  };

  const maskUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (maskPointer.current === event.pointerId) maskPointer.current = null;
  };

  const cleanDisplayName = () => {
    const name = displayName.replace(/\s+/g, " ").trim();
    return name.length >= 2 ? name : "";
  };

  const selectReferenceImage = async (event: ReactChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (!REFERENCE_IMAGE_TYPES.has(file.type)) {
      event.currentTarget.value = "";
      setSubmitError("Use a PNG, JPEG, or WebP reference image.");
      return;
    }
    if (file.size > MAX_REFERENCE_UPLOAD_BYTES) {
      event.currentTarget.value = "";
      setSubmitError("Reference images must be 10 MB or smaller.");
      return;
    }
    setSubmitError(null);
    setIsPreparing(true);
    try {
      const normalized = await normalizeReferenceImage(file);
      const placementRegion = initialReferencePlacementRegion(
        latest.current.editRegion,
        normalized.width / normalized.height,
      );
      if (referencePreviewUrlRef.current) {
        URL.revokeObjectURL(referencePreviewUrlRef.current);
      }
      const previewUrl = URL.createObjectURL(normalized.blob);
      referencePreviewUrlRef.current = previewUrl;
      setEditRegion(placementRegion);
      setStrokes([]);
      setFillMask(true);
      setStep(3);
      setReferenceImage({
        blob: normalized.blob,
        fileName: file.name,
        height: normalized.height,
        previewUrl,
        sourceBlob: file,
        width: normalized.width,
      });
      showToast("Reference preview ready — position it for GPT Image to isolate and blend.");
      trackVisitorInteraction("reference_added");
    } catch (error) {
      event.currentTarget.value = "";
      setSubmitError(
        error instanceof Error ? error.message : "The reference image could not be prepared.",
      );
    } finally {
      setIsPreparing(false);
    }
  };

  const canSubmit =
    !isPreparing &&
    !submitted &&
    !jobActive &&
    requestedModeAvailable &&
    !conflictingRegion &&
    prompt.trim().length >= 3 &&
    validMask &&
    step === 3;

  const submitEdit = async () => {
    if (!editBase || !canSubmit) return;
    setSubmitError(null);
    setIsPreparing(true);
    const frame = generationFrameForRegion(editRegion);
    const meta = {
      artworkId: "palimpsest",
      baseRevisionId: editBase.revisionId,
      displayName: cleanDisplayName(),
      prompt: prompt.trim(),
      region: editRegion,
      frame,
      fill: fillMask,
      strokes,
    };
    const payloadFingerprint = JSON.stringify({
      meta,
      reference: referenceImage
        ? {
            fileName: referenceImage.fileName,
            size: referenceImage.sourceBlob.size,
            type: referenceImage.sourceBlob.type,
          }
        : null,
    });
    const idempotencyKey =
      localSubmissionFailure?.payloadFingerprint === payloadFingerprint &&
      localSubmissionFailure.idempotencyKey
        ? localSubmissionFailure.idempotencyKey
        : crypto.randomUUID();
    const retryToken =
      localSubmissionFailure?.payloadFingerprint === payloadFingerprint &&
      localSubmissionFailure.retryToken
        ? localSubmissionFailure.retryToken
        : crypto.randomUUID();
    try {
      const [source, mask, reference] = await Promise.all([
        flattenArtworkFrame(editBase.state, frame),
        providerMask(editRegion, frame, strokes, fillMask),
        referenceImage && activeReferenceBlob
          ? referenceGuideLayer(activeReferenceBlob, editRegion, frame)
          : Promise.resolve(null),
      ]);
      const form = new FormData();
      form.append("meta", JSON.stringify(meta));
      form.append("source", source, "source.png");
      form.append("mask", mask, "mask.png");
      if (reference) {
        form.append("reference", reference, "reference.png");
      }
      const sessionId = visitorSessionId();
      const payload = await fetchJson<{ job: Job }>("/api/edits", {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "X-Palimpsest-Retry-Token": retryToken,
          ...(sessionId ? { "X-Palimpsest-Session": sessionId } : {}),
        },
        body: form,
      });
      rememberRetryCapability(payload.job.id, payload.job.retryToken ?? retryToken);
      setLocalSubmissionFailure(null);
      if (terminalJobStates.has(payload.job.state)) {
        setJob(null);
        setPendingEdit(null);
        setSubmitted(false);
        if (payload.job.state === "succeeded" && payload.job.resultRevisionId) {
          await refreshHistory(payload.job.resultRevisionId);
          setEditOpen(false);
          setEditBase(null);
          setStep(1);
          setPrompt("");
          setStrokes([]);
          setFillMask(false);
          clearReferenceImage();
          showToast("This contribution was already accepted.");
        } else {
          const message =
            payload.job.error?.message ??
            payload.job.message ??
            "This contribution could not be completed.";
          setSubmitError(message);
          setEditOpen(false);
          setQueueOpen(true);
          showToast(message);
        }
        await refreshActivity();
        return;
      }
      setJob(payload.job);
      setPendingEdit({
        jobId: payload.job.id,
        author: cleanDisplayName() || "anonymous visitor",
        prompt: prompt.trim(),
        region: { ...editRegion },
      });
      setSubmitted(true);
      void requestQueueDrain();
      await refreshActivity();
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => {
        setEditOpen(false);
        setSubmitted(false);
        clearReferenceImage();
      }, 2400);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The edit could not be submitted.";
      const requestError = error instanceof PalimpsestRequestError ? error : null;
      setSubmitError(message);
      setLocalSubmissionFailure({
        id: `local-${requestError?.requestId ?? crypto.randomUUID()}`,
        author: cleanDisplayName() || "anonymous visitor",
        prompt: prompt.trim(),
        region: { ...editRegion },
        errorCode: requestError?.code ?? null,
        errorMessage: message,
        requestId: requestError?.requestId ?? null,
        updatedAt: new Date().toISOString(),
        idempotencyKey,
        retryToken,
        payloadFingerprint,
      });
      try {
        await refreshActivity();
      } catch {
        // The next collaboration poll retries if the activity refresh also fails.
      }
    } finally {
      setIsPreparing(false);
    }
  };

  const zoomStyle = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` };
  const zoomClass = `mono-zoom${panning ? " is-panning" : ""}`;
  const chromeState = playing ? " is-dimmed" : chromeShown ? "" : " is-hidden";

  const compareReady =
    compareOn &&
    Boolean(previousRevision) &&
    beforeState?.revision.id === previousRevision?.id;

  const echoRegion = showHistory && !playing ? selectedRevision?.region ?? null : null;
  const echoStyle = echoRegion ? regionStyle(echoRegion) : undefined;
  const patchStyle = regionStyle(editRegion);
  const patchMaximumWidth = Math.min(
    EDIT_REGION_MAX_EDGE,
    ARTWORK_SIZE - editRegion.x,
  );
  const patchMaximumHeight = Math.min(
    EDIT_REGION_MAX_EDGE,
    ARTWORK_SIZE - editRegion.y,
  );

  const hoverRevision = hoverIdx >= 0 ? revisions[hoverIdx] ?? null : null;
  const tickLeft = (index: number) =>
    revisions.length > 1 ? (index / (revisions.length - 1)) * 100 : 50;

  const submitLabel = submitted
    ? "reserved ✓"
    : isPreparing
      ? "preparing…"
      : jobActive
        ? referenceImage
          ? "blending reference…"
          : "your edit is making…"
        : !requestedModeAvailable
          ? "live AI unavailable"
          : referenceImage
            ? "blend reference →"
            : "generate live →";

  return (
    <main
      className="mono-stage"
      onPointerMove={wake}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
    >
      <div className={zoomClass} style={zoomStyle}>
        <div className={`mono-kenburns${deepIdle ? " is-drifting" : ""}`}>
          <div className="mono-cover">
            {selectedState ? (
              <ArtworkLayers state={selectedState} />
            ) : (
              <img
                className="mono-seed"
                src="/seed/canonical.png"
                alt="Palimpsest communal artwork"
              />
            )}
          </div>
        </div>
      </div>

      {compareReady && beforeState ? (
        <div
          className="mono-compare-clip"
          style={{ clipPath: `inset(0 ${100 - comparePos}% 0 0)` }}
          aria-hidden="true"
        >
          <div className={zoomClass} style={zoomStyle}>
            <div className="mono-cover">
              <ArtworkLayers state={beforeState} />
            </div>
          </div>
        </div>
      ) : null}

      {canPanCanvas ? (
        <div
          className={`mono-pan${panPointerFocused ? " is-pointer-focused" : ""}`}
          data-canvas-pan
          data-testid="canvas-pan"
          role="group"
          tabIndex={0}
          aria-label="Artwork viewport. Drag to explore hidden areas. Use the arrow keys to move around and Home to recenter."
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home"
          onPointerDown={panDown}
          onPointerMove={panMove}
          onPointerUp={panUp}
          onPointerCancel={panUp}
          onKeyDown={panKey}
          onBlur={() => setPanPointerFocused(false)}
        />
      ) : null}

      {echoRegion ||
      editOpen ||
      otherActiveRegions.length > 0 ||
      (focusedJob?.region && activityJobIsInProcess(focusedJob)) ||
      (jobActive && pendingEdit?.region) ? (
        <div className={`${zoomClass} mono-overlays`} style={zoomStyle}>
          <div className="mono-cover" ref={overlayCoverRef}>
            {echoRegion && selectedRevision ? (
              <div className="mono-echo" style={echoStyle} aria-hidden="true">
                <span>{seqTag(selectedRevision.sequence)} changed here</span>
              </div>
            ) : null}
            <div
              className="mono-reservations"
              role="list"
              aria-label="Live reserved regions"
              aria-live="polite"
            >
              {otherActiveRegions.map((active) => (
                <div
                  key={active.jobId}
                  className={`mono-reservation${
                    active.state === "generating" || active.state === "committing"
                      ? " is-active"
                      : ""
                  }${!active.reservationActive ? " is-recovering" : ""}${
                    active.jobId === focusedJobId ? " is-focused" : ""
                  }`}
                  data-testid="active-reservation"
                  style={regionStyle(active.region)}
                  role="listitem"
                  aria-label={`${active.author}, ${activeStateLabel(active)}, region ${active.region.x}, ${active.region.y}, ${active.region.width} by ${active.region.height}`}
                >
                  <span>
                    {active.author} · {activeStateLabel(active)}
                  </span>
                </div>
              ))}
              {jobActive && pendingEdit?.region && job ? (
                <div
                  className="mono-reservation is-local is-active"
                  data-testid="local-reservation"
                  style={regionStyle(pendingEdit.region)}
                  role="listitem"
                  aria-label={`Your region, ${jobStateLabel(job.state)}`}
                >
                  <span>you · {jobStateLabel(job.state)}</span>
                </div>
              ) : null}
              {focusedJob?.region &&
              activityJobIsInProcess(focusedJob) &&
              !focusedJobHasReservation ? (
                <div
                  className="mono-reservation is-focused is-recovering"
                  style={regionStyle(focusedJob.region)}
                  role="listitem"
                  aria-label={`${focusedJob.author}, ${activityJobState(focusedJob)}, focused region`}
                >
                  <span>{focusedJob.author} · {activityJobState(focusedJob)}</span>
                </div>
              ) : null}
            </div>
            {editOpen ? (
              <div
                className={`mono-patch${patchCanMove ? " is-draggable" : " is-set"}${step === 2 && !submitted ? " is-masking" : ""}${referenceImage && step === 3 ? " is-reference-placement" : ""}${conflictingRegion ? " is-unavailable" : ""}`}
                style={patchStyle}
                data-testid="edit-patch"
                role="group"
                tabIndex={patchCanMove ? 0 : -1}
                aria-label={
                  step === 3 && referenceImage && !submitted
                    ? `${referenceImage.fileName}, reference preview at ${editRegion.x}, ${editRegion.y}, ${editRegion.width} by ${editRegion.height} pixels. GPT Image will blend the generated result into this area. Drag to move, pull the lower-right corner to resize, or use the arrow keys to nudge it.`
                    : `Selected edit patch, ${editRegion.width} by ${editRegion.height} pixels. Drag to move it, pull the lower-right corner to resize it, or use the arrow keys to nudge it.`
                }
                aria-describedby={conflictingRegion ? "overlap-note" : undefined}
                onPointerDown={patchDown}
                onPointerMove={patchMove}
                onPointerUp={patchUp}
                onPointerCancel={patchUp}
              >
                {patchCanResize ? (
                  <>
                    <span className="mono-patch-size" aria-hidden="true">
                      {editRegion.width} × {editRegion.height}
                    </span>
                    {step === 1 ? (
                      <span className="mono-patch-label">drag to move</span>
                    ) : null}
                    <button
                      type="button"
                      className="mono-patch-resize"
                      data-patch-resize
                      data-testid="patch-resize-handle"
                      aria-label={`Resize edit patch, currently ${editRegion.width} by ${editRegion.height} pixels. Drag the handle, or use arrow keys; Home selects the minimum and End the maximum.`}
                      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
                      onPointerDown={patchResizeDown}
                      onPointerMove={patchResizeMove}
                      onPointerUp={patchResizeUp}
                      onPointerCancel={patchResizeUp}
                      onKeyDown={patchResizeKey}
                    />
                  </>
                ) : null}
                {referenceImage && step === 3 && !submitted ? (
                  <div className="mono-reference-on-canvas" aria-hidden="true">
                    <div
                      className="mono-reference-safe-zone"
                      style={referencePreviewStyle()}
                    >
                      <img src={activeReferencePreviewUrl ?? ""} alt="" />
                    </div>
                    <span>reference preview · drag or resize</span>
                  </div>
                ) : null}
                {step >= 2 && !submitted && !(step === 3 && referenceImage) ? (
                  <canvas
                    ref={maskCanvasRef}
                    className={`mono-mask-canvas${step !== 2 ? " is-locked" : ""}${conflictingRegion ? " is-blocked" : ""}`}
                    width={editRegion.width}
                    height={editRegion.height}
                    aria-label="Drag to paint the part of this patch that may change. Use the entire patch button for a keyboard-accessible alternative."
                    aria-disabled={Boolean(conflictingRegion)}
                    onPointerDown={maskDown}
                    onPointerMove={maskMove}
                    onPointerUp={maskUp}
                    onPointerCancel={maskUp}
                  />
                ) : null}
                {step === 2 && !submitted && !validMask ? (
                  <span className="mono-mask-instruction" aria-hidden="true">
                    <span className="mono-mask-brush" />
                    <span>
                      drag to paint
                      <br />
                      what may change
                    </span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={`mono-scrim-top${chromeState}`} aria-hidden="true" />
      <div
        className={`mono-scrim-bottom${panelOpen ? " is-raised" : ""}${chromeState}`}
        aria-hidden="true"
      />

      {compareReady && previousRevision && selectedRevision ? (
        <>
          <div className="mono-compare-line" style={{ left: `${comparePos}%` }} aria-hidden="true" />
          <div
            className="mono-compare-handle"
            style={{ left: `${comparePos}%` }}
            role="slider"
            tabIndex={0}
            aria-label="Before and current divider"
            aria-valuemin={2}
            aria-valuemax={98}
            aria-valuenow={Math.round(comparePos)}
            onPointerDown={compareDown}
            onPointerMove={compareMove}
            onPointerUp={compareUp}
            onPointerCancel={compareUp}
            onKeyDown={compareKey}
          >
            <span />
          </div>
          <div className="mono-compare-label is-before">
            before · {seqTag(previousRevision.sequence)}
          </div>
          <div className="mono-compare-label is-after">
            current · {seqTag(selectedRevision.sequence)}
          </div>
        </>
      ) : null}

      <button
        className={`mono-chrome mono-drift mono-wordmark${chromeState}`}
        type="button"
        aria-label="Palimpsest — return to the current revision"
        onClick={returnToCurrent}
      >
        Palimpsest
      </button>
      <div className={`mono-chrome mono-drift mono-topright${chromeState}`}>
        <button
          type="button"
          className="mono-guide-toggle"
          aria-haspopup="dialog"
          aria-controls="welcome-dialog"
          aria-expanded={welcomeOpen}
          aria-label={editOpen ? "Guide unavailable while contributing" : "Open welcome guide"}
          disabled={editOpen}
          onClick={openWelcome}
        >
          guide
        </button>
        <button
          type="button"
          className="mono-queue-toggle"
          aria-label={`Queue, ${liveActivityJobs.length} in process`}
          aria-controls="contribution-activity"
          aria-expanded={queueOpen}
          onClick={toggleQueue}
        >
          <span className={`mono-live-dot${queueBusy ? " is-pulsing" : ""}`} aria-hidden="true" />
          <span>queue/{queueTotal}</span>
        </button>
        <button
          type="button"
          className="mono-contribute"
          aria-label={
            jobActive
              ? "Your contribution is still being made"
              : generationAvailable
                ? "Contribute an image or live AI edit"
                : "Image contributions are temporarily unavailable"
          }
          disabled={jobActive || !generationAvailable}
          onClick={openEditor}
        >
          contribute
        </button>
      </div>

      {!editOpen && !welcomeOpen ? (
        <nav className="mono-mobile-dock" aria-label="Primary mobile navigation">
          <button
            type="button"
            className={mobileSection === "canvas" ? "is-active" : ""}
            aria-label="Show current canvas"
            aria-pressed={mobileSection === "canvas"}
            onClick={showCanvas}
          >
            <MobileDockIcon name="canvas" />
            <span>Canvas</span>
          </button>
          <button
            type="button"
            className={mobileSection === "history" ? "is-active" : ""}
            aria-label="Open revision history"
            aria-controls="revision-history"
            aria-expanded={historyOpen}
            aria-pressed={mobileSection === "history"}
            onClick={toggleHistory}
          >
            <MobileDockIcon name="history" />
            <span>History</span>
          </button>
          <button
            type="button"
            className={mobileSection === "queue" ? "is-active" : ""}
            aria-label={`Open contribution activity, ${queueTotal} shown`}
            aria-controls="contribution-activity"
            aria-expanded={queueOpen}
            aria-pressed={mobileSection === "queue"}
            onClick={toggleQueue}
          >
            <MobileDockIcon name="queue" />
            <span>Queue {queueTotal}</span>
          </button>
          <button
            type="button"
            className={`is-contribute${mobileSection === "contribute" ? " is-active" : ""}`}
            aria-label={
              jobActive
                ? "Your contribution is still being made"
                : generationAvailable
                  ? "Contribute with live AI"
                  : "Live AI editing is temporarily unavailable"
            }
            aria-controls="contribution-editor"
            aria-pressed={mobileSection === "contribute"}
            disabled={jobActive || !generationAvailable}
            onClick={() => void openEditor()}
          >
            <MobileDockIcon name="contribute" />
            <span>Contribute</span>
          </button>
        </nav>
      ) : null}

      {playing && selectedRevision ? (
        <div className="mono-ghost" aria-hidden="true">
          {seqTag(selectedRevision.sequence)}
        </div>
      ) : null}

      {toast ? (
        <div className="mono-toast-wrap">
          <div className="mono-toast" role="status">
            {toast}
          </div>
        </div>
      ) : null}

      {!panelOpen ? (
        <>
          <div className={`mono-chrome mono-revlabel${chromeState}`} aria-live="polite">
            {selectedRevision
              ? `${seqTag(selectedRevision.sequence)} — ${selectedRevision.author}`
              : "opening the archive…"}
          </div>
          <div className={`mono-chrome mono-hints${chromeState}`}>
            {canPanCanvas ? (
              <span className="mono-pan-hint" aria-hidden="true">
                drag to move ·
              </span>
            ) : null}
            <span className="mono-hint-text">
              scroll to zoom · double-click to zoom · ←→ scrub · space play
            </span>
            <span className="mono-zoom-control">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.8)}
              >
                [−]
              </button>
              {Math.round(view.zoom * 100)}%
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25)}
              >
                [+]
              </button>
            </span>
          </div>
          <div
            className="mono-hotspot"
            aria-hidden="true"
            onPointerEnter={() => {
              setHistoryOpen(true);
              wake();
            }}
            onClick={() => {
              setHistoryOpen(true);
              wake();
              trackVisitorInteraction("history_opened");
            }}
          />
        </>
      ) : null}

      {showHistory && selectedRevision && headRevision ? (
        <section
          id="revision-history"
          className="mono-strip mono-history-strip"
          aria-label="Revision history"
          onPointerLeave={(event) => {
            if (event.pointerType !== "mouse" || playing || compareOn) return;
            setHistoryOpen(false);
            setHoverIdx(-1);
            wake();
          }}
        >
          <div className="mono-mobile-panel-head">
            <span>revision history</span>
            <button
              type="button"
              aria-label="Close revision history"
              onClick={toggleHistory}
            >
              ×
            </button>
          </div>
          <div className="mono-history-row">
            <button
              type="button"
              className="mono-play"
              aria-label={playing ? "Pause timelapse" : "Play timelapse"}
              onClick={togglePlay}
            >
              {playing ? "[⏸]" : "[▶]"}
            </button>
            <div
              className={`mono-track${timelineDragging ? " is-dragging" : ""}`}
              role="slider"
              tabIndex={0}
              aria-label="Revision timeline"
              aria-orientation="horizontal"
              aria-valuemin={revisions[0]?.sequence ?? 0}
              aria-valuemax={headRevision.sequence}
              aria-valuenow={selectedRevision.sequence}
              aria-valuetext={`${seqTag(selectedRevision.sequence)} — ${selectedRevision.author}`}
              data-testid="revision-timeline"
              title="Drag to scrub revisions"
              onPointerDown={timelineDown}
              onPointerMove={timelineMove}
              onPointerUp={timelineUp}
              onPointerCancel={timelineUp}
              onPointerLeave={() => {
                if (timelineDrag.current === null) setHoverIdx(-1);
              }}
              onKeyDown={timelineKey}
            >
              <span className="mono-track-line" aria-hidden="true" />
              {revisions.map((revision, index) => (
                <span
                  key={revision.id}
                  className={`mono-tick${
                    index === selectedIndex
                      ? " is-selected"
                      : index === hoverIdx
                        ? " is-hovered"
                        : ""
                  }`}
                  style={{ left: `${tickLeft(index)}%` }}
                  aria-hidden="true"
                >
                  <span />
                </span>
              ))}
              {hoverRevision ? (
                <div className="mono-tip" style={{ left: `${tickLeft(hoverIdx)}%` }}>
                  {seqTag(hoverRevision.sequence)} · {hoverRevision.author} ·{" "}
                  {hoverRevision.prompt}
                </div>
              ) : null}
            </div>
            <output className="mono-counter">
              {pad3(selectedRevision.sequence)} / {pad3(headRevision.sequence)}
            </output>
          </div>
          <div className="mono-meta-row">
            <span className="mono-meta">
              {selectedRevision.author} · &quot;{selectedRevision.prompt}&quot;
            </span>
            <div className="mono-meta-actions">
              <button
                type="button"
                className={`mono-action${compareOn ? " is-accent" : ""}`}
                disabled={selectedIndex === 0}
                aria-pressed={compareOn}
                onClick={() => {
                  if (selectedIndex === 0) return;
                  setCompareOn((value) => !value);
                  setPlaying(false);
                  wake();
                }}
              >
                {compareOn ? "[x] compare" : "[ ] compare"}
              </button>
              {notCurrent ? (
                <button type="button" className="mono-action is-accent" onClick={returnToCurrent}>
                  return to current
                </button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {queueOpen ? (
        <section
          id="contribution-activity"
          className="mono-strip mono-activity-strip mono-queue-strip"
          aria-label="Contribution activity"
        >
          <div className="mono-strip-head">
            <span className="mono-strip-summary">
              live work — {liveActivityJobs.length} in process
              {liveActivityJobs.length > 0 ? " · use show to find work on the canvas" : ""}
            </span>
            <button
              type="button"
              className="mono-strip-close"
              aria-label="Close queue"
              onClick={toggleQueue}
            >
              ×
            </button>
          </div>
          <div className="mono-activity-scroll">
            <section className="mono-activity-group" aria-labelledby="activity-jobs-title">
              <div className="mono-activity-group-head">
                <h2 id="activity-jobs-title">contributions</h2>
                <span>{liveActivityJobs.length} shown</span>
              </div>
              {liveActivityJobs.length === 0 ? (
                <p className="mono-queue-empty">
                  No contributions are currently in process.
                </p>
              ) : (
                <div className="mono-queue-list" role="list" aria-live="polite">
                  {liveActivityJobs.map((activityJob, index) => {
                    const state = activityJobState(activityJob);
                    const canShow = Boolean(activityJob.region);
                    return (
                      <article
                        key={activityJob.id}
                        className={`mono-queue-entry is-${state}`}
                        style={{ "--stagger": `${index * 40}ms` } as CSSProperties}
                        role="listitem"
                      >
                        <div className="mono-queue-entry-head">
                          <span className="mono-queue-author">{activityJob.author}</span>
                          <span className="mono-queue-state is-accent">{state}</span>
                          <time
                            dateTime={activityJob.updatedAt}
                            title={new Date(activityJob.updatedAt).toLocaleString()}
                          >
                            updated {compactTime(activityJob.updatedAt)} ago
                          </time>
                        </div>
                        <p className="mono-queue-summary">{activityJob.displaySummary}</p>
                        <div className="mono-queue-detail">
                          <span>submitted {compactTime(activityJob.submittedAt)} ago</span>
                          {activityJob.requestId ? (
                            <span>request {activityJob.requestId}</span>
                          ) : null}
                        </div>
                        {canShow ? (
                          <div className="mono-queue-actions">
                            <button
                              type="button"
                              aria-pressed={focusedJobId === activityJob.id}
                              onClick={() => focusActivityJob(activityJob)}
                            >
                              {focusedJobId === activityJob.id ? "shown" : "show"}
                            </button>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            {activity.recent.length > 0 ? (
              <section className="mono-activity-group is-history" aria-labelledby="activity-history-title">
                <div className="mono-activity-group-head">
                  <h2 id="activity-history-title">accepted revisions</h2>
                  <span>permanent history</span>
                </div>
                <div className="mono-activity-history-list">
                  {activity.recent.map((revision) => (
                    <button
                      key={revision.id}
                      type="button"
                      onClick={() => openRecentRevision(revision)}
                      aria-label={`Open ${seqTag(revision.sequence)}, ${revision.prompt}, by ${revision.author}`}
                    >
                      <span>{seqTag(revision.sequence)} · {revision.author}</span>
                      <span>{compactTime(revision.createdAt)} ago</span>
                      <span>{revision.prompt}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </section>
      ) : null}

      {editOpen ? (
        <section
          id="contribution-editor"
          className="mono-strip mono-edit-strip"
          aria-label="Contribute an edit"
        >
          <input
            ref={referenceInputRef}
            className="mono-reference-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            tabIndex={-1}
            disabled={submitted || isPreparing}
            onChange={(event) => void selectReferenceImage(event)}
          />
          <div className="mono-strip-head">
            <div className="mono-steps">
              <span className={`mono-step${step === 1 ? " is-active" : ""}`}>01 patch</span>
              <span className={`mono-step${step === 2 ? " is-active" : ""}`}>02 mask</span>
              <span className={`mono-step${step === 3 ? " is-active" : ""}`}>03 prompt</span>
            </div>
            <button
              type="button"
              className="mono-strip-close"
              aria-label="Close contribution"
              onClick={closeEditor}
            >
              ×
            </button>
          </div>
          {step === 1 ? (
            <div className="mono-edit-row">
              <span className="mono-edit-hint">
                drag the patch to move it · pull the corner or use the size controls ·
                live outlines are locked
              </span>
              <div className="mono-patch-size-control" role="group" aria-label="Edit patch size">
                <button
                  type="button"
                  aria-label="Make edit patch smaller"
                  disabled={
                    editRegion.width <= patchMinimumEdge &&
                    editRegion.height <= patchMinimumEdge
                  }
                  onClick={() => resizePatchBy(-PATCH_SIZE_STEP)}
                >
                  −
                </button>
                <output>
                  {editRegion.width} × {editRegion.height}
                </output>
                <button
                  type="button"
                  aria-label="Make edit patch larger"
                  disabled={
                    editRegion.width >= patchMaximumWidth &&
                    editRegion.height >= patchMaximumHeight
                  }
                  onClick={() => resizePatchBy(PATCH_SIZE_STEP)}
                >
                  +
                </button>
              </div>
              <button
                type="button"
                className="mono-action"
                disabled={Boolean(conflictingRegion) || isPreparing}
                onClick={() => {
                  if (!referenceInputRef.current) return;
                  referenceInputRef.current.value = "";
                  referenceInputRef.current.click();
                }}
              >
                {isPreparing ? "preparing…" : "reference an image →"}
              </button>
              <button
                type="button"
                className="mono-action mono-next-action is-accent"
                disabled={Boolean(conflictingRegion)}
                onClick={() => {
                  setStep(2);
                  wake();
                  trackVisitorInteraction("patch_confirmed");
                }}
              >
                use this patch
              </button>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="mono-edit-row">
              <span className="mono-edit-hint">
                drag your cursor inside the patch to paint what may change
              </span>
              <button
                type="button"
                className="mono-action"
                disabled={strokes.length === 0}
                onClick={() => setStrokes((current) => current.slice(0, -1))}
              >
                [undo]
              </button>
              <button
                type="button"
                className="mono-action"
                disabled={!validMask}
                onClick={() => {
                  setStrokes([]);
                  setFillMask(false);
                }}
              >
                [clear]
              </button>
              <button
                type="button"
                className={`mono-action${fillMask ? " is-accent" : ""}`}
                aria-pressed={fillMask}
                disabled={Boolean(conflictingRegion)}
                onClick={() => {
                  setFillMask((value) => {
                    if (!value) setStrokes([]);
                    return !value;
                  });
                }}
              >
                {fillMask ? "[x] use entire patch" : "[ ] use entire patch"}
              </button>
              <button
                type="button"
                className={`mono-action mono-next-action${validMask ? " is-accent" : ""}`}
                disabled={!validMask || Boolean(conflictingRegion)}
                onClick={() => {
                  setStep(3);
                  wake();
                  trackVisitorInteraction("mask_confirmed");
                }}
              >
                continue →
              </button>
            </div>
          ) : null}
          {step === 3 ? (
            <div className="mono-edit-form">
              <div className={`mono-reference-control${referenceImage ? " has-image" : ""}`}>
                <button
                  type="button"
                  className="mono-reference-trigger"
                  aria-label={
                    referenceImage
                      ? `Replace reference image ${referenceImage.fileName}`
                      : "Add an optional reference image"
                  }
                  title={referenceImage?.fileName}
                  disabled={submitted || isPreparing}
                  onClick={() => {
                    if (!referenceInputRef.current) return;
                    referenceInputRef.current.value = "";
                    referenceInputRef.current.click();
                  }}
                >
                  {referenceImage ? (
                    <>
                      <img src={activeReferencePreviewUrl ?? ""} alt="" />
                      <span>{referenceImage.fileName}</span>
                    </>
                  ) : (
                    <span>[+] reference</span>
                  )}
                </button>
                {referenceImage ? (
                  <button
                    type="button"
                    className="mono-reference-remove"
                    aria-label={`Remove reference image ${referenceImage.fileName}`}
                    disabled={submitted || isPreparing}
                    onClick={clearReferenceImage}
                  >
                    ×
                  </button>
                ) : null}
              </div>
              <input
                className="mono-input"
                value={prompt}
                maxLength={500}
                placeholder={
                  referenceImage
                    ? "describe how GPT Image should blend this reference…"
                    : "describe the change…"
                }
                aria-label="Describe the change"
                disabled={submitted}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <input
                className="mono-input is-name"
                value={displayName}
                maxLength={32}
                placeholder="your name"
                aria-label="Name shown in history"
                disabled={submitted}
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <button
                type="button"
                className={`mono-action mono-next-action${
                  canSubmit || submitted ? " is-accent" : ""
                }`}
                disabled={!canSubmit}
                onClick={() => void submitEdit()}
              >
                {submitLabel}
              </button>
            </div>
          ) : null}
          {conflictingRegion ? (
            <p className="mono-overlap-note" id="overlap-note" role="status">
              <span>{overlapMessage(conflictingRegion)}</span>
              {step !== 1 ? (
                <button type="button" onClick={() => setStep(1)}>
                  move patch →
                </button>
              ) : null}
            </p>
          ) : null}
          {submitted && job && headRevision ? (
            <p className="mono-note">
              queued{job.position ? ` — position ${job.position}` : ""} · based on{" "}
              {seqTag(headRevision.sequence)} · accepted edits are permanent
            </p>
          ) : null}
          {submitError ? (
            <p className="mono-error-line" role="alert">
              {submitError}
            </p>
          ) : null}
        </section>
      ) : null}

      {loadingError ? (
        <div className="mono-error-panel" role="alert">
          <p>{loadingError}</p>
          <button
            type="button"
            onClick={() => {
              refreshHistory().catch((error: unknown) => {
                setLoadingError(
                  error instanceof Error ? error.message : "The archive could not be opened.",
                );
              });
            }}
          >
            try again
          </button>
        </div>
      ) : null}

      <WelcomeDrawer open={welcomeOpen} onClose={closeWelcome} />
    </main>
  );
}
