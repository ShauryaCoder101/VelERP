# Research module (phase 1 — backend)

An event-idea research pipeline living inside the ERP. It listens to public
sources (Reddit, industry RSS, staff clips, and live web search), uses Gemini to
pull out reusable **event / activation ideas** into a structured schema, embeds
and deduplicates them into Postgres + pgvector, and lets staff describe a need in
plain language to get matching ideas back.

This is a port of the standalone Python tool (`VelResearchTool`). The prompts,
gates, thresholds and schema are the same; what changed is the runtime — there is
no worker process, so the work is sliced into one-minute cron ticks.

Phase 1 is backend only: data model, Gemini client, sources, pipeline, search,
cron tick and JSON APIs. No UI yet.

---

## 1. What it researches

Four things, and nothing else:

- **activation** — a branded / experiential brand activation
- **marketing_activation** — a campaign mechanic run to pull an audience in
- **crowd_engagement** — games, contests, participatory mechanics, icebreakers at
  scale, interactive installations
- **event_technology** — AR/VR, projection, LED, holograms, drones, interactive
  screens, RFID, wearables, AI-driven interactive experiences
- **captivating_activity** — an activity or performance whose point is to capture
  and hold attention

Everything else is rejected at triage: venue news, catering logistics, HR and
careers, people profiles, vendor announcements, ticketing/CRM software, event
ROI, travel and MICE logistics, budgeting and contracts, sustainability policy,
and "top trends" listicles with no concrete mechanic. A post must describe at
least one concrete mechanic somebody could rebuild to count as an idea.

**Nothing is mandatory.** Every field on an idea is nullable. The extractor
leaves a field null rather than guessing and records a per-field confidence.
Search filters are null-tolerant: a filter excludes an idea only when the field
is set *and* contradicts the filter — an idea with the field unset still matches,
ranked slightly lower, and the response says which fields were unknown.

---

## 2. Setting it up

### 2.1 Database (Supabase SQL Editor)

Paste and run, in this order:

1. **`sql/research_module.sql`** — creates the `vector` extension, ten
   `Research*` enums, eight `Research*` tables, their indexes (including the HNSW
   cosine index on `ResearchIdea.embedding`) and foreign keys. Idempotent: every
   statement is guarded, so re-running is safe.
2. **`sql/research_cron_pgcron.sql`** — *optional*, only if you are not using the
   Vercel cron (see §2.3). Replace `<APP_URL>` and `<CRON_SECRET>` first.

> `prisma db push` **drops** the HNSW index, because Prisma cannot express
> `USING hnsw` and treats an unknown index as drift. Supabase never runs
> `db push`, so this only bites local development — re-run
> `sql/research_module.sql` afterwards. Without the index, search still returns
> exactly the same rows, just by sequential scan.

### 2.2 Environment variables (Vercel → Settings → Environment Variables)

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | yes | — | Without it, posts pile up as `new` and nothing is triaged or extracted. |
| `CRON_SECRET` | yes | — | Bearer token the tick demands. **Fails closed**: unset means the tick refuses everything. |
| `GEMINI_TRIAGE_MODEL` | no | `gemini-2.5-flash-lite` | Cheap first pass. |
| `GEMINI_EXTRACT_MODEL` | no | `gemini-3.8-flash` | Structured extraction. |
| `GEMINI_ANSWER_MODEL` | no | `gemini-3.8-flash` | Search brief, query expansion, grounded web search. |
| `GEMINI_EMBED_MODEL` | no | `gemini-embedding-001` | Embeddings. |
| `EMBED_DIM` | no | `768` | Must match `vector(768)` in the schema — changing it needs a migration. |
| `RESEARCH_TRIAGE_STRICT` | no | `false` | Strict mode also rejects when a fit gate is "unclear". |
| `RESEARCH_DEDUPE_THRESHOLD` | no | `0.92` | Cosine similarity at which two extractions are the same idea. |
| `RESEARCH_MIN_POST_SCORE` | no | `5` | Reddit score gate (API-mode posts only; feed posts carry no score). |
| `RESEARCH_MIN_POST_CHARS` | no | `200` | Minimum title+body+comments length. |
| `RESEARCH_MAX_WEB_QUERIES` | no | `3` | Hard budget: grounded searches per research job. |
| `RESEARCH_MAX_URLS` | no | `20` | Hard budget: pages fetched per research job. |
| `RESEARCH_MAX_REDDIT_QUERIES` | no | `2` | Hard budget: Reddit searches per research job. |
| `RESEARCH_TICK_BUDGET_MS` | no | `50000` | Wall clock for one tick (`maxDuration` is 60s). |
| `RESEARCH_TICK_PROCESS_MS` | no | `40000` | No new post is started past this point in a tick. |
| `RESEARCH_TICK_SOURCES` | no | `2` | Sources polled per tick. |
| `RESEARCH_TICK_POSTS` | no | `6` | Posts processed per tick. |
| `RESEARCH_TICK_COMMENT_POSTS` | no | `1` | Reddit comment feeds fetched per tick. |
| `RESEARCH_TICK_REDDIT_REQUESTS` | no | `1` | Reddit HTTP requests per tick. See §4. |
| `RESEARCH_REDDIT_BACKOFF_MINUTES` | no | `10` | How long Reddit sits out after a 429 / 403. |
| `RESEARCH_JOB_LOCK_MINUTES` | no | `3` | A research-job lock older than this is treated as stale. |
| `RESEARCH_JOB_CHUNK` | no | `5` | Posts a research job processes per tick. |

