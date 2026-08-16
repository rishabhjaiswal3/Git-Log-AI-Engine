# GitLog AI Engine — Build Phases

Each phase is small and independently reviewable. Do not start a phase until
the previous one is reviewed and approved. Every phase ends with a manual
checkpoint — nothing gets combined into one giant PR.

Architecture reminder (see `PROJECT.md` §2): only files under `adapters/` may
import Octokit, LangChain, or Mongoose. Everything in `services/` and
`orchestrator/` is a plain function that takes data in and returns data out.
Keep that boundary honest phase by phase — it's what makes each phase
independently testable.

**Status:** Phases 0–3 complete. Phase 4 (GitHub Extraction Adapter) is next.

---

## Phase 0 — Repo Scaffolding ✅

**Goal:** empty-but-runnable skeleton, no business logic yet.

- Initialize `backend/` (Node + Express, `package.json`, `.gitignore`,
  `.env.example`) and `frontend/` (Vite + React, Tailwind configured).
- Root `docker-compose.yml` is added in Phase 1 alongside the DB layer it
  exists to support — not here, so this phase stays dependency-free.
- `backend/server.js` boots Express, mounts a `GET /api/health` route
  returning `{ status: "ok" }`.
- `frontend` boots to a blank page with Tailwind confirmed working (one
  styled div).
- Root `README.md` with setup/run instructions for both halves.

**Review checkpoint:** `npm run dev` works in both folders; health check
responds; no unused deps.

---

## Phase 1 — Database Layer + Docker Compose ✅

**Goal:** MongoDB running via Docker Compose, connection + schemas wired up,
no routes consuming them yet.

- Root `docker-compose.yml` — single `mongo:7` service, named volume for
  persistence, port `27017` exposed to the host. No manual `docker run`, no
  local Mongo install. See `PROJECT.md` §6 for the full file and reasoning
  (why only the DB is containerized, not the app processes).
- `backend/config/db.js` — Mongoose connection with clear startup error if
  `MONGODB_URI` is missing/unreachable. `backend/.env`'s `MONGODB_URI` points
  at the Compose service (`mongodb://localhost:27017/gitlog-ai-engine`).
- `backend/models/ChangelogCache.js` (including `generatedJson` and
  `droppedItems` fields) and `backend/models/UserRateLimit.js`, exactly as
  specified in `PROJECT.md` §7.
- Connect `db.js` in `server.js` at boot, fail loudly if connection fails.
- `backend/config/env.js` — the only file that reads `process.env`, exports
  every value as a `SCREAMING_SNAKE_CASE` constant (`PROJECT.md` §16).
- Note: `models/` holds schema definitions only. Nothing queries them yet —
  that's `adapters/cache.repository.js` in Phase 11, keeping Mongoose calls
  out of routes/services from day one.

**Review checkpoint:**
1. `docker compose up -d` starts Mongo cleanly; `docker compose ps` shows it healthy.
2. `npm run dev` (backend) connects successfully against the Compose Mongo —
   no manual container juggling required.
3. Schemas validated with a throwaway script (`backend/scripts/verify-models.js`):
   insert + read one doc of each model, and confirm the unique compound
   index on `ChangelogCache` actually rejects a duplicate `(repoIdentifier,
   latestCommitSha, processingMode)` — call `Model.init()` before testing
   this, since Mongoose builds indexes asynchronously after connecting.
4. `docker compose down` / `up -d` round-trip — data survives a stop/start
   (named volume), confirming persistence works as expected.

---

## Phase 2 — Error Handling Foundation ✅

**Goal:** every failure mode in `PROJECT.md` §12 wired up *before* any
adapter exists, so every adapter written from here on throws typed errors
from day one instead of leaking raw library errors.

- `backend/errors/AppError.js` — base `AppError` class plus
  `ValidationError` (400), `NotFoundError` (404), `SchemaValidationError`
  (422), `RateLimitError` (429), `UpstreamError` (502).
- `backend/middleware/asyncHandler.js` — wraps async route handlers so
  rejected promises reach Express's error handler instead of being
  swallowed or crashing the process.
