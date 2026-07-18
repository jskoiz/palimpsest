"use client";

/* eslint-disable @next/next/no-img-element -- Immutable R2 tile layers must remain raw pixels for exact canvas compositing. */

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  nudgeEditRegion,
  positionEditRegion,
} from "@/lib/palimpsest/geometry.mjs";

type Revision = {
  id: string;
  sequence: number;
  parentRevisionId: string | null;
  author: string;
  prompt: string;
  createdAt: string;
  origin: "seed" | "demo" | "openai" | "revert";
  status: "accepted";
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
    tile: { x: number; y: number };
  } | null;
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
};

type Tile = {
  x: number;
  y: number;
  base: { blobId: string; url: string; sha256: string };
  layers: Layer[];
};

type ArtworkState = {
  artwork: { id: string; width: number; height: number; tileSize: number };
  headRevisionId: string;
  isCurrent: boolean;
  revision: Revision;
  tiles: Tile[];
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
    openaiAvailable: boolean;
    defaultMode: "demo";
    demoNotice: string;
  };
};

type ActivityPayload = {
  queue: { queued: number; active: number };
  recent: Revision[];
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
  executionMode: "demo" | "openai" | "none";
  position: number | null;
  resultRevisionId: string | null;
  message: string | null;
  error: { code: string; message: string } | null;
  submittedAt: string;
  updatedAt: string;
};

type Stroke = {
  width: number;
  points: Array<{ x: number; y: number }>;
};

type EditRegion = {
  tile: { x: number; y: number };
  region: { x: number; y: number; width: number; height: number };
};

const terminalJobStates = new Set(["succeeded", "stale", "rejected", "failed"]);
const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const timeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function relativeTime(date: string) {
  const minutes = Math.round((new Date(date).getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return timeFormatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return timeFormatter.format(hours, "hour");
  return timeFormatter.format(Math.round(hours / 24), "day");
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

function TileStack({ tile }: { tile: Tile }) {
  return (
    <div className="tile-stack" data-tile={`${tile.x}-${tile.y}`}>
      <img src={tile.base.url} alt="" draggable={false} crossOrigin="anonymous" />
      {tile.layers.map((layer) => {
        const maskStyle = layer.maskUrl
          ? ({
              maskImage: `url("${layer.maskUrl}")`,
              WebkitMaskImage: `url("${layer.maskUrl}")`,
              maskSize: "100% 100%",
              WebkitMaskSize: "100% 100%",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
            } as CSSProperties)
          : undefined;
        return (
          <img
            key={`${layer.revisionId}-${layer.blobId}`}
            src={layer.url}
            alt=""
            draggable={false}
            crossOrigin="anonymous"
            style={maskStyle}
          />
        );
      })}
    </div>
  );
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
        <TileStack key={`${tile.x}-${tile.y}`} tile={tile} />
      ))}
    </div>
  );
}