### 2.3 The cron

`vercel.json` schedules `GET /api/research/cron/tick` every minute:

```json
{ "crons": [{ "path": "/api/research/cron/tick", "schedule": "* * * * *" }] }
```

- **Vercel Hobby plans cannot do this** — they allow one cron run per day. Use
  `sql/research_cron_pgcron.sql` instead (pg_cron + pg_net call the same URL with
  the same bearer header, from Supabase, for free).
- Use **one** of the two, not both: two ticks a minute doubles the Gemini spend.
  They are safe to overlap (job locking and per-post writes see to that), just
  wasteful.
- **Merge note:** another branch adds `app/api/cron/reminders` with its own entry
  in `vercel.json`. When the branches meet, the `crons` array must list both.

### 2.4 Seeding the sources

```bash
node scripts/research-seed-sources.js          # add / refresh
node scripts/research-seed-sources.js --force-enable   # also restore enabled flags
```

Reads `sources/research-sources.json` (28 subreddits + 16 RSS feeds, carried over
from the Python `sources.yaml`; YouTube is not ported). Re-running is safe: rows
are matched on `(kind, identifier)` and an existing row keeps its `enabled` flag,
its `lastPolledAt` and any backoff.

---

## 3. How the tick works

There is no long-running process, so `GET /api/research/cron/tick` runs every
minute and does a bounded amount of everything in ~50 seconds:

1. **Poll** at most 2 due sources. RSS feeds are parsed into posts; a Reddit
   source reads one listing (hot, then top-of-week next time).
2. **Backfill** Reddit comments for at most one post sitting in
   `awaiting_comments`, then promote it to `new` for a second triage on the full
   thread. Posts still waiting after 96h go on without comments.
3. **Process** up to 6 `new` posts: heuristic filter → cheap triage → extraction →
   embedding → dedupe → upsert. Stops starting posts at 40s.
4. **Advance one step** of the oldest research job (see §5).

Each post is its own unit of work; a failure is recorded on that post
(`status = failed`, with the error) and never stops the tick. The response is a
JSON summary of everything the tick did — worth reading while you are watching a
fresh deployment.

### The gates, in order

| Gate | Cost | What it does |
| --- | --- | --- |
| `filter.shouldProcess` | free | Junk title prefixes, link-only bodies, length, Reddit score. Skips → `skipped`. |
| `triage.triagePost` | 1 cheap call | Is it an idea, what kind, could an agency run it, could it run in India, is the topic even ours. Rejects → `rejected`. |
| body-first domain gate | free | A Reddit feed post rejected on its body alone goes to `awaiting_comments` *only* when the model says its topic is in (or near) our domain. Off-topic subreddit chatter therefore costs Reddit nothing. |
| `gemini.extractIdeas` | 1 expensive call | 0..N ideas per post. Comments count as content. |
| `dedupe.findDuplicate` | 1 embedding | Cosine ≥ 0.92 against the library. A duplicate is merged: gaps filled, lists unioned, `sourceCount` / `popularityScore` / `lastSeenAt` bumped. Nothing already known is overwritten. |

Staff clips bypass triage (a person already decided) but nothing else.

---

## 4. Reddit from a datacentre — read this before blaming the code

Reddit's public Atom feeds (`/r/<sub>/hot/.rss`, `/r/<sub>/comments/<id>/.rss`,
`search.rss`) need no credentials, but they are rate-limited **per IP**, and
Vercel's egress IPs are shared with every other customer on that region. Expect
429s that have nothing to do with our traffic.

How the module copes:

- **One request per tick** (~1/minute) — measured, not guessed: two unauthenticated
  feed requests a few seconds apart already earn a 429 from a normal home IP.
- Polling, the comment backfill and a research job's Reddit search **take turns**
  by the minute for that single request.
