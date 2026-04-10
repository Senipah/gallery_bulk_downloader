# AI Agent Onboarding

## Purpose
This repository ships one Tampermonkey userscript (`script.js`) that detects open gallery/lightbox overlays on the current page and bulk-downloads supported image/video media via `GM_download`.

## Read Order
1. `README.md`
2. `docs/ai/PROJECT_CONTEXT.md`
3. `docs/ai/WORKFLOWS_AND_GUARDRAILS.md`
4. `script.js` (single source of truth)

## Working Set
- `script.js`: all behavior (adapter detection, extraction, normalization, download loop, UI/status).
- `README.md`: minimal project overview + syntax-check command.
- `examples/` (ignored): local fixtures for manual debugging only.

## Core Invariants
- `galleryAdapters` order is detection precedence; first open adapter wins.
- Media goes through `createMediaItem` and `uniqueMediaItems` before download.
- Only direct `image`/`video` URLs are downloaded; embeds/unknown types are skipped.
- `adapter.getAllUrls()` direct-list mode is preferred; step-through fallback is used when direct extraction is missing or unreliable.
- Downloads are serialized (`await` per item) and use `GM_download({ saveAs: false })`.
- UI button is only visible when `getOpenGalleryAdapter()` returns a live adapter.

## Validation Baseline
- `node --check script.js`

