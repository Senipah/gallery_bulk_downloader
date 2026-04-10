# Project Context

## What The Project Does
- Injects a floating "Download Open Gallery" button into any page (`@match *://*/*`).
- Detects supported open lightbox/gallery overlays and extracts media URLs.
- Downloads media into a chosen subfolder using Tampermonkey `GM_download`.

## Runtime Data Model
- `MediaItem`: `{ url, mediaType }`
  - Created via `createMediaItem(url, hintedType)`.
  - `mediaType` is normalized to `image`, `video`, or `unsupported`.
- Download result object:
  - Success: `{ status: 'downloaded', ok: true, url, filename, downloadName, mediaType }`
  - Skip: `{ status: 'skipped', ok: false, ... , skipReason }`
  - Failure: `{ status: 'failed', ok: false, ... , err }`
- Status UI state:
  - `{ title, processed, total, downloaded, skipped, failed, mode }`
- SuperYacht cache:
  - `superYachtTimesCache = { href, nextData, mediaItems }`

## Source / Adapter Matrix
- LightGallery
- Webflow Lightbox
- Parvus Lightbox
- Fancybox
- PhotoSwipe
- FS Lightbox
- GLightbox
- Lightbox2
- Fraser Gallery
- Wix Pro Gallery
- Booking.com Gallery
- SuperYacht Times Article Gallery
- Magnific Popup

All adapters provide the same shape:
- `isOpen()`
- `getCurrentMediaEl()`
- `getCurrentUrl()`
- `getNextButton()`
- `isNextDisabled(btn)`
- `getAllUrls()`
- `waitForNext(previousUrl, timeoutMs)`

## High-Level Execution Flow
1. `MutationObserver` watches DOM changes and calls `syncButtonVisibility()`.
2. Button click triggers `runDownloader()`.
3. `waitForSupportedGalleryOpen()` resolves first matching adapter from `galleryAdapters`.
4. Folder is chosen (`chooseDownloadSubdirectory`), with warning if Tampermonkey download mode is not `browser`.
5. Download mode:
  - Direct list: adapter `getAllUrls()` returns items.
  - Step-through: repeatedly download current media, click next, and wait for URL change.
6. Per item:
  - Normalize URL, infer media type, build filename, call `GM_download`.
7. Final summary shown in status card and alert.

## Normalization And Selection Rules
- `normalizeUrl` strips URL hash.
- `resolveMediaType` uses URL extension and hint fields; embed-like URLs are treated as unsupported.
- `uniqueMediaItems` dedupes by normalized URL.
- Filename fallback is `image-###.jpg` or `video-###.mp4`.
- SuperYacht paths are normalized to `https://photos.superyachtapi.com/download/...` variants.

## Testing Signal And Known Gaps
- Verified automated check present: `node --check script.js`.
- No unit/integration harness in repo; behavior verification is manual in browser against real gallery overlays.
- `examples/` is ignored, so fixtures are local and not versioned by default.

