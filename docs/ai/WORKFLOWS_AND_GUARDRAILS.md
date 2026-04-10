# Workflows And Guardrails

## Local Setup Commands
- Syntax check:
```powershell
node --check script.js
```
- Optional quick repo view:
```powershell
rg --files
```

## Typical Change Routes

## Add or fix a gallery adapter
1. Add/update adapter-specific selectors and extraction helpers in `script.js`.
2. Keep adapter interface complete (`isOpen`, `getCurrentUrl`, `getAllUrls`, etc.).
3. Register adapter in `galleryAdapters` with intentional precedence.
4. Update "supported lightbox" alert list if support matrix changed.
5. Run `node --check script.js`.

## Change media normalization or download behavior
1. Edit shared helpers (`normalizeUrl`, `resolveMediaType`, `createMediaItem`, filename logic).
2. Validate unsupported media still returns `skipped` (not hard failure).
3. Re-check SuperYacht URL normalization if touching path logic.
4. Run `node --check script.js`.

## Change button/status UI behavior
1. Update `ensureStyles`, `setStatusIndicator`, and visibility flow (`syncButtonVisibility`).
2. Keep high z-index values so controls stay above site overlays.
3. Keep `runInProgress` lock semantics to prevent concurrent runs.
4. Run `node --check script.js`.

## Quality Gates
- Required before finalizing:
  - `node --check script.js`
- Manual smoke checks recommended:
  - Open one supported gallery and confirm button appears.
  - Validate one direct-list adapter and one step-through adapter.
  - Confirm expected counts in final summary (`downloaded/skipped/failed`).

## Guardrails
- Do not break adapter precedence unless intentional; first open adapter is selected.
- Do not bypass `uniqueMediaItems`; duplicate downloads are a common regression.
- Do not treat embed URLs as downloadable media.
- Keep download loop serialized unless concurrency is deliberately redesigned.
- Keep `.gitignore` review in mind when adding docs/fixtures (currently ignores `examples/` only).

## Build / Release
- No build pipeline in repository.
- "Release" is updating the userscript file and reinstalling/updating it in Tampermonkey.

