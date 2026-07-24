# Palimpsest

**One canvas. Many hands. No collisions.**

Palimpsest is a live communal artwork with a permanent memory. Anyone can place an edit region anywhere on the canvas, paint exactly what may change, optionally attach a reference image, and describe an idea. GPT Image renders only the masked area, and GPT-5.6 checks the result before acceptance. Every accepted contribution becomes the next immutable revision.

Multiple people can work at once. A live reservation locks only the region currently being generated, so the rest of the canvas remains open.

## How it works

1. **Place** a free-position patch anywhere on the 2048×2048 artwork.
2. **Mask** the pixels that may change, or choose the entire patch.
3. **Describe** the edit and optionally attach a PNG, JPEG, or WebP reference.
4. **Render and review.** GPT Image edits the current masked context frame. A positioned reference preview is supplied as a second visual input, and the original source frame is retained for an independent fidelity, preview-alignment, blending, and preservation review.
5. **Remember.** The accepted patch is appended as a new revision. The timeline can scrub, compare, replay, and share earlier states without changing the current canvas.

## Why it is different

- **Parallel creation without collisions.** Atomic artwork-space reservations reject positive-area overlap while allowing independent edits to generate concurrently.
- **Precise, reversible AI editing.** Each generated context frame retains a display mask, so pixels outside the reserved area remain unchanged.
- **A public creative memory.** Earlier looks remain available as a view-only archive without becoming the current canvas again.
- **Fluid canvas navigation.** Patches can cross former tile seams, while pan, zoom, keyboard movement, and a draggable timeline keep the full work navigable.

## OpenAI in the product

- **GPT-5.6 (`gpt-5.6`)** reviews generated subjects for framing and blending. Reference-guided edits additionally require fidelity, preview-scale alignment, and preservation of uncovered prior artwork.
- **GPT Image (`gpt-image-2`)** performs the masked image edit on a 1024×1024 crop of the current canvas. Reference subjects are already positioned in that input at the exact on-canvas footprint.
- **OpenAI Moderation (`omni-moderation-latest`)** checks the contributor's original request before planning or generation.

The queue fails closed if any required OpenAI step is unavailable. The original contributor prompt—not the generated plan—remains the public historical record.

## Architecture

- Next.js-compatible React UI on vinext and Cloudflare Workers
- D1 for artworks, revisions, edit reservations, visitor activity, commit fencing, rate windows, and blob metadata
- R2 for canonical tiles, masks, references, patches, and keyframes
- Generated D1 migrations as the authoritative schema
- Atomic global-coordinate reservations with lease recovery and overlap rejection
- Parallel moderation/generation with a short fenced commit lock that preserves linear history
- Region-aware rebasing for non-overlapping jobs after the head advances
- Append-only database triggers for immutable revisions

Bindings are declared in `.openai/hosting.json`. Generated D1 migrations live in `drizzle/`.

## Local development

Requires Node.js 22.13 or later.

```bash
npm install
```

Create an uncommitted `.env.local`:

```text
OPENAI_API_KEY=your_key_here
```

Then start the app:

```bash
npm run dev
```

Open `http://localhost:4317/` (or the port printed by the development server). No sample download is required: local D1 is initialized with one plain white 2048×2048 seed revision.

Without `OPENAI_API_KEY`, the archive remains viewable but new contributions are disabled. Configure the same name as a production secret before deployment.

## Public debug dashboard

`/debug` is a public, unlinked, `noindex` operations dashboard. It shows current queue health, durable failures, request and error IDs, recent reference-image uploads, accepted revisions, privacy-bounded viewer stats, and the latest activity events. Terminal failures never appear in the live canvas queue. A retry button appears on `/debug` only when the current browser owns the server-validated retry capability for that job.

Visitor records contain a salted, pseudonymous network ID, an opaque per-tab session ID when JavaScript is available, country code, and a truncated user agent. Raw IP addresses are never stored. Configure `VISITOR_LOG_SALT` as a production secret (or retain the existing `RATE_LIMIT_SALT` as a temporary fallback) before deployment.

## Validation

```bash
npm run lint
npx tsc --noEmit
npm test
```

Focused tests cover revision ordering, free-position region limits, seam crossing, reservation overlap, expired leases, generation frames, region-aware concurrency, reference images, GPT-5.6 request/response handling, view-only history, and stable secret-free history serialization.

## Built with Codex

Codex was the development partner across the entire build: product framing, freeform region geometry, canvas navigation, the draggable timeline, onboarding, concurrent reservation design, D1/R2 architecture, reference-image support, and submission QA. Parallel Codex reviews independently pressure-tested the reservation lifecycle, client collision behavior, and expiry/recovery race before integration.

The resulting product uses GPT-5.6 at runtime, not only during development: every accepted image request passes through its intent-preserving edit planner before rendering.

See [BUILD_WEEK_SUBMISSION.md](./BUILD_WEEK_SUBMISSION.md) for the prepared submission copy, demo script, and remaining external checklist.
