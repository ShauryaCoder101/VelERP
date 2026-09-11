import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../../lib/db";
import {
  badRequest,
  forbidden,
  notFound,
  requireResearchUser
} from "../../../../../lib/research/guard";
import { LIST_FIELDS, SCALAR_FIELDS, cleanList, coerceField } from "../../../../../lib/research/pipeline/dedupe";
import { embeddingText } from "../../../../../lib/research/pipeline/embed";
import { embed } from "../../../../../lib/research/gemini";
import { writeEmbedding } from "../../../../../lib/research/pipeline/dedupe";
import { ideaToJson, postToJson } from "../../../../../lib/research/serialize";

/* Idea detail, curation and staff corrections.

   A correction is the one place a value does not come from the model, so an
   edited field is recorded at confidence 1.0 and the idea is re-embedded when
   the edit touched anything the embedding text is built from - otherwise the
   library would keep retrieving the old wording. */

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/* Columns a staff correction may set, keyed by the JSON name clients send. */
const EDITABLE = new Map<string, string>([
  ...SCALAR_FIELDS.map(([field, column]) => [String(field), column] as [string, string]),
  ...LIST_FIELDS.map(([field, column]) => [String(field), column] as [string, string])
]);
/* camelCase aliases, so a client can send either shape. */
for (const [, column] of [...EDITABLE]) EDITABLE.set(column, column);

/** Fields that change the canonical embedding text. */
const EMBEDDING_COLUMNS = new Set([
  "scopeCategory",
  "title",
  "summary",
  "howItWorks",
  "eventTypes",
  "formats",
  "interactionMode",
  "audienceMin",
  "audienceMax",
  "setting",
  "tags",
  "audienceTypes"
]);

const LIST_COLUMNS = new Set(LIST_FIELDS.map(([, column]) => column));

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const { id } = await context.params;
  const idea = await prisma.researchIdea.findUnique({ where: { id } });
  if (!idea) return notFound("Idea not found");

  const sources = await prisma.researchIdeaSource.findMany({
    where: { ideaId: id },
    select: {
      extractionIndex: true,
      post: {
        select: { id: true, kind: true, title: true, url: true, author: true, postedAt: true }
      }
    },
    orderBy: { createdAt: "asc" }
  });

  return Response.json({
    ...ideaToJson(idea),
    sources: sources.map((row) => ({ ...postToJson(row.post), extractionIndex: row.extractionIndex }))
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requireResearchUser(request);
  if (!user) return forbidden();

  const { id } = await context.params;
  const idea = await prisma.researchIdea.findUnique({ where: { id } });
  if (!idea) return notFound("Idea not found");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON");
  }

  const data: Record<string, unknown> = {};
  const confidence: Record<string, unknown> = { ...((idea.confidence as object) ?? {}) };
  let touchedEmbedding = false;

  /* Curation: active keeps an idea in the library, rejected drops it out of
     search without deleting the provenance. */
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "rejected") {
      return badRequest("status must be 'active' or 'rejected'");
    }
    data.status = body.status;
  }

  for (const [key, value] of Object.entries(body)) {
    if (key === "status") continue;
    if (key === "attributes") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const merged = { ...((idea.attributes as object) ?? {}), ...(value as object) };
        data.attributes = merged as Prisma.InputJsonValue;
        for (const attribute of Object.keys(value as object)) {
          confidence[`attributes.${attribute}`] = 1.0;
        }
      }
      continue;
    }
    const column = EDITABLE.get(key);
    if (!column) continue;

    const coerced = LIST_COLUMNS.has(column) ? cleanList(value) : coerceField(column, value);
    data[column] = coerced;
    if (coerced === null) delete confidence[column];
    else confidence[column] = 1.0;
    if (EMBEDDING_COLUMNS.has(column)) touchedEmbedding = true;
  }

  if (!Object.keys(data).length) return badRequest("No editable fields supplied");

  data.confidence = (Object.keys(confidence).length ? confidence : undefined) as Prisma.InputJsonValue;
  const updated = await prisma.researchIdea.update({ where: { id }, data });
  console.info(`[research] idea ${id} corrected by ${user.name || user.id}: ${Object.keys(data).join(", ")}`);

  /* Re-embed so retrieval matches the corrected wording. A failure here leaves
     the old vector in place, which is stale but harmless. */
  if (touchedEmbedding) {
    try {
      const text = embeddingText(updated as unknown as Record<string, unknown>);
      if (text.trim()) {
        const vectors = await embed([text], "RETRIEVAL_DOCUMENT");
        if (vectors[0]?.length) await writeEmbedding(id, vectors[0]);
      }
    } catch (error) {
      console.warn(`[research] could not re-embed idea ${id} after a correction`, error);
    }
  }

  return Response.json(ideaToJson(await prisma.researchIdea.findUniqueOrThrow({ where: { id } })));
}
