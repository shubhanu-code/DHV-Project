# Fixes in this revision

## Data pipeline
- Institution names no longer contain scraped UI text ("More Details Close | Close |"); this affected ~99% of records.
- Upper-case state names ("TAMIL NADU") are normalised so they are not counted as separate states.
- Parser unit tests were failing (missing `prepared_at` argument); fixed and extended (5 tests pass).
- `data/processed/*` regenerated from the retained raw HTML (6,966 records, 0 duplicates, all scores 0–100).

## Backend (`backend/server.js`)
- Dataset is parsed once and cached (re-read only when the file changes) instead of re-parsing ~7 MB on every request, including the 10 s health check.
- Unfiltered `/api/rankings` is gzip-cached (7.4 MB → ~0.7 MB).
- Invalid `year` returned an empty result silently; it now returns HTTP 400.
- Malformed JSON, `null` context or non-object bodies on `/api/copilot` returned HTML/500 errors; every error is now JSON.
- Institutions are grouped by a stable `institution_key` (IDs change format between 2017/2018/2019+; names differ in punctuation; same-named colleges in different cities are kept apart).
- Copilot "trend" now actually describes the score trend; keyword matching uses word boundaries.
- Clear message on "port in use", graceful shutdown.

## Frontend
- Trend chart broke for institutions whose published name changed between years; now keyed by `institution_key`.
- Institution picker, trend chart, radar and "rank/score" cards no longer show a stale institution after changing category/state/year.
- Header button styles were broken by a corrupted CSS selector (`.ctions`); fixed.
- Previously non-functional controls now work: sidebar navigation, Export report (CSV), search, Full table, View all states, Try it, retry on load failure. Dead bell icon removed. Backend status is displayed.
- Radar chart geometry corrected; empty/withdrawn/rank-band values handled; "Quick insight" uses the full institution name.
- Sparkbars respect the category/state filters; correct median for even counts; duplicate React keys removed; error boundary added.
- `api.js`: no needless CORS preflight on GET, 30 s timeout, accurate error messages.

## Config
- Vite `base: "./"` so GitHub Pages sub-path deploys don't 404 on assets.
- Dependencies pinned to the locked versions instead of `"latest"` (lockfile root updated so `npm ci` still works).
- `.gitignore` now excludes `.venv/`.