- `backend/middleware/errorHandler.js` — centralized 4-arg error middleware:
  known `AppError`s map to their status + `{ error: { code, message } }`;
  anything else logs full detail server-side and returns a generic `500`.
- `server.js`: register `errorHandler` last, add
  `process.on('unhandledRejection', ...)` / `process.on('uncaughtException', ...)`
  (log + `process.exit(1)` — fail fast, let the process manager restart
  clean), and graceful shutdown on `SIGTERM`/`SIGINT` (stop accepting new
  connections, drain in-flight requests up to `SHUTDOWN_TIMEOUT_MS`, close
  the Mongo connection, then exit).
- New env vars: `SHUTDOWN_TIMEOUT_MS`, `ADAPTER_TIMEOUT_MS` (the latter isn't
  used until Phase 4's adapter exists, but belongs in `env.js` now so every
  future adapter can just import it).

**Review checkpoint:**
1. Add a temporary route that throws each `AppError` subclass — confirm each
   returns the right status code and a clean JSON body, with no stack trace
   leaking to the client.
2. Add a temporary route that throws a plain `Error` — confirm it logs the
   full stack server-side and still returns a generic `500`, not a crash.
3. Send `SIGTERM` to the running dev server mid-request — confirm the
   in-flight request completes before the process exits, and Mongo
   disconnects cleanly (no dangling-connection warning).
4. Remove the temporary test route before merging.

---

## Phase 3 — Rate Limiting ✅

**Goal:** protect the pipeline from abuse. Moved ahead of the adapters/route
work (it only depends on Phase 1's `UserRateLimit` model and Phase 2's
`RateLimitError`) so it's in place before there's a real endpoint to abuse.

- `backend/adapters/cache.repository.js` gains
  `checkAndIncrementRateLimit(ip)`: a single atomic
  `findOneAndUpdate` with `$inc` (and `upsert: true`) against
  `UserRateLimit` — never read-then-write, which would race under
  concurrent requests from the same IP. Resets `requestCountWithinMonth` to
  1 when `lastRequestTimestamp` falls in a previous calendar month.
- `backend/middleware/rateLimiter.js` — calls the above, throws
  `RateLimitError` once `requestCountWithinMonth > MAX_REQUESTS_PER_MONTH`.
  Sets the `Retry-After` header (RFC 9110) on the 429 response.
- New env var: `MAX_REQUESTS_PER_MONTH`.
- Note (deploy-time, not needed yet): once behind a reverse proxy, Express's
  `trust proxy` setting must be configured or every user shares one IP —
  tracked for Phase 17.

**Review checkpoint:** unit test `checkAndIncrementRateLimit` directly
against the Compose Mongo — fire concurrent calls for the same IP and
confirm the final count matches the number of calls exactly (proves the
atomic increment, not a race). Wire the middleware onto the existing
`/api/health` route temporarily to confirm the 429 + `Retry-After` path
works end-to-end, then remove that temporary wiring (it belongs on
`/api/generate` starting Phase 11).

---

## Phase 4 — GitHub Extraction Adapter

**Goal:** given `owner/repo`, return a rich, filtered dataset — not just bare
commit messages. No grouping, no LLM, no route yet — exercised by a script.

- `backend/adapters/github.adapter.js` using `@octokit/rest`, authenticated
  via `GITHUB_TOKEN`. This is the only file in the project allowed to import
  Octokit.
- Wrap every Octokit call with the `ADAPTER_TIMEOUT_MS` timeout from Phase 2
  and catch/rethrow failures as `NotFoundError` or `UpstreamError` — never
  let a raw Octokit error escape this file.
- Fetch the last `COMMIT_FETCH_LIMIT` commits.
- For each commit, resolve its associated merged PR (if any) and pull the
  PR's **title and description**.
- For each commit, fetch **changed filenames** and a **selected diff
  summary** per file — status (added/modified/removed), additions/deletions
  count, and a short patch excerpt (not the full diff — cap per-file excerpt
  length).
