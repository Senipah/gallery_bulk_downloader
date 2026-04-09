# Workflows and Guardrails

## Local Setup Commands
- Open this folder in your editor:
```powershell
cd "W:\Shared drives\Intelligence Team\Scripts\tampermonkey\gallery_bulk_downloader"
```
- Validate syntax:
```powershell
node --check script.js
```
- Load/update in Tampermonkey by pasting `script.js` into a userscript entry.

## Typical Change Routes
- Adapter support changes:
- add/adjust helper resolvers
- add/update one adapter object
- register adapter in `galleryAdapters` in desired priority order
- Core behavior changes:
- media typing/normalization in helper functions
- download semantics in `downloadMediaItem`, `downloadMediaItems`, `downloadByStepping`
- UI changes:
- button style/text and visibility sync in `ensureStyles`, `syncButtonVisibility`, observer/init logic

## Quality Gates
- Required:
- `node --check script.js`
- Manual run in browser for at least one page per touched adapter.
- Manual checks:
- button appears only when supported modal is open
- direct extraction vs stepping fallback still works
- alert counts match visible behavior (`downloaded / skipped / failed`)

## Guardrails
- Preserve adapter contract shape and method names.
- Keep download scope to direct `image`/`video` files only unless intentionally changing policy.
- Do not remove URL normalization/deduplication.
- Keep fallback stepping path available when direct group resolution is uncertain.
- Avoid library-specific assumptions in shared helpers unless they are broadly safe.

## Build/Release
- No build pipeline.
- Release is updating userscript metadata/version and replacing script contents in Tampermonkey.
- Optional pre-release smoke test:
- one LightGallery/Webflow case
- one non-native adapter case (for example Fancybox or PhotoSwipe)
