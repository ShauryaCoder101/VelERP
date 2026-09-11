/* JSON views of the research rows. Nulls are kept on purpose: "unknown" is a
   real state in this library and the UI has to be able to show it. */

import type { ResearchIdea, ResearchPost } from "@prisma/client";
import type { IdeaHit } from "./search";

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

export const hitToJson = (hit: IdeaHit) => ({
  similarity: Number(hit.similarity.toFixed(4)),
  score: Number(hit.score.toFixed(4)),
  unknownFields: hit.unknownFields,
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
