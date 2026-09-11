/* Search over the deduplicated idea library.

   Two rules drive everything here:

   1. Null tolerance. A filter may only exclude an idea when the column is set
      AND contradicts the filter. An idea whose audienceMax is unknown still
      matches a search for 300 people; it is merely ranked a little lower, and
      the caller is told which fields were unknown so the UI can say "size
      unknown".
   2. Blank means "don't care". Every filter is optional and an empty list or
      empty string is the same as unset.

   Ranking is cosine similarity against the need text, nudged down by how much
   the idea leaves unknown among the fields the planner actually filtered on, and
   nudged up by how often the idea has been seen in the wild. */

import type { Prisma, ResearchIdea } from "@prisma/client";
import { prisma } from "../db";
import * as gemini from "./gemini";
import { vectorLiteral } from "./pipeline/embed";
import {
  BUDGET_BANDS,
  INTERACTION_MODES,
  PHYSICAL_INTENSITIES,
  SCOPE_CATEGORIES,
  SETTINGS
} from "./schema";

/** Penalty per filtered-on field that this idea leaves unknown. */
const UNKNOWN_PENALTY = 0.02;
/** Weight on log1p(popularityScore). */
const POPULARITY_WEIGHT = 0.01;
/** Candidates pulled from Postgres per requested result, before re-ranking. */
const CANDIDATE_MULTIPLIER = 3;
/** How many ideas are handed to Gemini for the synthesised brief. */
const ANSWER_CANDIDATES = 8;
/** Unit separator: array filters travel as one text parameter and are split in
    SQL, so no value is ever interpolated into the statement. */
const ARRAY_SEP = "";

export type SearchFilters = {
  scope_category?: string | null;
  event_types?: string[] | null;
  formats?: string[] | null;
  interaction_mode?: string | null;
  audience_size?: number | null;
  minutes_per_participant_max?: number | null;
  total_duration_max?: number | null;
  setting?: string | null;
  budget_band?: string | null;
  audience_types?: string[] | null;
  physical_intensity?: string | null;
  brandable?: boolean | null;
  tags?: string[] | null;
  region?: string | null;
  extra?: Record<string, string> | null;
};

const asList = (value: unknown): string[] | null => {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "string" ? value.replace(/\n/g, ",").split(",") : value;
  if (!Array.isArray(raw)) return null;
  const cleaned = raw.map((item) => String(item).trim()).filter(Boolean);
  return cleaned.length ? cleaned : null;
};

const asEnum = (value: unknown, allowed: readonly string[]): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return allowed.includes(text) ? text : null;
};

const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asBool = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim()) {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return null;
};

/** Hand-validate whatever the client sent. Anything unrecognised is dropped, so
    a bad filter narrows nothing rather than failing the search. */
export function normaliseFilters(input: unknown): SearchFilters {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const extraRaw = raw.extra;
  let extra: Record<string, string> | null = null;
  if (extraRaw && typeof extraRaw === "object" && !Array.isArray(extraRaw)) {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(extraRaw as Record<string, unknown>)) {
      const k = String(key).trim();
      const v = String(value ?? "").trim();
      if (k && v) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length) extra = cleaned;
  }

  return {
    scope_category: asEnum(raw.scope_category, SCOPE_CATEGORIES),
    event_types: asList(raw.event_types),
    formats: asList(raw.formats),
    interaction_mode: asEnum(raw.interaction_mode, INTERACTION_MODES),
    audience_size: asNumber(raw.audience_size),
    minutes_per_participant_max: asNumber(raw.minutes_per_participant_max),
    total_duration_max: asNumber(raw.total_duration_max),
    setting: asEnum(raw.setting, SETTINGS),
    budget_band: asEnum(raw.budget_band, BUDGET_BANDS),
    audience_types: asList(raw.audience_types),
    physical_intensity: asEnum(raw.physical_intensity, PHYSICAL_INTENSITIES),
    brandable: asBool(raw.brandable),
    tags: asList(raw.tags),
    region: typeof raw.region === "string" && raw.region.trim() ? raw.region.trim() : null,
    extra
  };
}

