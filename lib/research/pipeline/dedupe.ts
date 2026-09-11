/* Near-duplicate detection and merging of extractions into existing ideas.

   Different posts describe the same activation in different words, so the
   library is deduplicated in embedding space rather than by title. A merge is
   additive: it only ever fills gaps on the surviving idea, never overwrites a
   value that is already there - the first source to state a fact wins, which
   keeps a later, vaguer post from degrading a good record. */

import type { Prisma, ResearchIdea } from "@prisma/client";
import { prisma } from "../../db";
import { pipelineConfig } from "../config";
import {
  BUDGET_BANDS,
  INTERACTION_MODES,
  PHYSICAL_INTENSITIES,
  SCOPE_CATEGORIES,
  SETTINGS,
  type IdeaExtraction
} from "../schema";
import { vectorLiteral } from "./embed";

/** Scalar extraction fields, mapped onto their ResearchIdea column. */
export const SCALAR_FIELDS: Array<[keyof IdeaExtraction, string]> = [
  ["scope_category", "scopeCategory"],
  ["title", "title"],
  ["summary", "summary"],
  ["how_it_works", "howItWorks"],
  ["interaction_mode", "interactionMode"],
  ["audience_min", "audienceMin"],
  ["audience_max", "audienceMax"],
  ["minutes_per_participant", "minutesPerParticipant"],
  ["total_duration_minutes", "totalDurationMinutes"],
  ["setting", "setting"],
  ["space_requirements", "spaceRequirements"],
  ["tech_requirements", "techRequirements"],
  ["staffing", "staffing"],
  ["staff_count", "staffCount"],
  ["setup_time_minutes", "setupTimeMinutes"],
  ["materials", "materials"],
  ["budget_band", "budgetBand"],
  ["budget_notes", "budgetNotes"],
  ["age_group", "ageGroup"],
  ["brandable", "brandable"],
  ["physical_intensity", "physicalIntensity"],
  ["region", "region"],
  ["occasion", "occasion"]
];

/** Extraction fields that are text arrays and get unioned rather than replaced. */
export const LIST_FIELDS: Array<[keyof IdeaExtraction, string]> = [
  ["event_types", "eventTypes"],
  ["formats", "formats"],
  ["audience_types", "audienceTypes"],
  ["tags", "tags"]
];

const INT_FIELDS = new Set(["audienceMin", "audienceMax", "staffCount"]);
const DECIMAL_FIELDS = new Set([
  "minutesPerParticipant",
  "totalDurationMinutes",
  "setupTimeMinutes"
]);
const ENUM_FIELDS: Record<string, readonly string[]> = {
  scopeCategory: SCOPE_CATEGORIES,
  interactionMode: INTERACTION_MODES,
  setting: SETTINGS,
  budgetBand: BUDGET_BANDS,
  physicalIntensity: PHYSICAL_INTENSITIES
};

/** Tags are free-form, so a merged idea could otherwise accumulate hundreds. */
export const MAX_TAGS = 25;

/* ------------------------------------------------------------------------- */
/* Coercion                                                                   */
/* ------------------------------------------------------------------------- */

const coerceInt = (value: unknown): number | null => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? Math.round(asNumber) : null;
};

const coerceDecimal = (value: unknown): number | null => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : null;
};

/** Convert an extraction value to what the column expects.

    Anything unconvertible - including an enum label the model invented - becomes
    null rather than throwing, so one nonsense value cannot fail a whole post. */
export function coerceField(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (INT_FIELDS.has(column)) return coerceInt(value);
  if (DECIMAL_FIELDS.has(column)) return coerceDecimal(value);
  if (ENUM_FIELDS[column]) {
    const text = String(value).trim();
    return ENUM_FIELDS[column].includes(text) ? text : null;
  }
  if (typeof value === "string") return value.trim() || null;
  return value;
}

/** Normalise a text-array field: strip, drop blanks, dedupe case-insensitively. */
export function cleanList(values: unknown, limit?: number): string[] | null {
  if (!values) return null;
  const list = typeof values === "string" ? [values] : Array.isArray(values) ? values : [];
  const seen = new Map<string, string>();
  for (const raw of list) {
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (!seen.has(key)) seen.set(key, text);
  }
  let out = [...seen.values()];
  if (limit !== undefined) out = out.slice(0, limit);
  return out.length ? out : null;
}

/** Existing values keep their position and casing; new ones append. */
const unionLists = (existing: unknown, incoming: unknown, limit?: number) =>
  cleanList([...((existing as string[]) ?? []), ...((incoming as string[]) ?? [])], limit);

export type SeenPost = {
  postedAt: Date | null;
  engagement: unknown;
};

/** When this post says the idea was seen: its post date, else now. */
export const seenAtFor = (post: SeenPost): Date => post.postedAt ?? new Date();

/** How much one more sighting of an idea is worth.

    log1p of the engagement signal keeps a viral post from swamping the ranking,
    and the +1 means every corroborating source counts for something even with no
    engagement data at all. */
export function popularityDelta(post: SeenPost): number {
  const blob =
    post.engagement && typeof post.engagement === "object" && !Array.isArray(post.engagement)
      ? (post.engagement as Record<string, unknown>)
      : {};
  let signal = 0;
  for (const key of ["score", "views", "likes"]) {
    const value = blob[key];
    if (value === null || value === undefined || typeof value === "boolean") continue;
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) continue;
    signal = Math.max(0, asNumber);
    break;
  }
  return Number((Math.log1p(signal) + 1).toFixed(6));
}

/* ------------------------------------------------------------------------- */
/* Duplicate lookup                                                           */
/* ------------------------------------------------------------------------- */

export type DuplicateMatch = { id: string; similarity: number };