- Filter out commits that only touch lockfiles/build assets (ignore-list:
  `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `dist/`, `build/`).
- Return a normalized shape:
  ```ts
  {
    sha: string, message: string, author: string, date: string,
    pr?: { number: number, title: string, description: string },
    files: [{ filename: string, status: string, additions: number,
               deletions: number, patchExcerpt: string }]
  }[]
  ```
- Handle repo-not-found and empty-commit-history as explicit `NotFoundError`s,
  not silent empty arrays.

**Review checkpoint:** run against 2-3 real public repos (pick at least one
with PR-linked commits), confirm PR titles/descriptions resolve correctly,
diff excerpts are short and readable, filtering behaves, and a deliberately
bad repo name produces a clean `NotFoundError` rather than an Octokit
stack trace.

---

## Phase 5 — Commit Grouping (Pure Service)

**Goal:** cluster related commits/PRs into logical units before anything is
sent downstream. Pure function, tested with fixture data from Phase 4 — no
network calls in this phase at all.

- `backend/services/grouping.service.js` — takes the array from Phase 4,
  returns grouped units. No imports from `adapters/`.
- Rule 1: commits sharing the same merged PR are always one group.
- Rule 2: remaining ungrouped commits are clustered by overlapping changed
  files/directories.
- Rule 3: commits sharing a conventional-commit prefix (`feat:`, `fix:`,
  `chore:`, etc.) touching adjacent paths are merged.
- Each output group aggregates: combined message text, PR title/description
  (if any), union of changed filenames, and member SHAs.

**Review checkpoint:** feed in a fixture set of ~20 commits (including a
PR-linked cluster and some unrelated singletons), confirm groups are sensible
and no commit is silently dropped or duplicated across groups.

---

## Phase 6 — Commit-Aware Prioritization (Pure Service)

**Goal:** replace naive token truncation with priority-ranked group
selection that fits the token budget.

- `backend/services/prioritization.service.js`, using `js-tiktoken` to
  measure running size (not to truncate mid-text). Pure function — takes
  groups + a token budget, returns the surviving subset.
- Score each group from Phase 5 by: PR linkage, commit-type weight (`feat` >
  `fix` > `refactor` > `chore`/`docs`/`test`), number of files touched,
  recency.
- Pack groups into `MAX_INPUT_TOKENS` highest-score first. A group that
  doesn't fit is dropped whole, never cut mid-message.

**Review checkpoint:** unit test with a fixture group set that exceeds the
budget — confirm highest-priority groups always survive, lower-priority ones
are dropped cleanly (no partial/garbled groups in the output), and total
token count stays under budget.

---

## Phase 7 — Mode Registry + Structured Output Schemas

**Goal:** stand up the `modes/` strategy folders — prompt + schema per mode
— before wiring the actual LLM call.

- `backend/modes/freelancer/prompt.js` and `backend/modes/freelancer/schema.js`
  (zod), matching `PROJECT.md` §9.
- `backend/modes/company/prompt.js` and `backend/modes/company/schema.js`.
- `backend/modes/index.js` — exports `{ freelancer, company }`, keyed lookup
  used by everything downstream. No mode-specific `if/else` branching
  anywhere else in the codebase — always go through this map.

**Review checkpoint:** import the registry, confirm both modes resolve their
prompt + schema pair correctly; run each zod schema against a hand-written
valid and invalid fixture JSON to confirm validation actually rejects bad
shapes.

---

## Phase 8 — Gemini Adapter (Structured JSON)

**Goal:** wire LangChain + Gemini 1.5 Flash to return validated JSON, not
free-text markdown.

- `backend/adapters/gemini.adapter.js` — `generateStructured(groups, mode)`:
  looks up the prompt/schema via `modes/index.js`, calls Gemini via
  LangChain (wrapped with `ADAPTER_TIMEOUT_MS` from Phase 2), parses the
  response as JSON, validates against the mode's zod schema. On validation
  failure, retry once with an explicit "your last response was invalid
  JSON" repair prompt; on second failure, throw `SchemaValidationError`
  (422). Any network/timeout failure throws `UpstreamError` (502). This is
  the only file allowed to import LangChain/the Gemini client.

**Review checkpoint:** manually run both modes against Phase 6's output for a
small real repo, confirm the returned JSON always validates against the
schema, and deliberately break the model's response once (e.g. via a bad
prompt tweak) to confirm the retry-then-fail path works.

---

## Phase 9 — Factual-Grounding Checks (Pure Service)

**Goal:** verify the LLM's JSON claims against source data before anything
is rendered.

- `backend/services/grounding.service.js` — `groundAndFilter(json, groups)`:
  1. SHA existence check — drop items citing a `relatedCommits` SHA not
     present in `groups`.
  2. Lexical overlap check — drop items whose description doesn't share
     meaningful keyword overlap (configurable via `GROUNDING_MIN_OVERLAP`)
     with their cited commits' messages/files.
  3. Volume sanity check — cap items per section relative to input group
     count; trim lowest-confidence excess items first.
  - Returns `{ verified: <filtered json>, dropped: string[] }` (dropped
    reasons logged, never shown to the client).
  - If a required section ends up empty after filtering, throw
    `UpstreamError` (502 at the route level) — don't render a misleadingly
    sparse changelog.

**Review checkpoint:** unit test with a fixture JSON response that includes
one deliberately-invented item (fake SHA) and one deliberately-unrelated
item (real SHA, unrelated description) — confirm both are dropped and
legitimate items survive.

---

## Phase 10 — Markdown Rendering (Pure Service, Per-Mode)

**Goal:** deterministic JSON → Markdown, so the model never controls
formatting.

- `backend/modes/freelancer/render.js` and `backend/modes/company/render.js`
  — each maps its mode's verified JSON onto the exact markdown template from
  `PROJECT.md` §9 (`### 🚀 Summary of Work`, `## 🌟 What's New`, etc.).
- `backend/services/render.service.js` — thin dispatcher: looks up the right
  mode's `render.js` via `modes/index.js` and calls it. Pure function, same
  JSON in, same markdown out, every time.

**Review checkpoint:** feed the renderer a fixture JSON for each mode,
byte-diff the output against the expected template structure.

---

## Phase 11 — Cache Repository + `/api/generate` Route (End-to-End)

**Goal:** wire everything together behind the real API contract — extraction
through rendering, plus caching and the rate limiter built in Phase 3.

- `backend/adapters/cache.repository.js` — add `getCached()` / `saveResult()`
  alongside the rate-limit methods from Phase 3. This remains the only file
  allowed to call `ChangelogCache`/`UserRateLimit` Mongoose methods directly.
- `backend/orchestrator/generate.orchestrator.js` — runs cache-check →
  extraction → grouping → prioritization → llm → grounding → render → cache
  write, in sequence. Contains no business logic itself, only wiring.
- `backend/routes/generate.js` — wraps the handler in `asyncHandler`
  (Phase 2), applies `rateLimiter` (Phase 3), validates
  `{ owner, repo, mode }` (throws `ValidationError` on a bad shape), calls
  the orchestrator, returns the contract shape from `PROJECT.md` §8.
- Wire `errorHandler` (Phase 2) as Express's last middleware if not already
  done.

**Review checkpoint:** hit the route with curl/Postman for both modes on a
couple of real repos, confirm response shape and error codes match the
contract exactly (400/404/422/429/502 all reachable), spot-check rendered
markdown reads well, then call the same repo/mode twice — the second call
must be near-instant and marked `cached: true`.

---

## Phase 12 — Benchmarking & Performance Instrumentation

**Goal:** know exactly where request time goes, and have a repeatable way to
measure regressions, per `PROJECT.md` §14.

- `generate.orchestrator.js` records a timestamp before/after each pipeline
  stage and logs a structured breakdown per request (`requestId`, per-stage
  `ms`, `totalMs`, `cached`).
- `backend/scripts/benchmark.js` — a manual dev script (not part of the app
  or CI) that hits `POST /api/generate` N times against a couple of real
  repos and reports p50/p95/p99 latency separately for cache-miss and
  cache-hit paths.

**Review checkpoint:** run `benchmark.js` against a real repo — confirm
cache-hit latency is milliseconds and cache-miss latency is dominated by the
`llm` stage in the timing breakdown (i.e. the numbers tell the story you'd
expect from the architecture, not something surprising).

---

## Phase 13 — Frontend: Dashboard Shell

**Goal:** the input form and mode toggle, no API wiring yet (stub response).

- `frontend/src/components/Dashboard.jsx` — container component: owns
  `owner`/`repo` inputs, freelancer/company toggle, submit button, and all
  state.
- `frontend/src/api/client.js` — fetch wrapper stub (returns hardcoded
  markdown for now).
- Basic layout with Tailwind, no loading states needed yet.

**Review checkpoint:** form captures input correctly, toggle switches mode,
submit logs the payload to console.

---

## Phase 14 — Frontend: API Integration + State Machine

**Goal:** real backend wiring with the "zero-willpower UI" states from
`PROJECT.md` §16.

- `client.js` calls the real `POST /api/generate`.
- `Dashboard.jsx` tracks explicit states: `idle | loading | success | error`.
- Loading state (spinner/disabled form), error state (readable message per
  error code from §8, including `422`), success state hands markdown to
  `RenderMarkdown`.

**Review checkpoint:** exercise all states manually — valid repo, invalid
repo, rate-limited, schema-invalid (if reproducible), and a slow/successful
generation.

---

## Phase 15 — Frontend: Markdown Rendering + Download

**Goal:** display and export the generated output.

- `frontend/src/components/RenderMarkdown.jsx` — presentational component
  (props in, JSX out) using `react-markdown`.
- "Copy to clipboard" and "Download as .md" actions.
- Confirm `react-markdown`'s default sanitization is active (no raw HTML
  passthrough).

