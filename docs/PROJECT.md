# GitLog AI Engine — Project Specification

## 1. What This Is

A Micro-SaaS tool that turns raw Git history into readable documentation.
Point it at a public GitHub repo, pick a mode, and it produces either:

- **Freelancer Mode** — a technical daily task sheet / standup report, grouped by
  system layer (Backend, Frontend, Database, Architecture), for client status
  updates.
- **Company Mode** — a customer-facing changelog (New Features / Improvements /
  Bug Fixes), with internal dev noise (lockfile bumps, merge commits, test
  commits) filtered out.

Stack: React (Vite) frontend, Node.js/Express backend, MongoDB for
persistence, LangChain + Gemini 1.5 Flash for summarization, Octokit for
GitHub access, js-tiktoken for local token counting.

The core design bet: **don't hand the LLM raw commit noise and hope.** Extract
commits *and* PRs, group them into logical units of work, prioritize what
actually fits the token budget, force the model to answer in structured JSON
instead of free-text markdown, and verify every claim it makes against source
data before it's rendered. Markdown formatting is deterministic code, not
something the model improvises.

## 2. Architecture Pattern

Two patterns govern the backend, chosen to fit this project's actual shape —
a linear data pipeline with several volatile external dependencies (GitHub,
Gemini, MongoDB) — rather than a generic layered template:

- **Pipes-and-Filters** for the core pipeline. Each stage
  (grouping/prioritization/grounding/render) is a pure function: one input
  shape in, one output shape out, no side effects. Independently testable
  and reorderable. (Hohpe & Woolf, *Enterprise Integration Patterns*, 2003.)