- A 429 / 403 never sleeps. It stamps `backoffUntil` on every Reddit source (the
  throttle is per client, so it is a global stand-down) and later ticks skip
  Reddit until it passes.
- A subreddit reads **one listing per poll**, alternating hot and top-of-week, so
  no poll ever makes two requests back to back.

**First deploy: check `GET /api/research/diag`.** It reports whether the Gemini
key is configured, whether the `vector` extension is present, and the live status
code of one Reddit feed fetch and one RSS fetch **from the deployment itself**.
If Reddit answers 403/429 there but 200 from a laptop, the datacentre IP is
blocked — RSS, web research and clips keep working, and the options for Reddit
are a proxy, a Reddit API app (OAuth, not ported yet), or leaving the subreddits
disabled.

---

## 5. Research mode (going outside the library)

A search can also go looking outside. `POST /api/research/search` with
`"research": true` returns the library results immediately **and** queues a
`ResearchJob`; the caller polls `GET /api/research/jobs/<id>`.

The Python worker ran a job start to finish in one process over 5–10 minutes. Here
a job is a state machine that advances **one step per tick**:

```
expanding  -> one Gemini call plans 3 web queries + 2 Reddit queries
web search -> one grounded Google search per tick, collecting canonical URLs
web fetch  -> up to 6 pages fetched per tick, stored as kind="web" posts
reddit     -> one Reddit search per tick (skipped after 3 ticks of backoff)
processing -> 5 posts per tick through the normal pipeline
done
```

Exactly one tick may hold a job: it is claimed with `FOR UPDATE SKIP LOCKED` and
stamped `lockedAt`; a lock older than 3 minutes belonged to a tick that died
mid-step and can be taken over. Every step is wrapped on its own, so one dead URL
or a Reddit 429 costs that step and nothing else.

Nothing bypasses a gate: a fetched page is filtered, triaged, embedded and
deduplicated exactly like a subreddit post. Ideas are linked back to the job from
`ResearchIdeaSource`, not only from what the job itself extracted, so the panel
still shows results when the ordinary backlog got to the posts first — and
`ResearchJobIdea.created` separates "3 new" from "2 strengthened".

**Cost per job** ≈ 1 expansion call + up to 3 grounded searches (metered; 5,000
free/month on 3.x models) + one triage call per post + one extraction call per
surviving post. The budgets in §2.2 are hard caps.

---

## 6. API

All routes require a logged-in ERP user (any role, level 4) except the cron tick,
which requires the bearer secret. `getRequestUser` fails open, so every research
route additionally rejects an empty user id.

| Method | Path | What |
| --- | --- | --- |
| GET | `/api/research/cron/tick` | The heartbeat. Bearer `CRON_SECRET`. |
| GET | `/api/research/diag` | Key configured, vector extension, live Reddit + RSS probe, counts. |
| POST | `/api/research/search` | `{needText, filters, k, synthesize, research}` → ranked ideas, optional brief, optional `jobId`. |
| GET | `/api/research/jobs` | The research log. |
| GET | `/api/research/jobs/[id]` | Status, stage, stats, `new_ideas` / `strengthened_ideas`. |
| GET | `/api/research/ideas` | Browse: literal filters (`category`, `setting`, `interaction_mode`, `source_kind`, each accepting `(unknown)`), `q`, `sort` (`newest` / `most_seen` / `random`), `page`. |
| GET | `/api/research/ideas/[id]` | Detail plus the posts it came from. |
| PATCH | `/api/research/ideas/[id]` | Staff correction (edited fields get confidence 1.0 and the idea is re-embedded) or `{"status": "active" \| "rejected"}`. |
| POST | `/api/research/clip` | `{url, text, title, note}` → queued raw post. |
| GET / POST | `/api/research/sources` | List / add a source. |
| PATCH | `/api/research/sources/[id]` | Toggle `enabled`, retune the interval, `{"clearBackoff": true}`. |
| GET | `/api/research/admin` | Status counts, recent triage verdicts, failures, recent searches. |
| POST | `/api/research/admin` | `{"action": "retry-failed"}` or `{"action": "retriage"}`. |

---

## 7. Local development

```bash
docker compose up -d db          # or any local Postgres with pgvector
npx prisma db execute --file sql/research_module.sql --schema prisma/schema.prisma
npx prisma generate
node scripts/research-seed-sources.js
npm run dev

# drive the tick by hand
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/research/cron/tick
```

Every Gemini call costs real money, so a tick with a real key is not free —
roughly one cheap triage call per post plus one extraction call per surviving
post. Set `RESEARCH_TICK_POSTS=0` to poll and backfill without spending anything.
