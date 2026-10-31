# Airport Investment Intelligence Agent

An AI agent that helps analysts screen US airports for **terminal expansion opportunities**, using public flight and passenger data on demand, capacity and congestion. You chat with it (by text or voice). It answers from **deterministic tools over public BTS and FAA data**, explains its reasoning, and states its assumptions and limitations.

> The LLM never computes a number. Scores, rankings and metrics are calculated in code; the LLM chooses which tools to call and explains their results.

## Deliverables

| Deliverable | Where |
|---|---|
| **Source code** | This repository: [`apps/server`](apps/server) (API, agent, data pipeline) and [`apps/web`](apps/web) (chat UI) |
| **Design / architecture document** | **[docs/DESIGN.md](docs/DESIGN.md)** |
| ↳ Scoring methodology | [DESIGN.md §2](docs/DESIGN.md#2-scoring-methodology) (full detail: [docs/scoring.md](docs/scoring.md)) |
| ↳ Key tradeoffs | [DESIGN.md §3](docs/DESIGN.md#3-key-tradeoffs) |
| ↳ Where / how AI is used | [DESIGN.md §4](docs/DESIGN.md#4-where-and-how-ai-is-used) |

How the assignment's requirements are covered:

| Requirement | How |
|---|---|
| Use public APIs to gather aviation data | BTS T-100 (Socrata REST API), BTS On-Time Performance, OurAirports, FAA NAS Status (live). See [Data sources](#data-sources) |
| Rank or compare airports with defined logic or a KPI | Terminal Expansion Opportunity Screening Score; `rank_airports` and `compare_airports` tools |
| Deterministic scoring (not only LLM output) | Pure, unit-tested scoring function; the LLM only explains it |
| Explain reasoning clearly | Answers show the score components and percentiles; the UI shows each tool step live |
| Conversational follow-ups | Server-side history; *"What about California?"* works after a ranking |
| Chat interface (voice is a bonus) | React chat UI with voice input and read-aloud |
| Communicate assumptions, uncertainty, scope | Every tool result carries its period, sources and caveats; scores report coverage; an off-topic guardrail |

---

## Quick start

```bash
npm install
cp apps/server/.env.example apps/server/.env   # then set OPENAI_API_KEY in apps/server/.env
npm run setup                                  # Postgres in Docker + migrations + data snapshot (~10 s)
npm run dev                                    # open http://localhost:5173
```

Try the four questions from the assignment (they're also buttons on the start screen):

- *Which airports in New England are strong candidates for terminal expansion?*
- *Compare LA and Santa Ana airport congestion levels.*
- *What is the percentage of long haul flights out of Anchorage airport?*
- *What is the unmet flight demand in SFO airport and why?*

Then try a follow-up (*"What about California?"*), a live question (*"Are there any delays in NYC right now?"*), and an off-topic one (*"Write me a cake recipe"*) to see the guardrail.

---

## Technologies

| Layer | Technology |
|---|---|
| Language | **TypeScript** (strict), Node.js 24 |
| API server | **Fastify 5**, with server-sent events (SSE) streaming |
| Database | **PostgreSQL 16** (Docker), **Drizzle ORM** + drizzle-kit migrations |
| LLM | **OpenAI Responses API** with function tools: `gpt-4o` (agent), `gpt-4o-mini` (guardrail classifier) |
| Validation | **zod 4** (tool arguments → JSON Schema for OpenAI, env config, request bodies) |
| Data ingestion | Node `fetch`, **csv-parse** (streaming), **adm-zip** |
| Frontend | **React 19** + **Vite 8**, react-markdown + remark-gfm |
| Voice | Browser **Web Speech API** (speech-to-text) and speechSynthesis (read aloud) |
| Testing | **Vitest** (LLM and external APIs mocked) |

No LangChain, queues or extra services.

---

## Running the project

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 22+** and npm | Developed on Node 24 (Vite 8 needs a recent Node) |
| **Docker Desktop** | Runs Postgres. On Windows it needs WSL 2 and virtualization enabled |
| **OpenAI API key** | A personal key is fine; costs are minimal |

### Configuration (`apps/server/.env`)

Copy `apps/server/.env.example`. Only `OPENAI_API_KEY` is required.

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | (required) | OpenAI access |
| `DATABASE_URL` | `postgres://airport:airport@localhost:5432/airport` | Matches `docker-compose.yml` |
| `OPENAI_MODEL` / `GUARDRAIL_MODEL` | `gpt-4o` / `gpt-4o-mini` | Agent / scope-classifier models |
| `GUARDRAIL_TIMEOUT_MS` | `8000` | Classifier timeout. If it is exceeded, the request is refused, never approved |
| `AGENT_MAX_TOOL_CALLS` / `AGENT_MAX_LLM_ITERATIONS` | `10` / `8` | Per-message safeguards |
| `AGENT_LLM_TIMEOUT_MS` / `AGENT_TOOL_TIMEOUT_MS` | `60000` / `20000` | Per-call timeouts |
| `PORT` | `3001` | API port (the web app forwards `/api` to it) |

### Data pipeline (batch, offline)

**A. Load the committed snapshot (recommended: about 3 seconds, no downloads)**

```bash
npm run setup        # = db:up (wait for healthy) + db:migrate + db:seed
```

**B. Rebuild everything from the public sources (about 20 minutes the first time, about 400 MB of downloads)**

```bash
npm run db:up && npm run db:migrate
npm run ingest                 # all steps below, in order
npm run ingest -- t100         # or one step: airports | t100 | ontime | score | snapshot
```

| Step | What it does | Time |
|---|---|---|
| `airports` | OurAirports → US airports with IATA code, state, Census region | ~2 s |
| `t100` | BTS Socrata API → 24 months of traffic per airport, plus the stable BTS airport IDs | ~6 s |
| `ontime` | 12 monthly On-Time zip files (~600k flights each) → per-airport monthly totals | ~17 min first run, ~4 min cached |
| `score` | Computes the screening score | <1 s |
| `snapshot` | Writes the processed tables to `data/seed/` | <1 s |

The analysis window moves forward automatically with the latest month BTS has published (currently Aug 2025 – Jul 2026). Raw downloads are cached in `data/raw/` (git-ignored), and every step can safely be re-run.

### Query pipeline (the running app)

```bash
npm run dev          # API on :3001 (auto-reload) + web on http://localhost:5173
npm start            # production-like: builds both, then serves them
npm run ask -- "Compare LA and Santa Ana airport congestion levels." "What about SFO?"   # CLI conversation
```

API: `POST /chat` with `{ "message": "...", "conversationId"?: "..." }` returns a server-sent event stream of `conversation`, `guardrail`, `tool_call`, `tool_result`, `answer`, `done`.

```bash
curl -N -X POST http://localhost:3001/chat -H "Content-Type: application/json" -d '{"message":"Rank airports in Texas"}'
```

---

## Agent tools

| Tool | Purpose | Example question |
|---|---|---|
| `rank_airports` | Rank by the screening score or one component, optionally within a region (Census division or region, state, or informal area like "north" or "east coast") | "Which airports in New England are strong candidates for terminal expansion?" |
| `compare_airports` | Side by side (2–6 airports): traffic, congestion metrics with percentile benchmarks, scores | "Compare LA and Santa Ana airport congestion levels." |
| `get_airport_profile` | One airport: traffic, growth, load factor, operations, peak hour, score breakdown | "Tell me about Nashville" |
| `get_long_haul_share` | Share of departures above a distance threshold (default 2,500 mi), with the distance distribution | "Percentage of long-haul flights out of Anchorage?" |
| `get_unmet_demand_signals` | Rule-based indirect signals of unmet demand, each benchmarked against peers | "What is the unmet flight demand in SFO and why?" |
| `resolve_airport` | Name, city, nickname or code → IATA code | "Santa Ana" → SNA |
| `get_live_airport_status` | Live FAA status for a code, city or metro ("LA" checks LAX, BUR, LGB, ONT, SNA) | "Are there any delays in LA?" |
| `get_live_delays_nationwide` | Every US airport with an active FAA delay program, most severe first | "Which airport has the most delays right now?" |
| `get_methodology` | Weights, method, limitations, data sources and dates | "How is the score calculated?" |

---

## Tests and evaluation

```bash
npm test                     # 170 unit and route tests, no network or API key needed
npm run typecheck            # both apps
npm run eval:guardrail       # real classifier on 52 labeled cases; reports false positives and negatives
cd apps/server && npx tsx scripts/smoke-tools.ts   # every tool against the real DB + live FAA
```

Latest guardrail evaluation: **0 false positives, 0 false negatives** across 52 cases (in scope, follow-ups, off-topic, adversarial, mixed). See [DESIGN.md §4](docs/DESIGN.md#4-where-and-how-ai-is-used).

---

## Data sources

All sources are public and free. They are loaded into Postgres by the batch pipeline; only FAA NAS Status is called live.

| Source | Provider | Access | What we use |
|---|---|---|---|
| **T-100 Segment Summary by Origin Airport** | Bureau of Transportation Statistics | Socrata REST API: `https://data.bts.gov/resource/r495-tyji.json` | Passengers, seats, departures, freight, international traffic, average distance, BTS airport ID (monthly) |
| **Reporting Carrier On-Time Performance** | BTS (TranStats) | Monthly zip files: `https://transtats.bts.gov/PREZIP/` | Delays, cancellations, taxi times, NAS delay, scheduled hour, distance group (domestic flights, large carriers) |
| **OurAirports** | OurAirports (open data) | CSV: `https://davidmegginson.github.io/ourairports-data/airports.csv` | Names, codes, city, state, coordinates |
| **FAA NAS Status** *(live)* | Federal Aviation Administration | JSON: `https://nasstatus.faa.gov/api/airport-events` | Ground stops, ground delay programs, arrival/departure delays, closures |

Assumptions and limitations of the data: [DESIGN.md §5](docs/DESIGN.md#5-assumptions-and-limitations).

---

## Project structure

```
├── apps/
│   ├── server/                      Fastify API, agent, data pipeline
│   │   ├── src/
│   │   │   ├── index.ts             startup: wires OpenAI clients, tools, guardrail
│   │   │   ├── app.ts               HTTP routes: /health, POST /chat (SSE)
│   │   │   ├── agent/               agent loop, guardrail, tools + schemas, prompt, OpenAI adapter
│   │   │   ├── services/            scoring, analytics, airport/region resolution, live FAA status
│   │   │   ├── repositories/        Drizzle queries
│   │   │   ├── db/                  schema + client
│   │   │   ├── chat/                in-memory conversation store
│   │   │   └── ingest/              data pipeline steps
│   │   ├── drizzle/                 SQL migrations
│   │   └── scripts/                 ask (CLI chat), eval-guardrail, smoke-tools
│   └── web/                         React + Vite chat UI
├── data/seed/                       processed data snapshot (committed)
├── docs/
│   ├── DESIGN.md                    design / architecture document (deliverable)
│   └── scoring.md                   scoring methodology in full detail
└── docker-compose.yml               PostgreSQL 16
```