/** Nearest active idea to a vector, if it is similar enough to be the same idea.

    pgvector's `<=>` is cosine distance, so similarity is 1 - distance. Returns
    null when nothing clears DEDUPE_THRESHOLD. */
export async function findDuplicate(vector: number[]): Promise<DuplicateMatch | null> {
  if (!vector.length) return null;
  const literal = vectorLiteral(vector);
  const rows = await prisma.$queryRaw<Array<{ id: string; distance: number }>>`
    SELECT "id", "embedding" <=> ${literal}::vector AS distance
    FROM "ResearchIdea"
    WHERE "status" = 'active' AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${literal}::vector
    LIMIT 1
  `;
  if (!rows.length || rows[0].distance === null) return null;
  const similarity = 1 - Number(rows[0].distance);
  if (similarity < pipelineConfig().dedupeThreshold) return null;
  return { id: rows[0].id, similarity };
}

/* ------------------------------------------------------------------------- */
/* Create / merge payloads                                                    */
/* ------------------------------------------------------------------------- */

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

const FIELD_TO_COLUMN = new Map<string, string>(
  [...SCALAR_FIELDS, ...LIST_FIELDS].map(([field, column]) => [String(field), column])
);

/** Re-key the model's per-field confidence onto the column names.

    The extraction schema is snake_case (it is the Python schema, verbatim) but
    the columns - and therefore everything the API returns, including a staff
    correction's 1.0 - are camelCase. Without this an idea would carry
    `how_it_works: 0.9` next to `budgetNotes: 1.0` and no consumer could look a
    confidence up by field name. Keys that are not fields (`attributes.foo`) are
    left alone. */
export function normaliseConfidence(
  confidence: Record<string, unknown> | null | undefined
): Record<string, number> | null {
  if (!confidence) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(confidence)) {
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) continue;
    out[FIELD_TO_COLUMN.get(key) ?? key] = asNumber;
  }
  return Object.keys(out).length ? out : null;
}

/** Build the create payload for a fresh idea (embedding is written separately). */
export function buildIdeaCreate(
  extraction: IdeaExtraction,
  post: SeenPost
): Prisma.ResearchIdeaUncheckedCreateInput {
  const data: Record<string, unknown> = { status: "active" };

  for (const [field, column] of SCALAR_FIELDS) {
    const value = coerceField(column, extraction[field]);
    if (value !== null) data[column] = value;
  }
  for (const [field, column] of LIST_FIELDS) {
    const value = cleanList(extraction[field], column === "tags" ? MAX_TAGS : undefined);
    if (value) data[column] = value;
  }

  /* The model occasionally inverts the bounds; swap rather than fail the post. */
  const min = data.audienceMin as number | undefined;
  const max = data.audienceMax as number | undefined;
  if (min !== undefined && max !== undefined && min > max) {
    data.audienceMin = max;
    data.audienceMax = min;
  }

  if (extraction.attributes && Object.keys(extraction.attributes).length) {
    data.attributes = extraction.attributes;
  }
  const confidence = normaliseConfidence(extraction.confidence);
  if (confidence) data.confidence = confidence;

  const seenAt = seenAtFor(post);
  data.firstSeenAt = seenAt;
  data.lastSeenAt = seenAt;
  data.sourceCount = 1;
  data.popularityScore = popularityDelta(post);
  return data as Prisma.ResearchIdeaUncheckedCreateInput;
}

/** Fold a fresh extraction into an idea already in the library.

    Gaps get filled, list fields get unioned, and the bookkeeping counters move.
    Nothing already known is overwritten. */
export function buildMergeUpdate(
  existing: ResearchIdea,
  extraction: IdeaExtraction,
  post: SeenPost
): Prisma.ResearchIdeaUncheckedUpdateInput {
  const data: Record<string, unknown> = {};
  const row = existing as unknown as Record<string, unknown>;

  for (const [field, column] of SCALAR_FIELDS) {
    if (row[column] !== null && row[column] !== undefined) continue;
    const value = coerceField(column, extraction[field]);
    if (value !== null) data[column] = value;
  }

  for (const [field, column] of LIST_FIELDS) {
    const merged = unionLists(row[column], extraction[field], column === "tags" ? MAX_TAGS : undefined);
    if (merged) data[column] = merged;
  }

  if (extraction.attributes && Object.keys(extraction.attributes).length) {
    data.attributes = { ...extraction.attributes, ...asObject(existing.attributes) };
  }

  const incomingConfidence = normaliseConfidence(extraction.confidence);
  if (incomingConfidence) {
    const confidence = asObject(existing.confidence);
    for (const [key, incoming] of Object.entries(incomingConfidence)) {
      const current = Number(confidence[key]);
      confidence[key] = Number.isFinite(current) ? Math.max(current, incoming) : incoming;
    }
    data.confidence = confidence;
  }

  data.sourceCount = (existing.sourceCount ?? 0) + 1;
  data.popularityScore = Number(existing.popularityScore ?? 0) + popularityDelta(post);

  const seenAt = seenAtFor(post);
  if (!existing.lastSeenAt || seenAt > existing.lastSeenAt) data.lastSeenAt = seenAt;
  if (!existing.firstSeenAt || seenAt < existing.firstSeenAt) data.firstSeenAt = seenAt;

  return data as Prisma.ResearchIdeaUncheckedUpdateInput;
}

/** Write an embedding onto an idea row. Vectors never travel through Prisma's
    typed API: the column is Unsupported(), so this is the only path. */
export async function writeEmbedding(ideaId: string, vector: number[]): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "ResearchIdea" SET "embedding" = ${vectorLiteral(vector)}::vector WHERE "id" = ${ideaId}
  `;
}