function ArtworkView({
  state,
  compareState,
  compareEnabled,
  comparePosition,
  onComparePosition,
  editing,
  selecting,
  selectedRegion,
  onRegionChange,
  onRegionConfirm,
}: {
  state: ArtworkState | null;
  compareState: ArtworkState | null;
  compareEnabled: boolean;
  comparePosition: number;
  onComparePosition: (position: number) => void;
  editing: boolean;
  selecting: boolean;
  selectedRegion: EditRegion;
  onRegionChange: (region: EditRegion) => void;
  onRegionConfirm: () => void;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (selecting) regionRef.current?.focus({ preventScroll: true });
  }, [selecting]);

  if (!state) {
    return (
      <div className="artwork-frame artwork-loading" aria-label="Loading the current artwork">
        <img src="/seed/canonical.png" alt="Palimpsest communal artwork" />
        <span>Opening the archive…</span>
      </div>
    );
  }

  const regionStyle = {
    left: `${((selectedRegion.tile.x * 1024 + selectedRegion.region.x) / 2048) * 100}%`,
    top: `${((selectedRegion.tile.y * 1024 + selectedRegion.region.y) / 2048) * 100}%`,
    width: `${(selectedRegion.region.width / 2048) * 100}%`,
    height: `${(selectedRegion.region.height / 2048) * 100}%`,
  };

  const canvasPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(2047, ((event.clientX - rect.left) / rect.width) * 2048)),
      y: Math.max(0, Math.min(2047, ((event.clientY - rect.top) / rect.height) * 2048)),
    };
  };

  const moveFromPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    offset: { x: number; y: number },
  ) => {
    const point = canvasPoint(event);
    onRegionChange(
      positionEditRegion(selectedRegion, point.x - offset.x, point.y - offset.y),
    );
  };

  const beginRegionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editing) return;
    const target = event.target as HTMLElement;
    const grabbedRegion = Boolean(target.closest(".selected-region"));
    if (!selecting && !grabbedRegion) return;

    const point = canvasPoint(event);
    const globalX = selectedRegion.tile.x * 1024 + selectedRegion.region.x;
    const globalY = selectedRegion.tile.y * 1024 + selectedRegion.region.y;
    const offset = grabbedRegion
      ? { x: point.x - globalX, y: point.y - globalY }
      : { x: selectedRegion.region.width / 2, y: selectedRegion.region.height / 2 };
    dragOffset.current = offset;
    event.currentTarget.setPointerCapture(event.pointerId);
    regionRef.current?.focus({ preventScroll: true });
    moveFromPointer(event, offset);
    event.preventDefault();
  };

  const continueRegionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragOffset.current || !editing) return;
    moveFromPointer(event, dragOffset.current);
    event.preventDefault();
  };

  const endRegionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragOffset.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const moveRegionWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    const deltas: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const delta = deltas[event.key];
    if (delta) {
      onRegionChange(nudgeEditRegion(selectedRegion, delta.x, delta.y));
      event.preventDefault();
      return;
    }
    if (selecting && (event.key === "Enter" || event.key === " ")) {
      onRegionConfirm();
      event.preventDefault();
    }
  };

  return (
    <div
      className={`artwork-frame${selecting ? " is-selecting" : ""}`}
      onPointerDown={editing ? beginRegionDrag : undefined}
      onPointerMove={editing ? continueRegionDrag : undefined}
      onPointerUp={editing ? endRegionDrag : undefined}
      onPointerCancel={editing ? endRegionDrag : undefined}
    >
      <ArtworkLayers state={state} />
      {compareEnabled && compareState ? (
        <>
          <div
            className="comparison-reveal"
            style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}
            aria-hidden="true"
          >
            <ArtworkLayers state={compareState} />
          </div>
          <div className="comparison-label comparison-label-before">
            Before · R{String(state.revision.sequence).padStart(3, "0")}
          </div>
          <div className="comparison-label comparison-label-current">
            Current · R{String(compareState.revision.sequence).padStart(3, "0")}
          </div>
          <input
            className="comparison-slider"
            type="range"
            min="0"
            max="100"
            value={comparePosition}
            aria-label="Before and current comparison"
            aria-valuetext={`${comparePosition}% of the current revision visible`}
            onChange={(event) => onComparePosition(Number(event.target.value))}
          />
          <div className="comparison-rule" style={{ left: `${comparePosition}%` }} aria-hidden="true">
            <span />
          </div>
        </>
      ) : null}
      {editing ? (
        <>
          {selecting ? <div className="selection-veil" aria-hidden="true" /> : null}
          <div
            ref={regionRef}
            className={`selected-region${selecting ? " is-positioning" : " is-placed"}`}
            style={regionStyle}
            role="button"
            tabIndex={0}
            aria-label="Selected edit patch. Drag to move it. Use the arrow keys to nudge it."
            onKeyDown={moveRegionWithKeyboard}
          >
            <i /><i /><i /><i />
            <span>{selecting ? "Drag patch" : "Move"}</span>
          </div>
          {selecting ? (
            <p className="selection-instruction">Drag or tap to move · Enter to confirm</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function RegionMaskEditor({
  tile,
  region,
  strokes,
  fill,
  brushWidth,
  onStrokes,
  onFill,
}: {
  tile: Tile;
  region: EditRegion["region"];
  strokes: Stroke[];
  fill: boolean;
  brushWidth: number;
  onStrokes: (strokes: Stroke[]) => void;
  onFill: (fill: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activePointer = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, region.width, region.height);
    context.fillStyle = "rgba(166, 59, 41, .34)";
    context.strokeStyle = "rgba(166, 59, 41, .58)";
    context.lineCap = "round";
    context.lineJoin = "round";
    if (fill) context.fillRect(0, 0, region.width, region.height);
    for (const stroke of strokes) {
      context.lineWidth = stroke.width;
      context.beginPath();
      const first = stroke.points[0];
      if (!first) continue;
      context.moveTo(first.x, first.y);
      if (stroke.points.length === 1) {
        context.lineTo(first.x + 0.01, first.y + 0.01);
      } else {
        for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
  }, [fill, region.height, region.width, strokes]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(region.width, ((event.clientX - rect.left) / rect.width) * region.width))),
      y: Math.round(Math.max(0, Math.min(region.height, ((event.clientY - rect.top) / rect.height) * region.height))),
    };
  };

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointer.current = event.pointerId;
    onFill(false);
    onStrokes([...strokes, { width: brushWidth, points: [pointFromEvent(event)] }]);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== event.pointerId || event.buttons === 0) return;
    const point = pointFromEvent(event);
    const next = [...strokes];
    const last = next.at(-1);
    const previous = last?.points.at(-1);
    if (!last || (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 2)) return;
    next[next.length - 1] = { ...last, points: [...last.points, point] };
    onStrokes(next);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current === event.pointerId) activePointer.current = null;
  };

  const sourceStyle = {
    width: `${(1024 / region.width) * 100}%`,
    height: `${(1024 / region.height) * 100}%`,
    left: `${-(region.x / region.width) * 100}%`,
    top: `${-(region.y / region.height) * 100}%`,
  };

  return (
    <div className="mask-editor" style={{ aspectRatio: `${region.width} / ${region.height}` }}>
      <div className="mask-source" style={sourceStyle} aria-hidden="true">
        <TileStack tile={tile} />
      </div>
      <canvas
        ref={canvasRef}
        width={region.width}
        height={region.height}
        tabIndex={0}
        aria-label="Draw the mask for this edit. Use Fill patch for a keyboard-accessible alternative."
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      />
    </div>
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

async function flattenTile(tile: Tile): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare image edits.");
  context.drawImage(await loadImage(tile.base.url), 0, 0, 1024, 1024);
  for (const layer of tile.layers) {
    const image = await loadImage(layer.url);
    if (!layer.maskUrl) {
      context.drawImage(image, 0, 0, 1024, 1024);
      continue;
    }
    const offscreen = document.createElement("canvas");
    offscreen.width = 1024;
    offscreen.height = 1024;
    const layerContext = offscreen.getContext("2d");
    if (!layerContext) throw new Error("This browser cannot prepare image edits.");
    layerContext.drawImage(image, 0, 0, 1024, 1024);
    layerContext.globalCompositeOperation = "destination-in";
    layerContext.drawImage(await loadImage(layer.maskUrl), 0, 0, 1024, 1024);
    context.drawImage(offscreen, 0, 0);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The source tile could not be encoded."))), "image/png");
  });
}

