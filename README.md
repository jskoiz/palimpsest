# Palimpsest

Palimpsest is one canonical communal image with an immutable, linear memory of every accepted change. Visitors place a bounded region anywhere on the artwork, paint a mask, and submit a prompt. The artwork is reconstructed from tiled keyframes and globally positioned patch layers instead of re-encoding the master. Multiple edits can generate at once when their reserved regions do not overlap.

## Architecture

- Next.js-compatible UI on vinext and Cloudflare Workers
- D1 for artworks, revisions, edit reservations, commit fencing, rate windows, and blob metadata
- R2 for canonical tiles, masks, patches, and keyframes
- Generated D1 migrations are authoritative; request handlers never rerun schema DDL
- Atomic artwork-space reservations: active regions reject positive-area overlap while edge contact remains available
- Parallel moderation and generation with a short fenced commit lock that preserves immutable linear history
- Region-aware rebasing lets non-overlapping jobs commit after the head advances
- Every generated 1024×1024 context frame retains a display mask, so only its reserved region can alter the artwork
- Deterministic demo renderer, plus an explicit OpenAI image-edit path when `OPENAI_API_KEY` is configured
- Append-only database triggers; restoring an earlier state creates a new revision

Bindings are declared in `.openai/hosting.json`. Generated D1 migrations live in `drizzle/`.

## Local development

Requires Node.js 22.13 or later.

```bash
npm install
npm run dev
```

To enable live image edits locally, create an uncommitted `.env.local`:

```text
OPENAI_API_KEY=your_key_here
```

Without the key, every product flow remains usable through the clearly labeled deterministic demo renderer.

## Validation

```bash
npm run lint
npx tsc --noEmit
npm test
```

Focused tests cover revision ordering, free-position region limits, seam crossing, overlap rules, generation frames, region-aware concurrency, revert layer resolution, and stable history serialization.
