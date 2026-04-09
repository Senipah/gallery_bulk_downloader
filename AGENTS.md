# Agent Onboarding

## Purpose
This repository contains a single Tampermonkey userscript that bulk-downloads image/video files from supported open lightbox overlays. The script is fully client-side and runs in the browser context through Tampermonkey.

## Read Order
1. [README.md](/w:/Shared drives/Intelligence Team/Scripts/tampermonkey/gallery_bulk_downloader/README.md)
2. [PROJECT_CONTEXT.md](/w:/Shared drives/Intelligence Team/Scripts/tampermonkey/gallery_bulk_downloader/docs/ai/PROJECT_CONTEXT.md)
3. [WORKFLOWS_AND_GUARDRAILS.md](/w:/Shared drives/Intelligence Team/Scripts/tampermonkey/gallery_bulk_downloader/docs/ai/WORKFLOWS_AND_GUARDRAILS.md)
4. [script.js](/w:/Shared drives/Intelligence Team/Scripts/tampermonkey/gallery_bulk_downloader/script.js)

## Working Set
- [script.js](/w:/Shared drives/Intelligence Team/Scripts/tampermonkey/gallery_bulk_downloader/script.js)
: source of truth for runtime behavior, adapter support, and UI button logic.
- `.gitignore`
: excludes local sample assets under `examples/`.

## Core Invariants
- The script only operates when a supported lightbox is currently open.
- Download scope is direct-file media only: `image` or `video`.
- Non-file and embedded content is skipped as unsupported (not downloaded).
- Media URLs are normalized and deduplicated before download.
- Adapter flow is: `getAllUrls()` first, fallback to step-through navigation.

## Validation Baseline
- Syntax check:
```powershell
node --check script.js
```
- Manual browser validation in Tampermonkey against representative pages per adapter.
