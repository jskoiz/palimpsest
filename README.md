# Palimpsest

Palimpsest is one canonical communal image with an immutable, linear memory of every accepted change. Visitors edit a bounded region, paint a mask, and submit a prompt; the artwork is reconstructed from tiled keyframes and patch layers instead of re-encoding the master.

## Architecture

- Next.js-compatible UI on vinext and Cloudflare Workers
- D1 for artworks, revisions, queue jobs, locks, rate windows, and blob metadata
- R2 for canonical tiles, masks, patches, and keyframes
- Serial edit queue with leases, fencing, idempotency, and optimistic base-revision checks
- Deterministic demo renderer, plus an explicit OpenAI image-edit path when `OPENAI_API_KEY` is configured
- Append-only database triggers; restoring an earlier state creates a new revision

Bindings are declared in `.openai/hosting.json`. The generated D1 migration is in `drizzle/0000_slow_gambit.sql`.

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

Focused tests cover revision ordering, edit-region limits, stale bases, revert layer resolution, and stable history serialization.
