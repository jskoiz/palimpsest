# Palimpsest — Build Week submission kit

## Project card

**Title:** Palimpsest

**Tagline:** One canvas. Many hands. No collisions.

**Best-fit track:** Apps for your life

**Short description**

Palimpsest is a live communal artwork where people make precise AI edits together. Contributors can work anywhere on the canvas in parallel; only regions currently being generated are locked. Every accepted change becomes part of an immutable, playable history.

## Full description

Most AI image tools are solitary and disposable: one person prompts, gets an output, and replaces what came before. Palimpsest turns image generation into a shared public act.

A contributor places a free-position patch anywhere on one canonical canvas, paints the exact area that may change, optionally adds a reference image, and describes the edit. GPT-5.6 converts that request into a concise visual plan without adding new intent. GPT Image then edits only the masked context frame.

The collaboration model is spatial. Every active contribution owns a temporary global-coordinate reservation. Overlapping work is blocked atomically, edge contact stays available, and non-overlapping edits can moderate and generate in parallel. A short fenced commit step keeps the visible history linear even when creation is concurrent.

Accepted edits never overwrite the archive. The timeline can scrub, play, compare, share, and restore earlier looks; a restore is itself a new revision. Palimpsest is both a canvas and the memory of everyone who touched it.

## Problem and impact

Creative AI rarely gives groups a shared space with clear authorship, precise boundaries, and reversible history. Palimpsest could support community murals, classrooms, collaborative world-building, public art experiments, and small creative teams—without forcing people to wait for the entire canvas to become available.

Its central idea extends beyond art: coordinate-based reservations plus immutable history are a useful interaction model for any shared generative surface.

## How Codex was used

Codex was the development partner from product definition through final QA. It helped design and implement:

- free-position edit geometry across former tile seams;
- pan, zoom, keyboard navigation, and the draggable revision timeline;
- mask drawing and optional reference-image normalization;
- atomic D1 reservations, lease expiry, recovery, and commit fencing;
- parallel non-overlapping generation and immutable revision reconstruction;
- the welcome guide, narrow-screen layouts, and accessible control semantics;
- regression tests, adversarial race review, and browser-based visual verification.

Parallel Codex reviews independently examined the reservation lifecycle, client collision behavior, and expiry/recovery race. Their findings were integrated and re-tested on the same checkout.

## How GPT-5.6 is used

GPT-5.6 is part of the live edit pipeline. After moderation, it receives the contributor's original request plus whether a reference image is present. It returns a short intent-preserving visual plan for GPT Image. The planner is instructed not to invent subjects, text, symbolism, composition, or style. The original human prompt remains the public history entry.

This improves visual coherence while keeping the contributor—not the model—as the author of the idea.

## Demo script (2:35 target)

The final video must be public, under three minutes, and include spoken audio.

**0:00–0:15 — The idea**

“This is Palimpsest: one shared AI artwork, many simultaneous contributors, and no erased history.” Show the welcome guide, then close it.

**0:15–0:35 — The living archive**

Open the bottom timeline. Drag through revisions, play the sequence, compare one change, and show that an earlier state can be restored without deleting later history.

**0:35–1:10 — Make a precise edit**

Choose Contribute. Drag the patch to an arbitrary location and across a seam. Continue, paint a small mask, attach a reference image, enter a concise prompt, and reserve the area.

**1:10–1:30 — GPT-5.6 in the loop**

Open the queue and explain: moderation checks the original request; GPT-5.6 produces an intent-preserving edit plan; GPT Image renders only inside the retained mask.

**1:30–1:58 — Collaboration**

Use two browser windows. Start one deliberately slow contribution. Show its live outline, demonstrate that the second user cannot enter that region, then place a different patch elsewhere and work in parallel.

**1:58–2:18 — Commit and compare**

Let an edit finish, show the new immutable revision, and compare before/after. Point out that the original human prompt and author remain attached to the revision.

**2:18–2:35 — Codex and close**

Briefly show the code/tests or architecture diagram. Explain that Codex helped design, implement, adversarially review, and verify the product. End on the full canvas and tagline: “One canvas. Many hands. No collisions.”

## Suggested screenshots

1. Full canvas with the timeline open.
2. A free-position patch crossing a seam.
3. Mask painting with an optional reference preview.
4. Two non-overlapping live reservations in parallel.
5. A blocked overlap with the locked-region explanation.
6. Before/after comparison on an accepted revision.

## Submission checklist

- [ ] Record and upload a public YouTube demo under three minutes with spoken audio.
- [ ] Add the public video URL: `TODO`.
- [ ] Deploy a free-to-access working build and add the URL: `TODO`.
- [ ] Add the code repository URL: `TODO`.
- [ ] If public, choose and add an open-source license.
- [ ] If private, share repository access with `testing@devpost.com` and `build-week-event@openai.com`.
- [ ] Submit the Codex session ID from `/feedback` where most core work happened: `TODO`.
- [ ] Confirm production secrets and Cloudflare D1/R2 bindings.
- [ ] Run `npm run lint`, `npx tsc --noEmit`, and `npm test` from the submission commit.
- [ ] Re-run the two-window overlap demo against the deployed build.
- [ ] Submit on Devpost before **July 21, 2026 at 5:00 PM PDT**.

Official references: [Build Week](https://openai.com/build-week/), [Devpost submission page](https://openai.devpost.com/), and [official rules](https://openai.devpost.com/rules).

## Local verification — July 21, 2026

- Production build completed successfully.
- ESLint completed with no findings.
- TypeScript completed with no errors.
- All 40 focused tests passed.
- Desktop, 734×734, and 390×844 browser checks rendered nonblank and without page-level horizontal overflow.
- Welcome guide, patch selection, mask selection, prompt/reference controls, and queue states were exercised without submitting a destructive edit.
- Browser console contained no warnings or errors.
- A minimal live Responses API check completed successfully through the configured `gpt-5.6` alias and returned from `gpt-5.6-sol`.

This is local proof only. Deployment, public repository access, the final YouTube upload, two-user hosted verification, `/feedback` session ID, and Devpost submission remain external gates.