**Review checkpoint:** generate real output for both modes, verify rendering
matches the markdown structure, copy/download both work.

---

## Phase 16 — Frontend: Resilience

**Goal:** handle the unexpected — crashes, hangs, and rate limits — per
`PROJECT.md` §15.

- `frontend/src/components/ErrorBoundary.jsx` — wraps `<Dashboard />` in
  `App.jsx`, catches render-time exceptions, shows a fallback UI instead of
  a blank screen.
- `client.js` — `AbortController` with a client-side timeout; a timeout
  produces its own distinct error state, not the generic upstream message.
- `Dashboard.jsx` — the `error` state always renders a "Try again" action
  that re-submits the same request.
- `429` responses render distinctly from other errors, surfacing the
  backend's `Retry-After`/reset info.
- Loading state shows a "this can take up to ~X seconds" hint sourced from
  Phase 12's real benchmark numbers, not a bare spinner.

**Review checkpoint:** simulate each failure mode — throw inside a child
component (confirm the boundary catches it), point `client.js` at a
deliberately slow/unresponsive endpoint (confirm the abort timeout fires),
and trigger a real `429` from Phase 3's rate limiter (confirm the
`Retry-After` message renders correctly).

---

## Phase 17 — Polish & Deploy Readiness

**Goal:** production hardening, not new features.

- Env var validation on backend boot (fail fast if `GITHUB_TOKEN` /
  `GOOGLE_API_KEY` / `MONGODB_URI` missing) — extends Phase 2's process-level
  safety nets to cover missing config, not just runtime errors.
- `app.set('trust proxy', ...)` configured correctly for the deploy target
  (flagged back in Phase 3).
- CORS locked to the frontend's deployed origin.
- Frontend production build (`vite build`) verified as a single static
  bundle; Tailwind purge confirmed.
- Deployment docs: where backend + frontend + Mongo are hosted, and required
  env vars for each.

**Review checkpoint:** full smoke test against a production-like build:
generate in both modes, confirm caching, rate limiting, grounding drops,
graceful shutdown, and all frontend error states survive a prod build.

---

## Explicitly Deferred (Post-v1)

- Auth / user accounts
- Private repo support (GitHub OAuth app)
- Multi-repo batch runs
- Partial regeneration of a single markdown section
- Second-pass LLM-based grounding verification (v1 is heuristic/lexical only)
- Automated load testing (k6/autocannon) — the manual benchmark script
  (Phase 12) is sufficient while the bottleneck is LLM latency, not
  concurrency