/** The filters that are actually set. */
export function activeFilters(filters: SearchFilters): Record<string, unknown> {
  const active: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) continue;
    active[key] = value;
  }
  return active;
}

/* ------------------------------------------------------------------------- */
/* WHERE building                                                             */
/* ------------------------------------------------------------------------- */

type Built = {
  clauses: string[];
  unknowns: Array<{ name: string; sql: string }>;
  params: unknown[];
};

/** Turn filters into WHERE clauses plus per-field "was this unknown?" tests.

    Every clause has the shape `<column> IS NULL OR <column> satisfies filter` so
    an idea is only ever excluded by information it actually carries. */
export function buildFilterSql(filters: SearchFilters, startIndex = 1): Built {
  const clauses: string[] = [];
  const unknowns: Array<{ name: string; sql: string }> = [];
  const params: unknown[] = [];
  let next = startIndex;
  const bind = (value: unknown) => {
    params.push(value);
    return `$${next++}`;
  };

  const addArray = (name: string, column: string, values: string[] | null | undefined) => {
    if (!values || !values.length) return;
    const unknownSql = `("${column}" IS NULL OR cardinality("${column}") = 0)`;
    const placeholder = bind(values.join(ARRAY_SEP));
    clauses.push(`(${unknownSql} OR "${column}" && string_to_array(${placeholder}, chr(31)))`);
    unknowns.push({ name, sql: unknownSql });
  };

  const addScalar = (name: string, column: string, value: unknown) => {
    if (value === null || value === undefined) return;
    const unknownSql = `("${column}" IS NULL)`;
    clauses.push(`(${unknownSql} OR "${column}"::text = ${bind(String(value))})`);
    unknowns.push({ name, sql: unknownSql });
  };

  const addMax = (name: string, column: string, value: number | null | undefined) => {
    if (value === null || value === undefined) return;
    const unknownSql = `("${column}" IS NULL)`;
    clauses.push(`(${unknownSql} OR "${column}" <= ${bind(value)}::numeric)`);
    unknowns.push({ name, sql: unknownSql });
  };

  addArray("event_types", "eventTypes", filters.event_types);
  addArray("formats", "formats", filters.formats);
  addArray("audience_types", "audienceTypes", filters.audience_types);
  addArray("tags", "tags", filters.tags);

  addScalar("scope_category", "scopeCategory", filters.scope_category);
  addScalar("interaction_mode", "interactionMode", filters.interaction_mode);
  addScalar("setting", "setting", filters.setting);
  addScalar("budget_band", "budgetBand", filters.budget_band);
  addScalar("physical_intensity", "physicalIntensity", filters.physical_intensity);
  if (filters.brandable !== null && filters.brandable !== undefined) {
    const unknownSql = `("brandable" IS NULL)`;
    clauses.push(`(${unknownSql} OR "brandable" = ${bind(filters.brandable)})`);
    unknowns.push({ name: "brandable", sql: unknownSql });
  }

  addMax(
    "minutes_per_participant_max",
    "minutesPerParticipant",
    filters.minutes_per_participant_max
  );
  addMax("total_duration_max", "totalDurationMinutes", filters.total_duration_max);

  if (filters.audience_size !== null && filters.audience_size !== undefined) {
    const size = filters.audience_size;
    clauses.push(`("audienceMin" IS NULL OR "audienceMin" <= ${bind(size)}::int)`);
    clauses.push(`("audienceMax" IS NULL OR "audienceMax" >= ${bind(size)}::int)`);
    unknowns.push({
      name: "audience_size",
      sql: `("audienceMin" IS NULL AND "audienceMax" IS NULL)`
    });
  }

  if (filters.region) {
    const unknownSql = `("region" IS NULL)`;
    clauses.push(`(${unknownSql} OR "region" ILIKE ${bind(`%${filters.region}%`)})`);
    unknowns.push({ name: "region", sql: unknownSql });
  }

  for (const [key, value] of Object.entries(filters.extra ?? {})) {
    /* jsonb_exists() rather than the `?` operator: a bare ? in a raw query is
       ambiguous with placeholder syntax in more than one driver. */
    const missing = `("attributes" IS NULL OR NOT jsonb_exists("attributes", ${bind(key)}))`;
    clauses.push(`(${missing} OR "attributes" @> ${bind(JSON.stringify({ [key]: value }))}::jsonb)`);
    unknowns.push({ name: `extra.${key}`, sql: missing });
  }

  return { clauses, unknowns, params };
}

