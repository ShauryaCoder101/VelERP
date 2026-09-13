import { runTick } from "../../../../../lib/research/tick";

/* The research module's heartbeat. Vercel calls this every minute (vercel.json);
   where a plan does not allow minute-level crons, pg_cron + pg_net calls the
   same URL with the same header (sql/research_cron_pgcron.sql).

   The route is publicly addressable, so it refuses anything without the shared
   secret - otherwise a stranger could make us spend Gemini calls and hammer
   Reddit from our IP. Fails closed when CRON_SECRET is unset.

   One tick is bounded work: see lib/research/tick.ts. */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const authorised = (request: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return request.headers.get("authorization") === `Bearer ${secret}`;
};

export async function GET(request: Request) {
  if (!authorised(request)) return new Response("Forbidden", { status: 403 });
  try {
    return Response.json(await runTick());
  } catch (error) {
    console.error("[research] tick failed", error);
    return Response.json(
      { error: `${error instanceof Error ? error.name : "Error"}: ${String(error)}` },
      { status: 500 }
    );
  }
}
