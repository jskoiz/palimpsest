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
import { ARTWORK_SIZE, maskBlendInset } from "@/lib/palimpsest/domain.mjs";
import {
  canvasViewCanPan,
  constrainCanvasView,
  EDIT_REGION_MAX_EDGE,
  EDIT_REGION_MIN_EDGE,
  generationFrameForRegion,
  positionEditRegion,
  positionEditRegionAvoidingRegions,
  regionRelativeToFrame,
  resizeEditRegionAvoidingRegions,
  regionsOverlap,
  timelineIndexAtPosition,
} from "@/lib/palimpsest/geometry.mjs";

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
  origin: "seed" | "demo" | "openai" | "revert";
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
    available: boolean;
  };
};

type ActivityPayload = {
  queue: { queued: number; active: number };
  recent: Revision[];
  activeRegions: ActiveRegion[];
};

type ActiveRegion = {
  jobId: string;
  author: string;
  state: string;
  region: Region;
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
};

type PendingEdit = {
  jobId: string;
  author: string;
  prompt: string;
  region: Region | null;
};

type Stroke = {
  width: number;
  points: Array<{ x: number; y: number }>;
};

type ReferenceImage = {
  blob: Blob;
  fileName: string;
  previewUrl: string;
};

const terminalJobStates = new Set(["succeeded", "stale", "rejected", "failed"]);

const AUTO_HIDE = true;
const IDLE_HIDE_MS = 4000;
const DEEP_IDLE_MS = 30000;
const BRUSH_WIDTH = 30;
const COLLAB_POLL_MS = 3000;
const HIDDEN_COLLAB_POLL_MS = 8000;
const PATCH_SIZE_STEP = 32;
const DEFAULT_REGION = { x: 800, y: 832, width: 448, height: 384 };
const WELCOME_STORAGE_KEY = "palimpsest:welcome:v1";
const REFERENCE_IMAGE_SIZE = 1024;
const MAX_REFERENCE_UPLOAD_BYTES = 10 * 1024 * 1024;
const REFERENCE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const EMPTY_ACTIVITY: ActivityPayload = {
  queue: { queued: 0, active: 0 },
  recent: [],
  activeRegions: [],
};

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
  return positionEditRegionAvoidingRegions(
    centered,
    centered.x,
    centered.y,
    activeRegions.map((active) => active.region),
  );
}

function activitySignature(activity: ActivityPayload) {
  return JSON.stringify({
    queue: activity.queue,
    recent: activity.recent.map((revision) => [revision.id, revision.createdAt]),
    activeRegions: activity.activeRegions.map((active) => [
      active.jobId,
      active.author,
      active.state,
      active.region.x,
      active.region.y,
      active.region.width,
      active.region.height,
      active.updatedAt,
    ]),
  });
}

function activeStateLabel(state: ActiveRegion["state"]) {
  if (state === "queued") return "reserved";
  if (state === "moderating") return "planning";
  if (state === "committing") return "finishing";
  if (state === "generating") return "generating";
  return state;
}

function overlapMessage(active: ActiveRegion) {
  if (active.state === "queued") {
    return `${active.author} reserved this area — it stays locked until the edit finishes.`;
  }
  if (active.state === "moderating") {
    return `${active.author} is planning an edit here — this area is locked.`;
  }
  if (active.state === "committing") {
    return `${active.author} is finishing an edit here — this area is locked.`;
  }
  return `${active.author} is generating here — this area is locked.`;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && body.error?.message
        ? body.error.message
        : "Palimpsest could not complete that request.";
    throw new Error(message);
  }
  return body as T;
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
            <p id="welcome-description" className="mono-welcome-summary">
              One shared canvas. Every accepted edit becomes the next revision; earlier
              versions stay available.
            </p>

            <div className="mono-welcome-path">
              <section>
                <span>01</span>
                <h2>Move</h2>
                <p>
                  Drag when the artwork extends past the window. Scroll or use [−] [+]
                  to zoom.
                </p>
              </section>
              <section>
                <span>02</span>
                <h2>History</h2>
                <p>Open the bottom timeline and drag to inspect any revision.</p>
              </section>
              <section>
                <span>03</span>
                <h2>Contribute</h2>
                <p>
                  Place and resize the patch, then paint what may change. GPT-5.6
                  plans the request; GPT Image renders that masked area. References
                  are optional. Live outlines lock only active work.
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