/* ------------------------------------------------------------------------- */
/* Search                                                                     */
/* ------------------------------------------------------------------------- */

export type IdeaHit = {
  idea: ResearchIdea;
  similarity: number;
  unknownFields: string[];
  score: number;
};

export type SearchResult = {
  ideas: IdeaHit[];
  answer: string | null;
  searchId: string | null;
};

const COMPACT_FIELDS = [
  "scopeCategory",
  "title",
  "summary",
  "howItWorks",
  "eventTypes",
  "formats",
  "interactionMode",
  "audienceMin",
  "audienceMax",
  "minutesPerParticipant",
  "totalDurationMinutes",
  "setting",
  "spaceRequirements",
  "techRequirements",
  "staffCount",
  "materials",
  "budgetBand",
  "budgetNotes",
  "audienceTypes",
  "ageGroup",
  "brandable",
  "physicalIntensity",
  "region",
  "occasion",
  "tags"
];

/** A small view of an idea for the answer prompt: nulls kept, deliberately. */
export function compactIdea(idea: ResearchIdea): Record<string, unknown> {
  const row = idea as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = { id: idea.id };
  for (const field of COMPACT_FIELDS) {
    const value = row[field];
    payload[field] = value && typeof value === "object" && "toNumber" in (value as object)
      ? Number(value)
      : value;
  }
  if (idea.attributes) payload.attributes = idea.attributes;
  return payload;
}

export type SearchOptions = {
  needText: string;
  filters?: SearchFilters;
  k?: number;
  synthesize?: boolean;
  userId?: string | null;
  /** Skip persisting the ResearchSearch row (the research panel re-ranks). */
  record?: boolean;
};

/** Rank active ideas against a plain-language need plus optional filters.

    A Gemini failure never fails the search: the brief comes back null, and if
    even the query embedding fails the ranking falls back to popularity order. */
