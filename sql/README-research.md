# Research module SQL

Two files, both meant for the **Supabase SQL Editor** (Dashboard → SQL Editor →
New query → paste → Run). Full context is in `README-research.md` at the repo
root.

## `research_module.sql` — run this one

Creates everything the module needs:

- `CREATE EXTENSION IF NOT EXISTS vector` (pgvector, for the 768-dimension
  embeddings)
- ten `Research*` enum types, guarded with
  `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
- eight `Research*` tables (`CREATE TABLE IF NOT EXISTS`)
- indexes, including the **HNSW cosine index** on `ResearchIdea.embedding` that
  Prisma's schema cannot express
- foreign keys, each guarded the same way as the enums

It is idempotent — running it twice changes nothing the second time.

> **After any `prisma db push`, run this file again.** Push drops the HNSW index,
> because Prisma has no way to describe `USING hnsw (...) WITH (m = 16, ...)` and
> treats an index it does not know about as drift. Supabase never runs `db push`,
> so this only matters in local development. Nothing breaks without the index —
> cosine search returns the same rows, just by sequential scan.

## `research_cron_pgcron.sql` — only if the Vercel cron cannot run

`vercel.json` schedules `/api/research/cron/tick` every minute. **Vercel Hobby
plans do not allow minute-level crons** (one run per day), and Pro projects share
a cron quota across the whole project. This file schedules the same call from
Postgres instead, with `pg_cron` + `pg_net`.

Replace the two placeholders before running:

- `<APP_URL>` — e.g. `https://erp.velocityindia.net`, no trailing slash
- `<CRON_SECRET>` — the exact value of the `CRON_SECRET` env var in Vercel

Use **one** of the two schedules, never both: two ticks a minute doubles the
Gemini spend. (They are safe to overlap — a research job is claimed with
`FOR UPDATE SKIP LOCKED` and every post is written on its own — just wasteful.)

Useful afterwards:

```sql
SELECT jobid, jobname, schedule, active FROM cron.job;

SELECT id, status_code, left(content, 200) AS body, created
FROM net._http_response ORDER BY created DESC LIMIT 10;

SELECT cron.unschedule('research_tick');
```
