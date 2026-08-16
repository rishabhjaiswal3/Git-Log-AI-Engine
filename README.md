# GitLog AI Engine

Turns Git commit/PR history into freelancer-facing task summaries or
company-facing changelogs, using a grouping → prioritization → structured-LLM
→ grounding → render pipeline. See [docs/PROJECT.md](docs/PROJECT.md) for the
full spec and [docs/PHASES.md](docs/PHASES.md) for the build plan.

## Prerequisites

- Node.js 20+
- Docker Desktop (or another Compose-compatible engine) — used to run
  MongoDB locally, no manual Mongo install needed
- A GitHub personal access token
- A Google AI (Gemini) API key

## Database (Docker Compose)

```bash
docker compose up -d    # starts MongoDB on localhost:27017
docker compose ps       # confirm it's healthy
docker compose down     # stop it (data persists in the named volume)
```

See [docs/PROJECT.md](docs/PROJECT.md) §6 for what's in `docker-compose.yml`
and why the backend/frontend aren't containerized too (yet).

## Backend

```bash
cd backend
cp .env.example .env   # fill in GITHUB_TOKEN, GOOGLE_API_KEY (MONGODB_URI already points at Compose)
npm install
npm run dev             # nodemon, http://localhost:4000
```

Health check: `curl http://localhost:4000/api/health`

## Frontend

```bash
cd frontend
npm install
npm run dev              # http://localhost:5173, proxies /api to :4000
```

## Project Layout

```
backend/    Express API — adapters/, services/, modes/, orchestrator/ (see PROJECT.md §2, §5)
frontend/   React (Vite) + Tailwind dashboard
docs/       Project spec and phased build plan
```