async function normalizeReferenceImage(file: File): Promise<Blob> {
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
    const canvas = document.createElement("canvas");
    canvas.width = REFERENCE_IMAGE_SIZE;
    canvas.height = REFERENCE_IMAGE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare reference images.");
    const scale = Math.min(
      REFERENCE_IMAGE_SIZE / image.width,
      REFERENCE_IMAGE_SIZE / image.height,
    );
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    context.drawImage(
      image,
      Math.round((REFERENCE_IMAGE_SIZE - width) / 2),
      Math.round((REFERENCE_IMAGE_SIZE - height) / 2),
      width,
      height,
    );
    return canvasBlob(canvas, "The reference image could not be encoded.");
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
  source.width = frame.width;
  source.height = frame.height;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) throw new Error("This browser cannot prepare image edits.");
  sourceContext.drawImage(
    composite,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    0,
    0,
    frame.width,
    frame.height,
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
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare a mask.");
  context.fillStyle = "#111111";
  context.fillRect(0, 0, frame.width, frame.height);
  context.globalCompositeOperation = "destination-out";
  const frameRegion = regionRelativeToFrame(region, frame);
  if (fill) {
    const inset = maskBlendInset(region);
    context.clearRect(
      frameRegion.x + inset,
      frameRegion.y + inset,
      region.width - inset * 2,
      region.height - inset * 2,
    );
  } else {
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes) {
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
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  const drainInFlight = useRef(false);
  const activityRequest = useRef<Promise<ActivityPayload> | null>(null);
  const activitySignatureRef = useRef(activitySignature(EMPTY_ACTIVITY));
  const idleTimer = useRef<number | null>(null);
  const deepTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const panStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const patchDrag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const patchResize = useRef<{ pointerId: number } | null>(null);
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
  const jobActive = Boolean(job && !terminalJobStates.has(job.state));
  const queueTotal = activity.queue.queued + activity.queue.active;
  const queueBusy = activity.queue.active > 0 || jobActive;
  const liveEditingAvailable = Boolean(history?.editing.available);
  const canPanCanvas = canvasViewCanPan(view, viewport.width, viewport.height);
  const otherActiveRegions = activity.activeRegions.filter(
    (active) => active.jobId !== pendingEdit?.jobId,
  );
  const conflictingRegion = otherActiveRegions.find((active) =>
    regionsOverlap(editRegion, active.region),
  );
  const conflictingJobId = conflictingRegion?.jobId ?? null;

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
    jobActive,
    history,
    currentState,
    welcomeOpen,
    activeRegions: activity.activeRegions,
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
      jobActive,
      history,
      currentState,
      welcomeOpen,
      activeRegions: activity.activeRegions,
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
    setConfirmRestore(false);
    setQueueOpen(false);
    setHistoryOpen(false);
    setHoverIdx(-1);
    setDeepIdle(false);
    setChromeVisible(true);
    setWelcomeOpen(true);
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

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
    if (drainInFlight.current) return;
    drainInFlight.current = true;
    try {
      const response = await fetch("/api/queue/drain", { method: "POST" });
      if (!response.ok) throw new Error("The queue could not be reached.");
    } catch {
      // The immutable job remains queued; the next status poll will retry this active request.
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
      Promise.all([refreshHistory(), refreshActivity()]).catch((error: unknown) => {
        setLoadingError(error instanceof Error ? error.message : "The archive could not be opened.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshActivity, refreshHistory]);

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
      try {
        const payload = await refreshActivity();
        if (cancelled) return;
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
            document.hidden ? HIDDEN_COLLAB_POLL_MS : COLLAB_POLL_MS,
          );
        }
      }
    };
    timer = window.setTimeout(poll, COLLAB_POLL_MS);
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
    setEditRegion((region) =>
      positionEditRegionAvoidingRegions(
        region,
        region.x,
        region.y,
        latest.current.activeRegions.map((entry) => entry.region),
      ),
    );
    setStep(1);
    setStrokes([]);
    setFillMask(false);
    setSubmitError(null);
    showToast(`${active.author} locked that area — your patch moved to open space.`);
  }, [conflictingJobId, editOpen, showToast, submitted]);

  useEffect(() => {
    if (!job || terminalJobStates.has(job.state)) return;
    void requestQueueDrain();
    const timer = window.setTimeout(async () => {
      try {
        const payload = await fetchJson<{ job: Job }>(`/api/jobs/${encodeURIComponent(job.id)}`);
        if (!terminalJobStates.has(payload.job.state)) {
          setJob(payload.job);
          await refreshActivity();
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
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [clearReferenceImage, job, refreshActivity, refreshHistory, requestQueueDrain, showToast]);

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
      const inset = maskBlendInset(editRegion);
      context.fillRect(inset, inset, width - inset * 2, height - inset * 2);
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
  }, [editOpen, editRegion, fillMask, step, strokes, submitted]);

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
      setConfirmRestore(false);
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
    setConfirmRestore(false);
    if (next && current.selectedIndex >= current.revLen - 1) setSelectedIndex(0);
    setPlaying(next);
    wake();
  }, [wake]);

  const toggleQueue = useCallback(() => {
    setQueueOpen((open) => !open);
    setEditOpen(false);
    setHistoryOpen(false);
    setPlaying(false);
    setCompareOn(false);
    setSubmitted(false);
    setConfirmRestore(false);
    clearReferenceImage();
    wake();
  }, [clearReferenceImage, wake]);

  const openEditor = useCallback(async () => {
    const initial = latest.current;
    if (!initial.history || !initial.currentState || initial.jobActive) return;
    if (!initial.history.editing.available) {
      showToast("live AI editing is temporarily unavailable");
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
    setSubmitted(false);
    setSubmitError(null);
    setConfirmRestore(false);
    setView({ zoom: 1, x: 0, y: 0 });
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    wake();
  }, [clearReferenceImage, refreshActivity, showToast, wake]);

  const closeEditor = useCallback(() => {
    setEditOpen(false);
    setEditBase(null);
    setSubmitted(false);
    clearReferenceImage();
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    wake();
  }, [clearReferenceImage, wake]);

  const closeAll = useCallback(() => {
    setEditOpen(false);
    setEditBase(null);
    setQueueOpen(false);
    setHistoryOpen(false);
    setCompareOn(false);
    setPlaying(false);
    setSubmitted(false);
    setConfirmRestore(false);
    setHoverIdx(-1);
    clearReferenceImage();
    setView({ zoom: 1, x: 0, y: 0 });
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    wake();
  }, [clearReferenceImage, wake]);

  const returnToCurrent = useCallback(() => {
    if (!latest.current.revLen) return;
    setSelectedIndex(latest.current.revLen - 1);
    setPlaying(false);
    setCompareOn(false);
    setConfirmRestore(false);
    wake();
  }, [wake]);

  const nudgePatch = useCallback((deltaX: number, deltaY: number) => {
    setEditRegion((region) =>
      positionEditRegionAvoidingRegions(
        region,
        region.x + deltaX,
        region.y + deltaY,
        latest.current.activeRegions.map((active) => active.region),
      ),
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
            if (current.step === 1 && !current.submitted) {
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
    setConfirmRestore(false);
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
    if ((event.target as HTMLElement).closest(".mono-welcome")) return;
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
    if (step !== 1 || submitted) return;
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
      positionEditRegionAvoidingRegions(
        region,
        point.x - offset.x,
        point.y - offset.y,
        latest.current.activeRegions.map((active) => active.region),
      ),
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
      resizeEditRegionAvoidingRegions(
        region,
        desiredWidth,
        desiredHeight,
        latest.current.activeRegions.map((active) => active.region),
      ),
    );
  };

  const resizePatchBy = (amount: number) => {
    setEditRegion((region) =>
      resizeEditRegionAvoidingRegions(
        region,
        region.width + amount,
        region.height + amount,
        latest.current.activeRegions.map((active) => active.region),
      ),
    );
    wake();
  };

  const patchResizeDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (step !== 1 || submitted) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    patchResize.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    event.stopPropagation();
    event.preventDefault();
  };

  const patchResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (patchResize.current?.pointerId !== event.pointerId) return;
    const point = artworkPoint(event);
    if (!point) return;
    setEditRegion((region) =>
      resizeEditRegionAvoidingRegions(
        region,
        point.x - region.x,
        point.y - region.y,
        latest.current.activeRegions.map((active) => active.region),
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
      resizePatch(EDIT_REGION_MIN_EDGE, EDIT_REGION_MIN_EDGE);
    } else if (event.key === "End") {
      resizePatch(EDIT_REGION_MAX_EDGE, EDIT_REGION_MAX_EDGE);
    } else {
      return;
    }
    if (widthDelta !== 0 || heightDelta !== 0) {
      setEditRegion((region) =>
        resizeEditRegionAvoidingRegions(
          region,
          region.width + widthDelta,
          region.height + heightDelta,
          latest.current.activeRegions.map((active) => active.region),
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
      const blob = await normalizeReferenceImage(file);
      if (referencePreviewUrlRef.current) {
        URL.revokeObjectURL(referencePreviewUrlRef.current);
      }
      const previewUrl = URL.createObjectURL(blob);
      referencePreviewUrlRef.current = previewUrl;
      setReferenceImage({ blob, fileName: file.name, previewUrl });
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
    liveEditingAvailable &&
    !conflictingRegion &&
    prompt.trim().length >= 3 &&
    validMask &&
    step === 3;

  const submitEdit = async () => {
    if (!editBase || !canSubmit) return;
    setSubmitError(null);
    setIsPreparing(true);
    try {
      const frame = generationFrameForRegion(editRegion);
      const [source, mask] = await Promise.all([
        flattenArtworkFrame(editBase.state, frame),
        providerMask(editRegion, frame, strokes, fillMask),
      ]);
      const form = new FormData();
      form.append(
        "meta",
        JSON.stringify({
          artworkId: "palimpsest",
          baseRevisionId: editBase.revisionId,
          displayName: cleanDisplayName(),
          prompt: prompt.trim(),
          region: editRegion,
          frame,
          fill: fillMask,
          strokes,
        }),
      );
      form.append("source", source, "source.png");
      form.append("mask", mask, "mask.png");
      if (referenceImage) {
        form.append("reference", referenceImage.blob, "reference.png");
      }
      const payload = await fetchJson<{ job: Job }>("/api/edits", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: form,
      });
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
      setSubmitError(error instanceof Error ? error.message : "The edit could not be submitted.");
      try {
        await refreshActivity();
      } catch {
        // The next collaboration poll retries if the activity refresh also fails.
      }
    } finally {
      setIsPreparing(false);
    }
  };

  const submitRevert = async () => {
    if (!history || !selectedRevision || selectedRevision.id === history.headRevisionId) return;
    setConfirmRestore(false);
    try {
      const payload = await fetchJson<{ job: Job }>("/api/reverts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          artworkId: "palimpsest",
          baseRevisionId: history.headRevisionId,
          targetRevisionId: selectedRevision.id,
          displayName: cleanDisplayName(),
        }),
      });
      setJob(payload.job);
      setPendingEdit({
        jobId: payload.job.id,
        author: cleanDisplayName() || "anonymous visitor",
        prompt: `restore ${seqTag(selectedRevision.sequence)}`,
        region: null,
      });
      void requestQueueDrain();
      await refreshActivity();
      showToast(`queued — restoring ${seqTag(selectedRevision.sequence)}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The restore could not be queued.");
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

  const queueEntries = [
    ...(jobActive && pendingEdit
      ? [
          {
            id: pendingEdit.jobId,
            author: pendingEdit.author,
            state: job?.state === "queued" ? "waiting" : "making",
            accent: job?.state !== "queued",
            prompt: pendingEdit.prompt,
          },
        ]
      : []),
    ...otherActiveRegions.map((active) => ({
      id: active.jobId,
      author: active.author,
      state: activeStateLabel(active.state),
      accent: active.state !== "queued",
      prompt: `region ${active.region.x},${active.region.y} · ${active.region.width}×${active.region.height}`,
    })),
    ...activity.recent.map((revision) => ({
      id: revision.id,
      author: revision.author,
      state: `done · ${compactTime(revision.createdAt)}`,
      accent: false,
      prompt: revision.prompt,
    })),
  ].slice(0, 4);

  const submitLabel = submitted
    ? "reserved ✓"
    : isPreparing
      ? "preparing…"
      : jobActive
        ? "your edit is making…"
        : !liveEditingAvailable
          ? "live AI unavailable"
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
                  }`}
                  data-testid="active-reservation"
                  style={regionStyle(active.region)}
                  role="listitem"
                  aria-label={`${active.author}, ${activeStateLabel(active.state)}, region ${active.region.x}, ${active.region.y}, ${active.region.width} by ${active.region.height}`}
                >
                  <span>
                    {active.author} · {activeStateLabel(active.state)}
                  </span>
                </div>
              ))}
              {jobActive && pendingEdit?.region && job ? (
                <div
                  className="mono-reservation is-local is-active"
                  data-testid="local-reservation"
                  style={regionStyle(pendingEdit.region)}
                  role="listitem"
                  aria-label={`Your region, ${activeStateLabel(job.state)}`}
                >
                  <span>you · {activeStateLabel(job.state)}</span>
                </div>
              ) : null}
            </div>
            {editOpen ? (
              <div
                className={`mono-patch${step === 1 && !submitted ? " is-draggable" : " is-set"}${step === 2 && !submitted ? " is-masking" : ""}${conflictingRegion ? " is-unavailable" : ""}`}
                style={patchStyle}
                data-testid="edit-patch"
                role="group"
                tabIndex={step === 1 && !submitted ? 0 : -1}
                aria-label={`Selected edit patch, ${editRegion.width} by ${editRegion.height} pixels. Drag to move it, pull the lower-right corner to resize it, or use the arrow keys to nudge it.`}
                aria-describedby={conflictingRegion ? "overlap-note" : undefined}
                onPointerDown={patchDown}
                onPointerMove={patchMove}
                onPointerUp={patchUp}
                onPointerCancel={patchUp}
              >
                {step === 1 && !submitted ? (
                  <>
                    <span className="mono-patch-size" aria-hidden="true">
                      {editRegion.width} × {editRegion.height}
                    </span>
                    <span className="mono-patch-label">drag to move</span>
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
                    <img src={referenceImage.previewUrl} alt="" />
                    <span>reference</span>
                  </div>
                ) : null}
                {step >= 2 && !submitted ? (
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
          aria-label={`Queue, ${queueTotal} pending`}
          onClick={toggleQueue}
        >
          <span className={`mono-live-dot${queueBusy ? " is-pulsing" : ""}`} aria-hidden="true" />
          queue/{queueTotal}
        </button>
        <button
          type="button"
          className="mono-contribute"
          aria-label={
            jobActive
              ? "Your contribution is still being made"
              : liveEditingAvailable
                ? "Contribute with live AI"
                : "Live AI editing is temporarily unavailable"
          }
          disabled={jobActive || !liveEditingAvailable}
          onClick={openEditor}
        >
          contribute
        </button>
      </div>

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
            }}
          />
        </>
      ) : null}

      {showHistory && selectedRevision && headRevision ? (
        <section
          className="mono-strip"
          aria-label="Revision history"
          onPointerLeave={() => {
            if (playing || compareOn) return;
            setHistoryOpen(false);
            setHoverIdx(-1);
            setConfirmRestore(false);
            wake();
          }}
        >
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
                <button
                  type="button"
                  className={`mono-action${confirmRestore ? " is-accent" : ""}`}
                  onClick={() => {
                    if (confirmRestore) void submitRevert();
                    else setConfirmRestore(true);
                    wake();
                  }}
                >
                  {confirmRestore ? "confirm restore →" : "restore this look"}
                </button>
              ) : null}
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
        <section className="mono-strip" aria-label="Contribution queue">
          <div className="mono-strip-head">
            <span className="mono-strip-summary">
              live work — {activity.queue.queued} reserved · {activity.queue.active} making ·
              open space stays editable
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
          <div className="mono-queue-list">
            {queueEntries.map((entry, index) => (
              <div
                key={entry.id}
                className="mono-queue-entry"
                style={{ "--stagger": `${index * 70}ms` } as CSSProperties}
              >
                <span className="mono-queue-author">{entry.author}</span>
                <span className={`mono-queue-state${entry.accent ? " is-accent" : ""}`}>
                  {entry.state}
                </span>
                <p>{entry.prompt}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {editOpen ? (
        <section className="mono-strip" aria-label="Contribute an edit">
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
                live outlines are locked · drag to move · pull the corner to resize
              </span>
              <div className="mono-patch-size-control" role="group" aria-label="Edit patch size">
                <button
                  type="button"
                  aria-label="Make edit patch smaller"
                  disabled={
                    editRegion.width <= EDIT_REGION_MIN_EDGE &&
                    editRegion.height <= EDIT_REGION_MIN_EDGE
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
                className="mono-action is-accent"
                disabled={Boolean(conflictingRegion)}
                onClick={() => {
                  setStep(2);
                  wake();
                }}
              >
                use this patch →
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
                className={`mono-action${validMask ? " is-accent" : ""}`}
                disabled={!validMask || Boolean(conflictingRegion)}
                onClick={() => {
                  setStep(3);
                  wake();
                }}
              >
                continue →
              </button>
            </div>
          ) : null}
          {step === 3 ? (
            <div className="mono-edit-form">
              <input
                ref={referenceInputRef}
                className="mono-reference-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-hidden="true"
                tabIndex={-1}
                disabled={submitted || isPreparing}
                onChange={(event) => void selectReferenceImage(event)}
              />
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
                      <img src={referenceImage.previewUrl} alt="" />
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
                    ? "describe how to use the reference…"
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
                aria-label="Name shown in history"
                disabled={submitted}
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <button
                type="button"
                className={`mono-action${canSubmit || submitted ? " is-accent" : ""}`}
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