async function providerMask(
  region: EditRegion["region"],
  strokes: Stroke[],
  fill: boolean,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare a mask.");
  context.fillStyle = "#111111";
  context.fillRect(0, 0, 1024, 1024);
  context.globalCompositeOperation = "destination-out";
  if (fill) {
    context.clearRect(region.x, region.y, region.width, region.height);
  } else {
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes) {
      const first = stroke.points[0];
      if (!first) continue;
      context.lineWidth = stroke.width;
      context.beginPath();
      context.moveTo(region.x + first.x, region.y + first.y);
      if (stroke.points.length === 1) {
        context.lineTo(region.x + first.x + 0.01, region.y + first.y + 0.01);
      } else {
        for (const point of stroke.points.slice(1)) {
          context.lineTo(region.x + point.x, region.y + point.y);
        }
      }
      context.stroke();
    }
  }
  context.globalCompositeOperation = "source-over";
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The mask could not be encoded."))), "image/png");
  });
}

function provenanceClass(origin: Revision["origin"]) {
  return origin === "openai" ? "is-live" : origin === "revert" ? "is-revert" : "is-seed";
}

export default function Palimpsest() {
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [activity, setActivity] = useState<ActivityPayload>({
    queue: { queued: 0, active: 0 },
    recent: [],
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedState, setSelectedState] = useState<ArtworkState | null>(null);
  const [currentState, setCurrentState] = useState<ArtworkState | null>(null);
  const [previousState, setPreviousState] = useState<ArtworkState | null>(null);
  const stateCache = useRef(new Map<string, ArtworkState>());
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [comparePosition, setComparePosition] = useState(56);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [choosingRegion, setChoosingRegion] = useState(false);
  const [editRegion, setEditRegion] = useState<EditRegion>({
    tile: { x: 0, y: 0 },
    region: { x: 320, y: 352, width: 384, height: 320 },
  });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [fillMask, setFillMask] = useState(false);
  const [brushWidth, setBrushWidth] = useState(24);
  const [prompt, setPrompt] = useState("");
  const [displayName, setDisplayName] = useState("Anonymous visitor");
  const [executionMode, setExecutionMode] = useState<"demo" | "openai">("demo");
  const [job, setJob] = useState<Job | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [copied, setCopied] = useState(false);

  const revisions = history?.revisions ?? EMPTY_REVISIONS;
  const selectedRevision = revisions[selectedIndex] ?? null;
  const currentRevision = revisions.at(-1) ?? null;

  const loadState = useCallback(async (revisionId: string) => {
    const cached = stateCache.current.get(revisionId);
    if (cached) return cached;
    const state = await fetchJson<ArtworkState>(
      `/api/artworks/palimpsest/state?revisionId=${encodeURIComponent(revisionId)}`,
    );
    stateCache.current.set(revisionId, state);
    return state;
  }, []);

  const refreshActivity = useCallback(async () => {
    const payload = await fetchJson<ActivityPayload>("/api/activity");
    setActivity(payload);
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
    },
    [loadState],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      Promise.all([refreshHistory(), refreshActivity()]).catch((error: unknown) => {
        setLoadingError(error instanceof Error ? error.message : "The archive could not be opened.");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshActivity, refreshHistory]);

  useEffect(() => {
    if (!selectedRevision) return;
    let active = true;
    loadState(selectedRevision.id)
      .then((state) => {
        if (active) setSelectedState(state);
      })
      .catch((error: unknown) => {
        if (active) setLoadingError(error instanceof Error ? error.message : "That revision could not be opened.");
      });
    return () => {
      active = false;
    };
  }, [loadState, selectedRevision]);

  useEffect(() => {
    if (!isPlaying || revisions.length === 0) return;
    const timer = window.setInterval(() => {
      setSelectedIndex((index) => {
        if (index >= revisions.length - 1) {
          setIsPlaying(false);
          return index;
        }
        return index + 1;
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [isPlaying, revisions.length]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshActivity().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [refreshActivity]);

  useEffect(() => {
    if (!job || terminalJobStates.has(job.state)) return;
    const timer = window.setTimeout(async () => {
      try {
        const payload = await fetchJson<{ job: Job }>(`/api/jobs/${encodeURIComponent(job.id)}`);
        setJob(payload.job);
        await refreshActivity();
        if (payload.job.state === "succeeded" && payload.job.resultRevisionId) {
          await refreshHistory(payload.job.resultRevisionId);
          setEditOpen(false);
          setChoosingRegion(false);
          setPrompt("");
          setStrokes([]);
          setFillMask(false);
        }
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Queue status could not be refreshed.");
      }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [job, refreshActivity, refreshHistory]);

  useEffect(() => {
    if (
      !compareEnabled ||
      !selectedRevision ||
      selectedRevision.id !== currentRevision?.id ||
      selectedIndex === 0
    ) {
      return;
    }
    let active = true;
    loadState(revisions[selectedIndex - 1].id)
      .then((state) => {
        if (active) setPreviousState(state);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [compareEnabled, currentRevision?.id, loadState, revisions, selectedIndex, selectedRevision]);

  const comparingCurrent = selectedRevision?.id === currentRevision?.id;
  const expectedPreviousId = selectedIndex > 0 ? revisions[selectedIndex - 1]?.id : null;
  const beforeState =
    comparingCurrent && previousState?.revision.id === expectedPreviousId
      ? previousState
      : null;
  const displayedState = compareEnabled && beforeState ? beforeState : selectedState;
  const compareState = compareEnabled
    ? comparingCurrent
      ? beforeState
        ? selectedState
        : null
      : currentState
    : null;

  const selectRevision = (index: number) => {
    setIsPlaying(false);
    setSelectedIndex(index);
    setCompareEnabled(false);
    setConfirmRevert(false);
  };

  const commitShareState = () => {
    if (!selectedRevision) return;
    const url = new URL(window.location.href);
    url.searchParams.set("revision", selectedRevision.id);
    window.history.replaceState({}, "", url);
  };

  const copyRevisionLink = async () => {
    if (!selectedRevision) return;
    const url = new URL(window.location.href);
    url.searchParams.set("revision", selectedRevision.id);
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const returnToCurrent = () => {
    if (!history) return;
    selectRevision(history.revisions.length - 1);
  };

  const openEditor = () => {
    if (!history || !currentState) return;
    returnToCurrent();
    const assigned = currentState.revision.sequence % 4;
    setEditRegion({
      tile: { x: assigned % 2, y: Math.floor(assigned / 2) },
      region: { x: 320, y: 352, width: 384, height: 320 },
    });
    setEditOpen(true);
    setChoosingRegion(true);
    setCompareEnabled(false);
    setStrokes([]);
    setFillMask(false);
    setJob(null);
    setSubmitError(null);
  };

  const submitEdit = async () => {
    if (!currentState || !history) return;
    const tile = currentState.tiles.find(
      (candidate) => candidate.x === editRegion.tile.x && candidate.y === editRegion.tile.y,
    );
    if (!tile) return;
    setSubmitError(null);
    setIsPreparing(true);
    try {
      const [source, mask] = await Promise.all([
        flattenTile(tile),
        providerMask(editRegion.region, strokes, fillMask),
      ]);
      const form = new FormData();
      form.append(
        "meta",
        JSON.stringify({
          artworkId: "palimpsest",
          baseRevisionId: history.headRevisionId,
          displayName,
          prompt,
          executionMode,
          tile: editRegion.tile,
          region: editRegion.region,
          fill: fillMask,
          strokes,
        }),
      );
      form.append("source", source, "source.png");
      form.append("mask", mask, "mask.png");
      const payload = await fetchJson<{ job: Job; notice: string }>("/api/edits", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: form,
      });
      setJob(payload.job);
      await refreshActivity();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "The edit could not be submitted.");
    } finally {
      setIsPreparing(false);
    }
  };

  const submitRevert = async () => {
    if (!history || !selectedRevision || selectedRevision.id === history.headRevisionId) return;
    setSubmitError(null);
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
          displayName,
        }),
      });
      setJob(payload.job);
      setConfirmRevert(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "The restore could not be queued.");
    }
  };

  const selectedTile = currentState?.tiles.find(
    (tile) => tile.x === editRegion.tile.x && tile.y === editRegion.tile.y,
  );
  const validMask = fillMask || strokes.length > 0;
  const canSubmit =
    !isPreparing &&
    (!job || terminalJobStates.has(job.state)) &&
    prompt.trim().length >= 3 &&
    displayName.trim().length >= 2 &&
    validMask &&
    !choosingRegion;

  return (
    <div className={`palimpsest${editOpen ? " edit-is-open" : ""}`}>
      <header className="site-header">
        <button className="wordmark" type="button" onClick={returnToCurrent} aria-label="Palimpsest, return to current revision">
          Palimpsest
        </button>
        <p>One image. Every change remembered.</p>
        <div className="header-actions">
          <button className="queue-button" type="button" onClick={() => setDrawerOpen(true)}>
            <span className={activity.queue.active > 0 ? "status-dot is-active" : "status-dot"} />
            Queue {activity.queue.queued + activity.queue.active}
          </button>
          <button className="contribute-button" type="button" onClick={openEditor}>
            <span className="desktop-label">Contribute</span>
            <span className="mobile-label">Edit</span>
          </button>
        </div>
      </header>

      <main className="exhibit">
        <section className="artwork-stage" aria-labelledby="revision-heading">
          <ArtworkView
            state={displayedState}
            compareState={compareState}
            compareEnabled={compareEnabled}
            comparePosition={comparePosition}
            onComparePosition={setComparePosition}
            editing={editOpen}
            selecting={editOpen && choosingRegion}
            selectedRegion={editRegion}
            onRegionChange={setEditRegion}
            onRegionConfirm={() => setChoosingRegion(false)}
          />
          {loadingError ? (
            <div className="artwork-error" role="alert">
              <p>{loadingError}</p>
              <button type="button" onClick={() => refreshHistory()}>Try again</button>
            </div>
          ) : null}

          <aside className="museum-label" aria-live="polite">
            {selectedRevision ? (
              <>
                <p className="eyebrow" id="revision-heading">
                  Revision {String(selectedRevision.sequence).padStart(3, "0")}
                  {selectedRevision.id === history?.headRevisionId ? " · Current" : " · Historical"}
                </p>
                <h1>{selectedRevision.author}</h1>
                <time dateTime={selectedRevision.createdAt}>
                  {dateFormatter.format(new Date(selectedRevision.createdAt))}
                </time>
                <blockquote>“{selectedRevision.prompt}”</blockquote>
                <p className={`provenance ${provenanceClass(selectedRevision.origin)}`}>
                  {selectedRevision.provenance}
                </p>
                <div className="label-actions">
                  <button type="button" onClick={() => setCompareEnabled((value) => !value)}>
                    {compareEnabled ? "Close compare" : "Before / Current"}
                  </button>
                  <button type="button" onClick={copyRevisionLink}>
                    {copied ? "Link copied" : "Copy link"}
                  </button>
                </div>
                {selectedRevision.id !== history?.headRevisionId ? (
                  <div className="restore-control">
                    {!confirmRevert ? (
                      <button type="button" onClick={() => setConfirmRevert(true)}>
                        Restore this appearance
                      </button>
                    ) : (
                      <div className="restore-confirmation">
                        <p>This creates a new revision. Existing history remains unchanged.</p>
                        <button type="button" onClick={submitRevert}>Restore as new revision</button>
                        <button type="button" onClick={() => setConfirmRevert(false)}>Cancel</button>
                      </div>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="eyebrow">Opening archive</p>
            )}
          </aside>
        </section>

        {editOpen ? (
          <aside
            className={`edit-inspector${choosingRegion ? " is-positioning" : ""}`}
            aria-label="Contribute an edit"
          >
            <div className="inspector-heading">
              <div>
                <p className="eyebrow">Contribution workspace</p>
                <h2>Add one layer</h2>
              </div>
              <button
                className="close-button"
                type="button"
                aria-label="Close contribution workspace"
                onClick={() => {
                  setEditOpen(false);
                  setChoosingRegion(false);
                }}
              >
                ×
              </button>
            </div>

            <div className="edit-step patch-step">
              <span className="step-number">01</span>
              <div>
                <h3>Choose a patch</h3>
                <p>Drag it on the artwork. Arrow keys nudge it precisely.</p>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => setChoosingRegion((value) => !value)}
              >
                {choosingRegion ? "Use this patch" : "Reposition patch"}
              </button>
            </div>

            <div className="edit-step mask-step">
              <span className="step-number">02</span>
              <div>
                <h3>Mark what may change</h3>
                <p>Paint over the part you want to revise. Everything else remains untouched.</p>
              </div>
              {selectedTile && !choosingRegion ? (
                <>
                  <RegionMaskEditor
                    tile={selectedTile}
                    region={editRegion.region}
                    strokes={strokes}
                    fill={fillMask}
                    brushWidth={brushWidth}
                    onStrokes={setStrokes}
                    onFill={setFillMask}
                  />
                  <div className="mask-tools" role="toolbar" aria-label="Mask tools">
                    <div className="brush-sizes" aria-label="Brush size">
                      {[12, 24, 40].map((size) => (
                        <button
                          key={size}
                          type="button"
                          className={brushWidth === size ? "is-selected" : ""}
                          aria-label={`${size} pixel brush`}
                          aria-pressed={brushWidth === size}
                          onClick={() => setBrushWidth(size)}
                        >
                          <span style={{ width: size / 2, height: size / 2 }} />
                        </button>
                      ))}
                    </div>
                    <button type="button" onClick={() => setStrokes((value) => value.slice(0, -1))} disabled={strokes.length === 0}>
                      Undo
                    </button>
                    <button type="button" onClick={() => { setStrokes([]); setFillMask(false); }} disabled={!validMask}>
                      Clear
                    </button>
                    <button type="button" onClick={() => { setFillMask(true); setStrokes([]); }}>
                      Fill patch
                    </button>
                  </div>
                </>
              ) : (
                <div className="mask-placeholder">Choose the patch on the artwork to begin masking.</div>
              )}
            </div>

            <div className="edit-step prompt-step">
              <span className="step-number">03</span>
              <div>
                <h3>Describe the change</h3>
                <p>Accepted edits become permanent entries in the shared history.</p>
              </div>
              <label>
                <span>Edit prompt</span>
                <textarea
                  value={prompt}
                  maxLength={500}
                  rows={4}
                  placeholder="Example: Add a thin vermilion thread curling through the leaves."
                  onChange={(event) => setPrompt(event.target.value)}
                />
                <small>{prompt.length} / 500</small>
              </label>
              <label>
                <span>Name shown in history</span>
                <input
                  value={displayName}
                  maxLength={32}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <fieldset className="renderer-choice">
                <legend>Renderer</legend>
                <label>
                  <input
                    type="radio"
                    name="renderer"
                    checked={executionMode === "demo"}
                    onChange={() => setExecutionMode("demo")}
                  />
                  <span><strong>Demo renderer</strong>Deterministic paper-and-ink treatment</span>
                </label>
                <label className={!history?.editing.openaiAvailable ? "is-disabled" : ""}>
                  <input
                    type="radio"
                    name="renderer"
                    checked={executionMode === "openai"}
                    disabled={!history?.editing.openaiAvailable}
                    onChange={() => setExecutionMode("openai")}
                  />
                  <span>
                    <strong>Live AI edit</strong>
                    {history?.editing.openaiAvailable ? "OpenAI image editing" : "Not configured on this site"}
                  </span>
                </label>
              </fieldset>
              <p className="base-revision-note">Based on revision {currentRevision?.sequence ?? "—"}</p>
            </div>

            {job ? (
              <div className={`job-status job-${job.state}`} role="status" aria-live="assertive">
                <p className="eyebrow">Queue · {job.executionMode}</p>
                <strong>
                  {job.state === "queued" && job.position
                    ? `Queued · ${Math.max(0, job.position - 1)} ahead`
                    : job.message ?? job.error?.message ?? "Nothing was added to history."}
                </strong>
                {job.state === "succeeded" ? <button type="button" onClick={copyRevisionLink}>Copy revision link</button> : null}
              </div>
            ) : null}
            {submitError ? <p className="submit-error" role="alert">{submitError}</p> : null}
            {!canSubmit && !job ? (
              <p className="submit-hint">
                {choosingRegion
                  ? "Position the patch, then choose Use this patch."
                  : !validMask
                    ? "Paint a mask or fill the assigned patch."
                    : prompt.trim().length < 3
                      ? "Add a short visual edit prompt."
                      : "Add the name that should appear in history."}
              </p>
            ) : null}
            <button className="submit-edit" type="button" disabled={!canSubmit} onClick={submitEdit}>
              {isPreparing ? "Preparing your patch…" : "Add to the work"}
            </button>
          </aside>
        ) : null}
      </main>

      <section className="history-dock" aria-label="Revision history">
        <div className="history-controls">
          <button
            className="play-button"
            type="button"
            aria-label={isPlaying ? "Pause timelapse" : "Play timelapse"}
            onClick={() => setIsPlaying((value) => !value)}
          >
            {isPlaying ? "Ⅱ" : "▶"}
          </button>
          <div className="history-track">
            <div className="history-ticks" aria-hidden="true">
              {revisions.map((revision, index) => (
                <i
                  key={revision.id}
                  className={`${provenanceClass(revision.origin)}${index === selectedIndex ? " is-current" : ""}`}
                  style={{ left: `${revisions.length > 1 ? (index / (revisions.length - 1)) * 100 : 0}%` }}
                />
              ))}
            </div>
            <input
              type="range"
              min="0"
              max={Math.max(0, revisions.length - 1)}
              value={Math.min(selectedIndex, Math.max(0, revisions.length - 1))}
              aria-label="Palimpsest revision"
              aria-valuetext={
                selectedRevision
                  ? `Revision ${selectedRevision.sequence} of ${currentRevision?.sequence}, by ${selectedRevision.author}, ${dateFormatter.format(new Date(selectedRevision.createdAt))}`
                  : "Loading revisions"
              }
              onChange={(event) => selectRevision(Number(event.target.value))}
              onPointerUp={commitShareState}
              onKeyUp={commitShareState}
            />
          </div>
          <output>
            {selectedRevision?.sequence ?? "—"} / {currentRevision?.sequence ?? "—"}
          </output>
        </div>
        <div className="history-meta">
          <p>
            <span className="eyebrow">History</span>
            {selectedRevision ? `${selectedRevision.author} · ${selectedRevision.prompt}` : "Opening the archive"}
          </p>
          <div>
            {selectedRevision?.id !== history?.headRevisionId ? (
              <button type="button" onClick={returnToCurrent}>Return to current</button>
            ) : null}
            <button type="button" onClick={() => setCompareEnabled((value) => !value)}>Before / Current</button>
            <button type="button" onClick={copyRevisionLink}>{copied ? "Copied" : "Copy revision link"}</button>
          </div>
        </div>
      </section>

      {drawerOpen ? (
        <>
          <button className="drawer-backdrop" type="button" aria-label="Close activity" onClick={() => setDrawerOpen(false)} />
          <aside className="activity-drawer" aria-label="Queue and recent activity">
            <div className="drawer-heading">
              <div>
                <p className="eyebrow">Queue</p>
                <h2>{activity.queue.queued} waiting · {activity.queue.active} making</h2>
              </div>
              <button className="close-button" type="button" aria-label="Close activity" onClick={() => setDrawerOpen(false)}>×</button>
            </div>
            <p className="queue-truth">One contribution is made at a time. Newer work never silently overwrites an accepted revision.</p>
            <div className="recent-heading"><span>Recent changes</span><span>State</span></div>
            <ol className="recent-list">
              {activity.recent.map((revision) => (
                <li key={revision.id}>
                  <button
                    type="button"
                    onClick={() => {
                      const index = revisions.findIndex((candidate) => candidate.id === revision.id);
                      if (index >= 0) selectRevision(index);
                      setDrawerOpen(false);
                    }}
                  >
                    <strong>{revision.author}</strong>
                    <span>{revision.prompt}</span>
                    <small>{relativeTime(revision.createdAt)}</small>
                    <em className={provenanceClass(revision.origin)}>{revision.provenance}</em>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        </>
      ) : null}
    </div>
  );
}
