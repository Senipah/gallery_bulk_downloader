# Project Context

## What This Project Does
- Provides a Tampermonkey userscript (`script.js`) that shows a floating button when a supported lightbox is open.
- On click, it bulk-downloads media from the open gallery/lightbox.
- Current supported adapters:
- `LightGallery`
- `Webflow Lightbox`
- `Parvus Lightbox`
- `Fancybox`
- `PhotoSwipe`
- `FS Lightbox`
- `GLightbox`
- `Lightbox2`
- `Magnific Popup`

## Runtime Data Model
- No persistent storage and no external backend.
- Runtime entities are in-memory only:
- `media item`: `{ url, mediaType }`
- `download result`: `{ status, ok, url, filename, mediaType, skipReason?, err? }`
- URL normalization strips hash fragments and resolves relative paths against `window.location.href`.

## Source/Adapter Matrix
- Adapter contract (normalized interface):
- `isOpen()`
- `getCurrentMediaEl()`
- `getCurrentUrl()`
- `getNextButton()`
- `isNextDisabled(btn)`
- `getAllUrls()`
- `waitForNext(previousUrl, timeoutMs)`
- Adapter selection is first-match by order in `galleryAdapters`.

## High-Level Execution Flow
1. `MutationObserver` watches DOM changes and toggles button visibility.
2. Clicking the button calls `runDownloader()`.
3. `waitForSupportedGalleryOpen()` resolves the active adapter.
4. Downloader prefers direct extraction via `adapter.getAllUrls()`.
5. If direct extraction is unavailable/ambiguous, fallback is step-through:
- download current media
- click next
- wait for URL change
- stop at disabled next/repeated URL/timeout
6. Script reports `downloaded / skipped / failed` via alert and logs details.

## Media Rules and Normalization
- Supported for download:
- direct file images (`IMAGE_EXTENSIONS`)
- direct file videos (`VIDEO_EXTENSIONS`)
- Explicitly skipped:
- embed/iframe-like hosts and content
- unsupported or untyped URLs
- blob/data URLs

## Testing Signal and Known Gaps
- Present test signal:
- `node --check script.js` (syntax only)
- manual browser validation on sample and live pages
- Current gaps:
- no automated unit/integration tests
- adapter selectors rely on third-party DOM/class conventions that may drift
- no CI pipeline defined in repo
