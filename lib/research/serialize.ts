/* JSON views of the research rows. Nulls are kept on purpose: "unknown" is a
   real state in this library and the UI has to be able to show it. */

import type { ResearchIdea, ResearchPost } from "@prisma/client";
import { prisma } from "../db";
import type { IdeaHit } from "./search";

export type SourceLink = { postId: string; kind: string; url: string | null; title: string | null };

/** The earliest source post per idea, so a result card can link out to where the
    idea came from. Browse computes this itself over its own page of ideas; this
    is the same thing for the two vector-ranked views (search and a research
    job), which otherwise carry no provenance at all. */
export async function firstSourceLinks(ideaIds: string[]): Promise<Map<string, SourceLink>> {
  const links = new Map<string, SourceLink>();
  if (!ideaIds.length) return links;
  const rows = await prisma.researchIdeaSource.findMany({
    where: { ideaId: { in: ideaIds } },
    select: { ideaId: true, post: { select: { id: true, kind: true, url: true, title: true } } },
    orderBy: { createdAt: "asc" }
  });
  for (const row of rows) {
    if (links.has(row.ideaId)) continue;
    links.set(row.ideaId, {
      postId: row.post.id,
      kind: row.post.kind,
      url: row.post.url,
      title: row.post.title
    });
  }
  return links;
}

/** Every descriptive column, in the order the detail view shows them. */
export const IDEA_FIELDS = [
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
  "staffing",
  "staffCount",
  "setupTimeMinutes",
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
] as const;

const plain = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && "toNumber" in (value as object)) {
    return Number(value as never);
  }
  return value;
};

export function ideaToJson(idea: ResearchIdea): Record<string, unknown> {
  const row = idea as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = { id: idea.id };
  for (const field of IDEA_FIELDS) payload[field] = plain(row[field]);
  payload.attributes = idea.attributes ?? {};
  payload.confidence = idea.confidence ?? {};
  payload.popularityScore = plain(idea.popularityScore);
  payload.sourceCount = idea.sourceCount;
  payload.status = idea.status;
  payload.firstSeenAt = plain(idea.firstSeenAt);
  payload.lastSeenAt = plain(idea.lastSeenAt);
  payload.createdAt = plain(idea.createdAt);
  payload.updatedAt = plain(idea.updatedAt);
  return payload;
}

export const hitToJson = (hit: IdeaHit, source: SourceLink | null = null) => ({
  similarity: Number(hit.similarity.toFixed(4)),
  score: Number(hit.score.toFixed(4)),
  unknownFields: hit.unknownFields,
  source,
  idea: ideaToJson(hit.idea)
});

export const postToJson = (
  post: Pick<ResearchPost, "id" | "kind" | "title" | "url" | "author" | "postedAt">
) => ({
  postId: post.id,
  kind: post.kind,
  title: post.title,
  url: post.url,
  author: post.author,
  postedAt: plain(post.postedAt)
});