- **Hexagonal / Ports & Adapters** for boundaries to the outside world. The
  pipeline core never imports Octokit, LangChain, or Mongoose directly —
  only code inside `adapters/` is allowed to. Everything else depends on a
  plain function signature, not a concrete library. (Cockburn, "Hexagonal
  Architecture," 2005.) This is enforced by convention, not a DI framework —
  the project is small enough that a formal ports layer would be ceremony
  without payoff.

On top of that:

- **Strategy pattern** for the freelancer/company mode split — each mode is a
  self-contained folder (`prompt.js` + `schema.js` + `render.js`) registered
  in one lookup map, so adding a third mode later means adding one folder,
  not touching five files. (Gamma et al., *Design Patterns*, 1994.)
- **Repository pattern** for MongoDB access — `adapters/cache.repository.js`
  is the only file that calls Mongoose methods directly. (Fowler, *Patterns
  of Enterprise Application Architecture*, 2002.)

**The one rule that makes this hold together:** `services/` (pipeline
stages) and `orchestrator/` never import an external library directly — they
only call functions exported from `adapters/`. If a stage needs to hit the
network or a database, that capability is injected in from an adapter, not
imported inline.

## 3. Architecture Diagram

```
[React SPA (Vite)] ──HTTPS/JSON──► [Express Route] ──► [generate.orchestrator.js]
                                                                  │
                    ┌───────────────┬──────────────────┬─────────┴──────────┬──────────────────┐
                    ▼               ▼                  ▼                    ▼                  ▼
          [github.adapter.js] [grouping.service] [prioritization.service] [gemini.adapter.js] [cache.repository.js]
          Octokit → commits    pure: cluster       pure: rank + fit        LangChain → Gemini    Mongoose → MongoDB
          + PRs + files        related commits     into token budget       forced JSON output    cache read/write
                                                                                    │
                                                            ┌───────────────────────┴───────────────────┐
                                                            ▼                                            ▼
                                                  [grounding.service]                            [render.service]
                                                  pure: verify claims                             pure: JSON → Markdown
                                                  against source data                              (mode-specific template)
```

### Pipeline Stages (in order)

```
extraction  →  grouping  →  prioritization  →  llm (JSON)  →  grounding  →  render (Markdown)
```

| Stage | Module | Layer | Responsibility |
|---|---|---|---|
| Extraction | `adapters/github.adapter.js` | Adapter | Fetch commits, associated PR titles/descriptions, changed filenames, and per-file diff summaries via Octokit |
| Grouping | `services/grouping.service.js` | Pipeline (pure) | Cluster related commits/PRs into logical units of work before they ever reach the model |
| Prioritization | `services/prioritization.service.js` | Pipeline (pure) | Rank groups by importance and fit them into the token budget — replaces naive truncation |
| LLM | `adapters/gemini.adapter.js` | Adapter | Call Gemini via LangChain, force structured JSON output matching the mode's schema |
| Grounding | `services/grounding.service.js` | Pipeline (pure) | Verify every claim in the JSON traces back to real commits/files; drop anything invented |
| Rendering | `services/render.service.js` | Pipeline (pure) | Deterministically convert verified JSON into the final markdown — the model never controls formatting |
| Caching | `adapters/cache.repository.js` | Adapter | Read/write `ChangelogCache` via Mongoose |
| Orchestration | `orchestrator/generate.orchestrator.js` | Application | Wires the above in sequence; contains no business logic of its own |

### Request Flow

1. **Request** — client sends `{ owner, repo, mode }` (`mode` is `"freelancer"`
   or `"company"`).
2. **Cache check** — `cache.repository.js` looks up a `ChangelogCache` entry
   matching `repoIdentifier` + `latestCommitSha` + `processingMode`. If found,
   the orchestrator returns the cached markdown immediately — no GitHub call,
   no LLM call.
3. **Extraction** — on a miss, `github.adapter.js` pulls:
   - the most recent commits (default 20),
   - the merged PRs those commits belong to (title + description),
   - the list of changed filenames per commit/PR,
   - a *selected* diff summary per file (status + additions/deletions +
     a short patch excerpt, not the full diff).
   Lockfiles and generated/build assets are filtered out at this stage.
4. **Grouping** — `grouping.service.js` clusters related commits/PRs into
   logical units (same PR, overlapping changed files, matching
   conventional-commit prefix like `feat`/`fix`/`chore`). Each group carries
   its combined message text, file list, and member SHAs.
5. **Prioritization** — `prioritization.service.js` ranks groups (PR-linked
   > multi-file feature-ish > lone chore/docs commit) and packs them into
   the token budget highest-priority first. Low-priority groups are dropped
   whole, not truncated mid-sentence.
6. **AI inference** — `gemini.adapter.js` injects the surviving groups into
   the mode-specific LangChain prompt (selected via the `modes/` strategy
   map), which requires the model to return **structured JSON** matching
   that mode's schema (§9). Output capped at 2,000 tokens.
7. **Grounding check** — `grounding.service.js` checks every item in the
   JSON against the source groups: referenced commit SHAs must exist in the
   input set, and claims must have real lexical/file overlap with their
   cited commits. Ungrounded items are dropped (logged, never shown to the
   end user).
8. **Rendering** — `render.service.js` deterministically renders the
   verified JSON into the mode's markdown template. The model never controls
   headings, emoji, or structure — only content.
9. **Cache + respond** — `cache.repository.js` writes the resulting markdown
   (plus the underlying JSON, kept for audit/debugging) to `ChangelogCache`,
   and the orchestrator returns it to the client.

Rate limiting is tracked per IP in `UserRateLimit` to keep this sustainable as
a free/cheap-tier tool.

## 4. Tech Stack

| Layer | Technology | Purpose | Notes |
|---|---|---|---|
| Frontend runtime | React 18 + Vite | Dashboard UI | Static single-bundle production build |
| Frontend styling | Tailwind CSS | Utility-first styling | Purges unused classes in prod |
| Markdown render | `react-markdown` | Render final markdown client-side | Sanitizes by default — no raw HTML/XSS |
| API server | Node.js + Express | REST API | Central async error-handling middleware |
| GitHub access | `@octokit/rest` | Commit/PR/file extraction | Uses a server-side PAT to avoid IP rate limits |
| Token counting | `js-tiktoken` | Budget measurement for prioritization | Runs on host CPU, no network call |
| JSON schema validation | `zod` | Validate/parse the LLM's structured output | Reject and retry once on schema-invalid responses |
| ORM | Mongoose | MongoDB schema layer | Strict types, required fields |
| LLM | Gemini 1.5 Flash (via LangChain) | Structured summarization | Forced JSON output, capped at 2,000 tokens |
| Local dev database | Docker Compose (`mongo:7`) | Run MongoDB without a host install | §6 — app processes still run on the host, only the DB is containerized |

## 5. Directory Structure

```
GitLogAiEngine/
├── docker-compose.yml          # local dev MongoDB (see §6)
├── docs/
│   ├── PROJECT.md              # this file
│   └── PHASES.md               # phased build plan
├── backend/
│   ├── config/
│   │   ├── env.js                    # ONLY file that reads process.env — exports named CONSTANTS
│   │   └── db.js                     # MongoDB connection, imports MONGODB_URI from env.js
│   ├── models/
│   │   ├── ChangelogCache.js
│   │   └── UserRateLimit.js
│   ├── errors/
│   │   └── AppError.js               # typed error hierarchy (§12)
│   ├── routes/
│   │   └── generate.js               # POST /api/generate — thin, delegates to orchestrator
│   ├── orchestrator/
│   │   └── generate.orchestrator.js  # wires adapters + pipeline stages in sequence
│   ├── adapters/                     # ONLY place external libs (Octokit/LangChain/Mongoose) are imported
│   │   ├── github.adapter.js         # commits, PRs, files, diff summaries
│   │   ├── gemini.adapter.js         # LangChain + Gemini call, JSON-mode
│   │   └── cache.repository.js       # ChangelogCache reads/writes
│   ├── services/                     # pure pipeline stages — no I/O, fixture-testable
│   │   ├── grouping.service.js
│   │   ├── prioritization.service.js
│   │   ├── grounding.service.js
│   │   └── render.service.js
│   ├── modes/                        # strategy pattern: one folder per processing mode
│   │   ├── freelancer/
│   │   │   ├── prompt.js
│   │   │   ├── schema.js             # zod schema
│   │   │   └── render.js             # JSON -> markdown template
│   │   ├── company/
│   │   │   ├── prompt.js
│   │   │   ├── schema.js
│   │   │   └── render.js
│   │   └── index.js                  # { freelancer, company } lookup map
│   ├── middleware/
│   │   ├── asyncHandler.js           # catches rejected promises, forwards to errorHandler
│   │   ├── rateLimiter.js            # per-IP monthly cap (§13)
│   │   └── errorHandler.js           # centralized Express error middleware (§12)
│   ├── scripts/
│   │   ├── verify-models.js          # DB model verification (Phase 1)
│   │   ├── verify-rate-limit.js      # atomicity + monthly-reset verification (Phase 3)
│   │   └── benchmark.js              # manual latency benchmark, cache-hit vs cache-miss (§14)
│   ├── server.js
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── src/
    │   ├── components/
    │   │   ├── Dashboard.jsx       # container: owns state + API calls
    │   │   ├── RenderMarkdown.jsx  # presentational: markdown output + download
    │   │   └── ErrorBoundary.jsx   # catches render-time crashes (§15)
    │   ├── api/
    │   │   └── client.js           # fetch wrapper, AbortController timeout (§15)
    │   ├── App.jsx
    │   └── main.jsx
    ├── index.html
    └── package.json
```

## 6. Local Development Environment

MongoDB runs in Docker via Compose — nobody installs or manages a local Mongo
process by hand. The backend and frontend Node processes still run directly
on the host (not containerized) for fast hot-reload during development;
containerizing the app itself is a deploy-time concern, not a dev-time one
(see §18 Out of Scope / Phase 17 in `PHASES.md`).

`docker-compose.yml` (repo root):
```yaml
services:
  mongo:
    image: mongo:7
    container_name: gitlog-mongo
    restart: unless-stopped
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

**Commands:**
```bash
docker compose up -d      # start MongoDB (first run pulls mongo:7)
docker compose ps         # confirm it's healthy
docker compose down       # stop it (data persists in the named volume)
docker compose down -v    # stop it AND wipe the volume (fresh DB)
```

`backend/.env`'s `MONGODB_URI=mongodb://localhost:27017/gitlog-ai-engine`
points at this container by default — no credentials needed for local dev
(no auth configured on the compose service). Anyone cloning the repo needs
only Docker Desktop (or another Compose-compatible engine) and Node — no
MongoDB install.

Why not containerize the backend/frontend too: bind-mounting source into a
container for hot-reload adds real complexity (volume perf on macOS,
node_modules platform mismatches) for very little payoff at this stage of
the project — running Node directly on the host is simpler and faster to
iterate on. `PHASES.md` Phase 14 covers building production Dockerfiles for
backend/frontend once there's an actual deploy target.

## 7. Database Schemas

### `ChangelogCache`

```js
import mongoose from 'mongoose';

const ChangelogCacheSchema = new mongoose.Schema({
  repoIdentifier: { type: String, required: true, index: true }, // e.g. "owner/repo"
  latestCommitSha: { type: String, required: true },
  processingMode: { type: String, required: true, enum: ['freelancer', 'company'] },
  generatedMarkdown: { type: String, required: true },
  generatedJson: { type: mongoose.Schema.Types.Mixed, required: true }, // structured LLM output, post-grounding
  droppedItems: { type: [String], default: [] }, // grounding-check audit trail (kept out of client response)
  createdAt: { type: Date, default: Date.now, expires: 2592000 }, // TTL: 30 days
}, { timestamps: true });

ChangelogCacheSchema.index(
  { repoIdentifier: 1, latestCommitSha: 1, processingMode: 1 },
  { unique: true }
);

export const ChangelogCache = mongoose.model('ChangelogCache', ChangelogCacheSchema);
```

### `UserRateLimit`

```js
import mongoose from 'mongoose';

const UserRateLimitSchema = new mongoose.Schema({
  userIpAddress: { type: String, required: true, unique: true }, // unique so concurrent upserts for a new IP can't create duplicate docs
  requestCountWithinMonth: { type: Number, default: 1 },
  lastRequestTimestamp: { type: Date, default: Date.now },
}, { timestamps: true });

export const UserRateLimit = mongoose.model('UserRateLimit', UserRateLimitSchema);
```

## 8. API Contract

### `POST /api/generate`

**Request body:**
```json
{ "owner": "vercel", "repo": "next.js", "mode": "company" }
```

**Response 200 (cache hit or fresh generation):**
```json
{
  "cached": true,
  "repoIdentifier": "vercel/next.js",
  "latestCommitSha": "a1b2c3d",
  "mode": "company",
  "markdown": "## 🌟 What's New\n..."
}
```

The client only ever receives rendered markdown — the structured JSON and
grounding audit trail stay server-side.

**Error responses:**
- `400` — invalid `owner`/`repo`/`mode`
- `404` — repo not found or no commits
- `422` — LLM output failed schema validation twice (schema-invalid after one retry)
- `429` — rate limit exceeded for this IP
- `502` — GitHub or Gemini upstream failure

### `GET /api/health`

Simple liveness check — returns `{ status: "ok" }`. Used for deploy smoke
tests.

## 9. Structured Output Schemas & Prompts

The model is never asked to write markdown. It's asked to fill a JSON shape;
each mode's `render.js` owns all formatting. This makes output deterministic,
diffable, and checkable — a model that hallucinates a feature produces a JSON
item that grounding can catch and drop, instead of an unstructured paragraph
that's hard to police.

Each mode is a self-contained folder under `modes/` (`prompt.js` +
`schema.js` + `render.js`), selected at runtime via `modes/index.js`. Adding
a new mode means adding a new folder and one registry entry — no other file
changes.

### Freelancer Mode (`modes/freelancer/`)

**JSON schema:**
```ts
{
  summary: string,                    // 2-3 sentence executive summary
  technicalChanges: [
    {
      category: "Backend" | "Frontend" | "Database" | "Architecture" | "Other",
      description: string,
      relatedFiles: string[],         // must be a subset of files seen in input
      relatedCommits: string[],       // must be a subset of SHAs seen in input
    }
  ],
  maintenance: [
    { description: string, relatedFiles: string[], relatedCommits: string[] }
  ]
}
```

**Prompt:**
```
You are a detail-oriented Senior Software Engineer. Review the provided
commit groups (each with combined messages, changed files, and PR context
where available) and produce a Daily Task Sheet / Standup Report.

Respond with ONLY valid JSON matching this shape:
{
  "summary": "...",
  "technicalChanges": [
    { "category": "Backend|Frontend|Database|Architecture|Other",
      "description": "...", "relatedFiles": ["..."], "relatedCommits": ["sha..."] }
  ],
  "maintenance": [
    { "description": "...", "relatedFiles": ["..."], "relatedCommits": ["sha..."] }
  ]
}

Rules:
- Every relatedCommits entry MUST be a SHA that appears in the input. Never invent one.
- Only describe changes that are directly evidenced by the input groups.
- Do not skip small technical implementation facts.
- No markdown, no prose outside the JSON object.
```

### Company Mode (`modes/company/`)

**JSON schema:**
```ts
{
  whatsNew: [
    { title: string, description: string, relatedCommits: string[] }
  ],
  improvements: [
    { title: string, description: string, relatedCommits: string[] }
  ],
  bugFixes: [
    { title: string, description: string, relatedCommits: string[] }
  ]
}
```

**Prompt:**
```
You are a Product Marketing Manager and Technical Writer. Review the provided
commit groups (each with combined messages, changed files, and PR title +
description where available) and produce a public-facing product changelog.

Respond with ONLY valid JSON matching this shape:
{
  "whatsNew": [ { "title": "...", "description": "...", "relatedCommits": ["sha..."] } ],
  "improvements": [ { "title": "...", "description": "...", "relatedCommits": ["sha..."] } ],
  "bugFixes": [ { "title": "...", "description": "...", "relatedCommits": ["sha..."] } ]
}

Rules:
- Every relatedCommits entry MUST be a SHA that appears in the input. Never invent one.
- Describe only what the input evidences — no speculative or aspirational features.
- Remove technical developer junk (merge flags, test commits, lockfile bumps) — these
  should already be filtered out of the input, but do not reintroduce that language.
- Write in clear, non-technical, user-value language.
- No markdown, no prose outside the JSON object.
```

## 10. Factual Grounding Checks

Purpose: catch invented features/fixes before they reach a client, without
paying for a second LLM call per request.

For every item in the model's JSON response:

1. **SHA existence check** — every `relatedCommits` entry must be a SHA that
   was actually part of the input group set. Any item referencing an unknown
   SHA is dropped immediately (strong signal of hallucination).
2. **Lexical grounding check** — the item's `description`/`title` must share
   meaningful keyword overlap (filenames, identifiers, conventional-commit
   type words) with the commit messages / changed files of its cited
   `relatedCommits`. Items below the overlap threshold are dropped.
3. **Volume sanity check** — the number of output items per section is capped
   relative to the number of input groups (e.g., no more than 1.5x groups),
   to catch the model splitting one change into many invented-sounding ones.

Dropped items are logged to `ChangelogCache.droppedItems` for debugging/audit
but never shown to the end user. If grounding drops *everything* in a
required section, the route returns `502` rather than rendering an empty,
misleading changelog.

## 11. Commit Grouping & Prioritization

**Grouping** (`services/grouping.service.js`) happens before any LLM call:
- Commits belonging to the same merged PR are always grouped together.
- Remaining commits are clustered by overlapping changed files/directories.
- Commits sharing a conventional-commit prefix (`feat:`, `fix:`, `chore:`)
  and touching adjacent paths are merged into one group.
- Each group aggregates: combined commit messages, PR title/description (if
  any), the union of changed filenames, and member SHAs.

**Prioritization** (`services/prioritization.service.js`) replaces naive
token truncation:
- Each group gets a priority score from: PR linkage (+), commit-type weight
  (`feat` > `fix` > `refactor` > `chore`/`docs`/`test`), number of files
  touched, and recency.
- Groups are packed into the `MAX_INPUT_TOKENS` budget highest-score first
  using `js-tiktoken` to measure running size.
- A group that doesn't fit is dropped whole — never cut mid-message. This
  keeps every group the model sees fully coherent, which is also what makes
  grounding checks reliable (partial context produces unreliable claims).

## 12. Error Handling & Graceful Failure

Design goal: no unhandled error should ever crash the process, and every
failure — expected or not — surfaces as a predictable, typed response. This
extends the hexagonal boundary rule (§2) to errors: a caller should never
have to know whether a failure came from Octokit, LangChain, or Mongoose.

**Typed error hierarchy** (`backend/errors/AppError.js`):
```
AppError (base, extends Error)     — { code, statusCode, message }
├── ValidationError                — 400, bad request shape
├── NotFoundError                  — 404, repo/commits not found
├── SchemaValidationError          — 422, LLM output failed schema twice
├── RateLimitError                 — 429, monthly cap exceeded
└── UpstreamError                  — 502, GitHub/Gemini failed or timed out
```
Adapters (`github.adapter.js`, `gemini.adapter.js`) catch whatever their
underlying library throws and rethrow one of these — nothing outside
`adapters/` ever sees a raw Octokit or LangChain error type.

**`middleware/asyncHandler.js`** — wraps every async route handler so a
rejected promise is forwarded to `next(err)` instead of becoming an
unhandled rejection. Without this, a thrown error inside an `async` Express
handler is silently swallowed (Express 4) or crashes the process (Express 5
in some cases) rather than reaching the error handler.

**`middleware/errorHandler.js`** — the single centralized Express
error-handling middleware (4-arg signature, registered last). Known
`AppError` subclasses map directly to their `statusCode` and a client-safe
`{ error: { code, message } }` body. Anything else (a genuine bug) is logged
server-side with full stack trace but returned to the client as a generic
`500` — stack traces and internals never leak into a response.

**Per-adapter timeouts** — `github.adapter.js` and `gemini.adapter.js` wrap
their external calls in a timeout (`Promise.race` against a
`setTimeout(ADAPTER_TIMEOUT_MS)`). Without this, a hung GitHub or Gemini call
holds the request (and the client's loading state) open indefinitely. A
timeout is rethrown as `UpstreamError`, same as any other upstream failure.

**Process-level safety nets** (outside Express entirely, in `server.js`):
```js
process.on('unhandledRejection', (err) => { /* log, then exit(1) */ });
process.on('uncaughtException', (err) => { /* log, then exit(1) */ });
```
These catch bugs that escape `asyncHandler` entirely — e.g. an error thrown
in a timer callback or a library's background task. Policy is fail fast:
log with full context and exit, rather than keep serving requests from a
process that might be in a corrupted state. Docker (`restart: unless-stopped`
in the eventual deploy compose file) brings it back up clean.

**Graceful shutdown** — on `SIGTERM`/`SIGINT` (sent by Docker on
stop/restart, or Ctrl+C locally): stop accepting new connections
(`server.close()`), let in-flight requests finish up to
`SHUTDOWN_TIMEOUT_MS`, then close the Mongoose connection, then exit. Without
this, a deploy or container restart can drop in-flight requests and leave
Mongo connections dangling.

## 13. Rate Limiting

Purpose: this is a free/cheap-tier public tool sitting in front of two paid
APIs (GitHub, Gemini) — without a cap, a handful of scripted requests could
exhaust quota or run up real cost.

**Strategy** — fixed monthly window per IP, tracked in `UserRateLimit` (§7:
`userIpAddress`, `requestCountWithinMonth`, `lastRequestTimestamp`).

**Reset logic** — on each request: if `lastRequestTimestamp`'s calendar
month differs from the current month, reset the counter to 1; otherwise
increment it. This must be a single atomic `findOneAndUpdate` with `$inc`
(and `upsert: true` for a first-ever request from an IP) — not a
read-then-write — otherwise two concurrent requests from the same IP can
both read `count = N` and both write `N + 1`, silently losing an increment
and under-counting real usage.

**Enforcement** — `middleware/rateLimiter.js` runs before the route handler,
delegates the atomic check/increment to `cache.repository.js` (keeping raw
Mongoose calls out of the middleware, consistent with the Repository
pattern), and throws `RateLimitError` once `requestCountWithinMonth` exceeds
`MAX_REQUESTS_PER_MONTH`.

**Response shape** — a `429` includes when the window resets (first of next
month) in the body, and sets the standard `Retry-After` header (RFC 9110) so
well-behaved clients — including this project's own frontend (§15) — know
when to stop retrying instead of hammering the endpoint.

**Trust proxy (deploy-time note)** — once this runs behind a reverse
proxy/load balancer, `req.ip` resolves to the proxy's address for every user
unless Express's `app.set('trust proxy', ...)` is configured correctly,
which would silently rate-limit all users as one IP. Flagged here so it
isn't forgotten when Phase 17 (deploy readiness) happens.

## 14. Benchmarking & Performance Instrumentation

Two distinct mechanisms, for two different questions:

**1. Per-stage timing instrumentation (always on)** — `generate.orchestrator.js`
records a timestamp before/after each pipeline stage and logs a structured
breakdown per request:
```json
{
  "requestId": "…", "cached": false,
  "stages": { "extraction": 420, "grouping": 8, "prioritization": 3,
              "llm": 1830, "grounding": 12, "render": 2 },
  "totalMs": 2275
}
```
This answers *"why is this request slow"* — the LLM call is expected to
dominate (seconds), while every pure pipeline stage should stay in
single-digit milliseconds. That gap is itself a useful sanity check: if a
"pure" service ever shows up slow, something's wrong (e.g. accidental I/O
leaking into a stage that's supposed to be a pure function per §2).

**2. Standalone benchmark script** (`backend/scripts/benchmark.js`, run
manually — not part of the app or CI) — hits `POST /api/generate`
repeatedly against a few real repos and reports p50/p95/p99 latency
separately for cache-miss and cache-hit paths. This is what actually proves
the cache (§7, §8) is doing its job: a hit should be milliseconds, a miss
should be several seconds dominated by the Gemini call. Re-run it after any
pipeline change (new grounding rule, bigger prompt, etc.) to catch
regressions — there's no fixed performance budget enforced automatically,
this is a manual dev tool, not a CI gate.

**Why not a load-testing tool (k6/autocannon) for v1** — the bottleneck here
is a single external LLM call's latency, not server throughput under
concurrency. A simple sequential script measuring wall-clock time across N
real requests answers the actual question ("how slow is this for one user")
more directly than a tool built to measure capacity under concurrent load,
which isn't this project's constraint at this stage.

## 15. Frontend Resilience

The "zero-willpower UI" guardrail (§16) covers expected states
(idle/loading/success/error). These five items cover what happens when
something goes *unexpectedly* wrong, or takes *too long*:

- **Error boundary** — a React `ErrorBoundary` component (in
  `frontend/src/components/ErrorBoundary.jsx`) wraps `<Dashboard />` in
  `App.jsx`, catching render-time JS exceptions (e.g. a markdown edge case
  crashing `react-markdown`) and showing a fallback message instead of a
  blank white screen. A crash is still a failure state the UI must handle
  gracefully, not just a network error.
- **Request timeout / abort** — `api/client.js` uses `AbortController` with
  a client-side timeout (longer than the expected worst-case Gemini latency,
  but not infinite) so a hung backend can't leave the UI stuck in `loading`
  forever. A timeout surfaces its own distinct "timed out, try again" state
  rather than the generic upstream-failure message.
- **Retry affordance** — the `error` state in `Dashboard.jsx` always renders
  a "Try again" action that re-submits the same request, instead of
  requiring a full page reload. Most useful for transient `502`s.
- **Rate-limit UX** — a `429` is shown distinctly from other errors, using
  the backend's reset-date info (§13) to tell the user specifically when
  they can try again, instead of a generic "something went wrong."
- **Perf-aware loading state** — since a cache-miss generation can take
  several seconds (per §14's real benchmark numbers), the loading state
  shows a "this can take up to ~X seconds" hint instead of a bare spinner
  with no context, so the user doesn't assume the app has frozen.

## 16. Implementation Guardrails

- **Zero-willpower UI** — every async action in the frontend has explicit
  loading / error / success states. No silent spinners with unclear outcomes.
- **Hexagonal boundary** — only `adapters/` imports Octokit, LangChain, or
  Mongoose. `services/` and `orchestrator/` depend on function signatures,
  never a concrete library (§2). This is what makes each stage
  fixture-testable in isolation.
- **Structured output only** — the LLM never free-writes markdown. It fills a
  validated JSON shape; formatting is deterministic code owned by each
  mode's `render.js` (§9).
- **Grounding before rendering** — nothing generated by the model reaches the
  client without passing the grounding check (§10).
- **Commit-aware budgeting** — token budget decisions are made at the group
  level by priority, not by blindly truncating raw text (§11).
- **Separation of state** — business logic (extraction, grouping,
  prioritization, prompting, grounding, rendering, caching) lives entirely in
  backend adapters/services/orchestrator. The frontend is a thin rendering +
  fetch layer; it holds no domain logic.
- **Secrets stay server-side** — GitHub PAT and Gemini API key are read from
  `backend/.env`, never exposed to the client bundle.
- **Centralized env access** — only `backend/config/env.js` reads
  `process.env` (and calls `dotenv.config()`). Every other file imports the
  specific named constant it needs (`PORT`, `MONGODB_URI`, `GITHUB_TOKEN`,
  etc. — all `SCREAMING_SNAKE_CASE`) from `env.js`, never `process.env`
  directly. One place to see every environment dependency the app has, and
  one place to add validation/defaults later.
- **Idempotent generation** — the same `(repo, sha, mode)` triple always
  returns the same cached markdown until the cache entry expires (30-day TTL).

## 17. Environment Variables (backend)

```
PORT=4000
MONGODB_URI=mongodb://localhost:27017/gitlog-ai-engine
GITHUB_TOKEN=ghp_xxx
GOOGLE_API_KEY=xxx
MAX_INPUT_TOKENS=6000
MAX_OUTPUT_TOKENS=2000
COMMIT_FETCH_LIMIT=20
GROUNDING_MIN_OVERLAP=0.2
MAX_REQUESTS_PER_MONTH=100
ADAPTER_TIMEOUT_MS=15000
SHUTDOWN_TIMEOUT_MS=10000
```

## 18. Out of Scope (v1)

- User accounts / auth (rate limiting is IP-based only for now)
- Private repo support (requires OAuth app, not just a PAT)
- Multi-repo batch processing
- Editing/regenerating a single section of the markdown output
- Second-pass LLM-based grounding verification (v1 grounding is heuristic/lexical only)

## 19. References

- Hohpe, G. & Woolf, B. — *Enterprise Integration Patterns* (2003). Source of
  the Pipes-and-Filters pattern used for the core pipeline.
- Cockburn, A. — ["Hexagonal Architecture"](https://alistair.cockburn.us/hexagonal-architecture/)
  (2005). Ports & Adapters, the basis for the `adapters/` boundary rule.
- Fowler, M. — *Patterns of Enterprise Application Architecture* (2002).
  Repository pattern, used for `cache.repository.js`.
- Gamma, Helm, Johnson, Vlissides — *Design Patterns* (1994). Strategy
  pattern, used for the `modes/` folder structure.
