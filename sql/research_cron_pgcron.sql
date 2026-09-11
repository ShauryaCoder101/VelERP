-- Minute-level cron for the research tick, run from Postgres instead of Vercel.
--
-- WHY: Vercel's Hobby plan only allows one cron a day, and Pro schedules are
-- minute-level but the whole project shares a cron quota. Supabase can call the
-- tick itself with pg_cron + pg_net, which costs nothing and is unaffected by
-- the Vercel plan. Use EITHER this OR the vercel.json cron - never both, or two
-- ticks will overlap every minute (they are safe to overlap, thanks to the job
-- lock and per-post transactions, but they will double the Gemini spend).
--
-- Run in the Supabase SQL Editor. Replace the two placeholders first:
--   <APP_URL>      e.g. https://erp.velocityindia.net   (no trailing slash)
--   <CRON_SECRET>  the exact value of the CRON_SECRET env var in Vercel

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Re-running this file replaces the schedule rather than adding a second one.
SELECT cron.unschedule('research_tick')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'research_tick');

SELECT cron.schedule(
  'research_tick',
  '* * * * *',
  $$
    SELECT net.http_get(
      url     := '<APP_URL>/api/research/cron/tick',
      headers := jsonb_build_object(
        'Authorization', 'Bearer <CRON_SECRET>',
        'Content-Type',  'application/json'
      ),
      timeout_milliseconds := 55000
    );
  $$
);

-- Check it is scheduled:
--   SELECT jobid, jobname, schedule, active FROM cron.job;
--
-- See what the last calls did (pg_net keeps a short history):
--   SELECT id, status_code, left(content, 200) AS body, created
--   FROM net._http_response ORDER BY created DESC LIMIT 10;
--
-- Turn it off again:
--   SELECT cron.unschedule('research_tick');