export async function search(options: SearchOptions): Promise<SearchResult> {
  const filters = options.filters ?? normaliseFilters({});
  const needText = (options.needText || "").trim();
  const k = Math.max(1, Math.trunc(options.k ?? 20));

  let queryVector: number[] | null = null;
  if (needText) {
    try {
      const vectors = await gemini.embed([needText], "RETRIEVAL_QUERY");
      queryVector = vectors[0]?.length ? vectors[0] : null;
    } catch (error) {
      console.warn("[research] embedding the need text failed; using popularity order", error);
    }
  }

  const params: unknown[] = [];
  let next = 1;
  let distanceSql = "0::float8";
  if (queryVector) {
    params.push(vectorLiteral(queryVector));
    distanceSql = `("embedding" <=> $${next++}::vector)`;
  }

  const built = buildFilterSql(filters, next);
  params.push(...built.params);
  next += built.params.length;

  const where = ['"status" = \'active\''];
  if (queryVector) where.push('"embedding" IS NOT NULL');
  where.push(...built.clauses);

  const unknownColumns = built.unknowns.map((u, index) => `${u.sql} AS u${index}`);
  const orderBy = queryVector
    ? `${distanceSql} ASC`
    : '"popularityScore" DESC, "lastSeenAt" DESC NULLS LAST';

  const sql = `
    SELECT "id", ${distanceSql} AS distance, "popularityScore"${unknownColumns.length ? `, ${unknownColumns.join(", ")}` : ""}
    FROM "ResearchIdea"
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT $${next}
  `;
  params.push(k * CANDIDATE_MULTIPLIER);

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params);
  if (!rows.length) {
    const searchId = options.record === false ? null : await recordSearch(needText, filters, [], null, options.userId);
    return { ideas: [], answer: null, searchId };
  }

  const ideas = await prisma.researchIdea.findMany({
    where: { id: { in: rows.map((row) => String(row.id)) } }
  });
  const byId = new Map(ideas.map((idea) => [idea.id, idea]));

  const hits: IdeaHit[] = [];
  for (const row of rows) {
    const idea = byId.get(String(row.id));
    if (!idea) continue;
    const similarity = queryVector ? 1 - Number(row.distance ?? 0) : 0;
    const unknownFields = built.unknowns
      .map((u, index) => (row[`u${index}`] ? u.name : null))
      .filter((name): name is string => !!name);
    const popularity = Math.max(Number(row.popularityScore ?? 0), 0);
    const score =
      similarity - UNKNOWN_PENALTY * unknownFields.length + POPULARITY_WEIGHT * Math.log1p(popularity);
    hits.push({ idea, similarity, unknownFields, score });
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, k);

  let brief: string | null = null;
  if (options.synthesize !== false && needText && top.length) {
    try {
      brief = (await gemini.answer(needText, top.slice(0, ANSWER_CANDIDATES).map((hit) => compactIdea(hit.idea)))) || null;
    } catch (error) {
      console.warn("[research] answer synthesis failed; returning ideas without a brief", error);
    }
  }

  const searchId =
    options.record === false
      ? null
      : await recordSearch(needText, filters, top.map((hit) => hit.idea.id), brief, options.userId);
  return { ideas: top, answer: brief, searchId };
}

/** Persist the search for later evaluation. Never fatal. */
async function recordSearch(
  needText: string,
  filters: SearchFilters,
  ideaIds: string[],
  answer: string | null,
  userId?: string | null
): Promise<string | null> {
  try {
    const active = activeFilters(filters);
    const row = await prisma.researchSearch.create({
      data: {
        needText: needText || null,
        filters: (Object.keys(active).length ? active : undefined) as Prisma.InputJsonValue,
        resultIdeaIds: ideaIds as Prisma.InputJsonValue,
        answer,
        userId: userId ?? null
      },
      select: { id: true }
    });
    return row.id;
  } catch (error) {
    console.warn("[research] could not persist the search row", error);
    return null;
  }
}

/** Rank a fixed set of ideas against a need, for the research job panel. */
export async function rankIdeas(ideaIds: string[], needText: string | null): Promise<IdeaHit[]> {
  if (!ideaIds.length) return [];
  let queryVector: number[] | null = null;
  if (needText) {
    try {
      const vectors = await gemini.embed([needText], "RETRIEVAL_QUERY");
      queryVector = vectors[0]?.length ? vectors[0] : null;
    } catch (error) {
      console.warn("[research] embedding the need text failed; showing ideas unranked", error);
    }
  }

  const ideas = await prisma.researchIdea.findMany({
    where: { id: { in: ideaIds }, status: "active" }
  });
  if (!queryVector) {
    return ideas.map((idea) => ({ idea, similarity: 0, unknownFields: [], score: 0 }));
  }

  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; distance: number }>>(
    `SELECT "id", ("embedding" <=> $1::vector) AS distance
     FROM "ResearchIdea"
     WHERE "id" = ANY(string_to_array($2, chr(31))) AND "status" = 'active'
     ORDER BY distance ASC NULLS LAST`,
    vectorLiteral(queryVector),
    ideaIds.join("")
  );
  const byId = new Map(ideas.map((idea) => [idea.id, idea]));
  const hits: IdeaHit[] = [];
  for (const row of rows) {
    const idea = byId.get(String(row.id));
    if (!idea) continue;
    const similarity = row.distance === null ? 0 : 1 - Number(row.distance);
    hits.push({ idea, similarity, unknownFields: [], score: similarity });
  }
  return hits;
}
