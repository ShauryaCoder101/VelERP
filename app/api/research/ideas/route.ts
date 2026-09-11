import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../lib/db";
import { forbidden, requireResearchUser } from "../../../../lib/research/guard";
import { ideaToJson } from "../../../../lib/research/serialize";

/* Browse: the whole accepted library, no search box required.

   Search is for when staff know what they want. Browse is for when they don't:
   every active idea, paged, with LITERAL (not null-tolerant) filters - if
   someone picks "outdoor" they mean outdoor - plus an explicit "(unknown)"
   choice per dropdown for the ideas where the field was never recorded. */

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;
export const UNKNOWN = "(unknown)";
const UNKNOWN_ALIASES = new Set(["(unknown)", "__unknown__", "unknown"]);
const SORTS = ["newest", "most_seen", "random"];

const clean = (value: string | null) => {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
};
const isUnknown = (value: string | null) => !!value && UNKNOWN_ALIASES.has(value.toLowerCase());

export async function GET(request: Request) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const params = new URL(request.url).searchParams;
  const category = clean(params.get("category"));
  const setting = clean(params.get("setting"));
  const interactionMode = clean(params.get("interaction_mode"));
  const sourceKind = clean(params.get("source_kind"));
  const q = clean(params.get("q"));
  const seed = clean(params.get("seed")) ?? "0";
  let sort = (clean(params.get("sort")) ?? "newest").toLowerCase();
  if (!SORTS.includes(sort)) sort = "newest";
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const pageSize = Math.min(Math.max(Number(params.get("page_size") ?? PAGE_SIZE) || PAGE_SIZE, 1), 100);

  const where: Prisma.ResearchIdeaWhereInput = { status: "active" };
  if (category) {
    where.scopeCategory = isUnknown(category) ? null : (category as never);
  }
  if (setting) where.setting = isUnknown(setting) ? null : (setting as never);
  if (interactionMode) {
    where.interactionMode = isUnknown(interactionMode) ? null : (interactionMode as never);
  }
  if (sourceKind) {
    where.sources = isUnknown(sourceKind)
      ? { none: {} }
      : { some: { post: { kind: sourceKind as never } } };
  }
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { summary: { contains: q, mode: "insensitive" } },
      { tags: { hasSome: [q, q.toLowerCase()] } }
    ];
  }

  const total = await prisma.researchIdea.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  const skip = (current - 1) * pageSize;

  let ideas;
  if (sort === "random") {
    /* Stable across pages for one shuffle: the same seed gives the same order.
       The candidate ids come from the same Prisma filter as every other sort
       (rather than a second, hand-written copy of the WHERE clause) and are
       handed to Postgres as one separator-joined parameter. */
    const candidates = await prisma.researchIdea.findMany({ where, select: { id: true } });
    const rows = candidates.length
      ? await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "ResearchIdea"
           WHERE "id" = ANY(string_to_array($1, chr(31)))
           ORDER BY md5("id" || $2), "id" OFFSET $3 LIMIT $4`,
          candidates.map((row) => row.id).join(""),
          seed,
          skip,
          pageSize
        )
      : [];
    const found = await prisma.researchIdea.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const order = new Map(rows.map((row, index) => [row.id, index]));
    ideas = found.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  } else {
    const orderBy: Prisma.ResearchIdeaOrderByWithRelationInput[] =
      sort === "most_seen"
        ? [{ sourceCount: "desc" }, { popularityScore: "desc" }, { createdAt: "desc" }, { id: "asc" }]
        : [{ firstSeenAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }];
    ideas = await prisma.researchIdea.findMany({ where, orderBy, skip, take: pageSize });
  }

  /* One representative source per idea, so a list row can link out. */
  const links = ideas.length
    ? await prisma.researchIdeaSource.findMany({
        where: { ideaId: { in: ideas.map((idea) => idea.id) } },
        select: {
          ideaId: true,
          post: { select: { id: true, kind: true, url: true, title: true, postedAt: true } }
        },
        orderBy: { createdAt: "asc" }
      })
    : [];
  const firstSource = new Map<string, (typeof links)[number]["post"]>();
  for (const row of links) if (!firstSource.has(row.ideaId)) firstSource.set(row.ideaId, row.post);

  return Response.json({
    total,
    page: current,
    pages,
    pageSize,
    sort,
    seed: sort === "random" ? seed : null,
    items: ideas.map((idea) => ({
      ...ideaToJson(idea),
      source: firstSource.get(idea.id)
        ? {
            postId: firstSource.get(idea.id)!.id,
            kind: firstSource.get(idea.id)!.kind,
            url: firstSource.get(idea.id)!.url,
            title: firstSource.get(idea.id)!.title
          }
        : null
    })),
    facets: await facets(where)
  });
}

/** Distinct values for each dropdown, with counts under the current filters.
    (The Python browse computed each facet with its own filter left out; this
    keeps the simpler "counts under everything currently applied" shape, which is
    what a first UI needs.) */
async function facets(where: Prisma.ResearchIdeaWhereInput) {
  const [category, setting, interaction] = await Promise.all([
    prisma.researchIdea.groupBy({ by: ["scopeCategory"], where, _count: { _all: true } }),
    prisma.researchIdea.groupBy({ by: ["setting"], where, _count: { _all: true } }),
    prisma.researchIdea.groupBy({ by: ["interactionMode"], where, _count: { _all: true } })
  ]);
  const shape = (rows: Array<Record<string, unknown>>, key: string) =>
    rows.map((row) => ({
      value: row[key] ?? UNKNOWN,
      count: (row._count as { _all: number })._all
    }));
  return {
    category: shape(category as never, "scopeCategory"),
    setting: shape(setting as never, "setting"),
    interaction_mode: shape(interaction as never, "interactionMode")
  };
}
