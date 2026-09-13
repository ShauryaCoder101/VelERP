/* Orchestrates filter -> triage -> extract -> embed -> dedupe -> upsert.

   One post is one unit of work: it is written on its own, and a failure on one
   post is recorded against that post and never stops the batch. This is the
   whole per-post decision tree, shared by the cron tick's backlog and by a
   research job's haul, so a page fetched by research mode is judged by exactly
   the same gates as a post that arrived from a subreddit poll. */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import * as gemini from "../gemini";
import { fetchReadableText } from "../html";
import type { IdeaExtraction } from "../schema";
import {
  buildIdeaCreate,
  buildMergeUpdate,
  findDuplicate,
  writeEmbedding
} from "./dedupe";
import { embedIdeas, embeddingText } from "./embed";
import { commentTexts, shouldProcess } from "./filter";
import { skipsTriage, triagePost, wantsComments } from "./triage";

/** Errors are stored in a text column; a stack-trace-sized string in every row
    makes the admin screens unusable. */
const MAX_ERROR_CHARS = 2000;

export type Counts = {
  processed: number;
  skipped: number;
  triaged: number;
  rejected: number;
  awaiting_comments: number;
  extracted: number;
  ideas_created: number;
  ideas_merged: number;
  failed: number;
};

export const blankCounts = (): Counts => ({
  processed: 0,
  skipped: 0,
  triaged: 0,
  rejected: 0,
  awaiting_comments: 0,
  extracted: 0,
  ideas_created: 0,
  ideas_merged: 0,
  failed: 0
});

export const addCounts = (into: Counts, from: Counts): Counts => {
  for (const key of Object.keys(into) as Array<keyof Counts>) into[key] += from[key];
  return into;
};

/** Which ideas one post (or a batch of them) landed on. Research mode needs the
    identities, not just the tallies. */
export type PostIdeas = { created: string[]; merged: string[] };

export const blankIdeas = (): PostIdeas => ({ created: [], merged: [] });

export const allIdeaIds = (ideas: PostIdeas): string[] => [
  ...new Set([...ideas.created, ...ideas.merged])
];

export const POST_SELECT = {
  id: true,
  kind: true,
  externalId: true,
  url: true,
  title: true,
  body: true,
  comments: true,
  engagement: true,
  postedAt: true,
  status: true,
  triage: true
} satisfies Prisma.ResearchPostSelect;

export type PipelinePost = Prisma.ResearchPostGetPayload<{ select: typeof POST_SELECT }>;

/* ------------------------------------------------------------------------- */

/** Call Gemini on a post and record the raw result on post.extraction.

    The stored blob is kept for debugging and for re-running downstream steps
    without paying for the call again. */
async function extractPost(post: PipelinePost): Promise<IdeaExtraction[]> {
  const ideas = await gemini.extractIdeas({
    title: post.title,
    body: post.body,
    comments: commentTexts(post.comments),
    url: post.url,
    kind: post.kind
  });
  await prisma.researchPost.update({
    where: { id: post.id },
    data: { extraction: { ideas } as Prisma.InputJsonValue }
  });
  return ideas;
}

async function link(ideaId: string, postId: string, index: number): Promise<void> {
  await prisma.researchIdeaSource.createMany({
    data: [{ ideaId, postId, extractionIndex: index }],
    skipDuplicates: true
  });
}

/** Run extract -> embed -> dedupe -> upsert for one post. */
export async function processPost(post: PipelinePost): Promise<PostIdeas> {
  const touched = blankIdeas();
  const extractions = await extractPost(post);

  for (let index = 0; index < extractions.length; index += 1) {
    const extraction = extractions[index];
    const text = embeddingText(extraction as Record<string, unknown>);
    if (!text.trim()) {
      console.info(`[research] extraction ${index} of ${post.id} had no embeddable text`);
      continue;
    }

    const vectors = await embedIdeas([text]);
    const vector = vectors[0];
    if (!vector || !vector.length) {
      console.warn(`[research] no embedding returned for extraction ${index} of ${post.id}`);
      continue;
    }

    const match = await findDuplicate(vector);
    if (match) {
      const existing = await prisma.researchIdea.findUnique({ where: { id: match.id } });
      if (existing) {
        await prisma.researchIdea.update({
          where: { id: existing.id },
          data: buildMergeUpdate(existing, extraction, post)
        });
        await link(existing.id, post.id, index);
        touched.merged.push(existing.id);
        console.info(
          `[research] merged extraction ${index} of ${post.id} into ${existing.id} (sim ${match.similarity.toFixed(4)})`
        );
        continue;
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const idea = await tx.researchIdea.create({
        data: buildIdeaCreate(extraction, post),
        select: { id: true }
      });
      await tx.$executeRawUnsafe(
        'UPDATE "ResearchIdea" SET "embedding" = $1::vector WHERE "id" = $2',
        `[${vector.join(",")}]`,
        idea.id
      );
      return idea.id;
    });
    await link(created, post.id, index);
    touched.created.push(created);
    console.info(`[research] created idea ${created} from extraction ${index} of ${post.id}`);
  }

  await prisma.researchPost.update({
    where: { id: post.id },
    data: { status: "extracted", error: null, processedAt: new Date() }
  });
  return touched;
}

/** A feed summary shorter than this is a teaser, not an article. */
const FULLTEXT_THRESHOLD = 500;
const FULLTEXT_CHARS = 12_000;

/** Fetch the article behind a short RSS summary, once, at processing time.

    The Python worker did this inside the poll, where it had all the time in the
    world; a tick does not, and a poll that fetched forty articles would eat the
    whole budget. Doing it here spreads the cost over the posts a tick actually
    looks at (RESEARCH_TICK_POSTS of them), and every post still gets its full
    text before the length gate judges it. */
async function hydrateBody(post: PipelinePost): Promise<PipelinePost> {
  if (post.kind !== "rss") return post;
  if (!post.url) return post;
  if ((post.body?.length ?? 0) >= FULLTEXT_THRESHOLD) return post;

  const article = await fetchReadableText(post.url, FULLTEXT_CHARS, 10_000);
  if (article.length <= (post.body?.length ?? 0)) return post;
  await prisma.researchPost.update({ where: { id: post.id }, data: { body: article } });
  return { ...post, body: article };
}

/** Take one post as far as it goes. Never throws: a failure is recorded on the
    post and counted, because one bad post must not stop a batch. */
export async function runOnePost(input: PipelinePost): Promise<[Counts, PostIdeas]> {
  const counts = blankCounts();
  counts.processed = 1;
  let touched = blankIdeas();
  let post = input;

  try {
    post = await hydrateBody(post);
    const [keep, reason] = shouldProcess(post);
    if (!keep) {
      await prisma.researchPost.update({
        where: { id: post.id },
        data: { status: "skipped", error: reason.slice(0, MAX_ERROR_CHARS), processedAt: new Date() }
      });
      counts.skipped = 1;
      console.info(`[research] skipped ${post.externalId}: ${reason}`);
      return [counts, touched];
    }

    if (!skipsTriage(post)) {
      const outcome = await triagePost(post);
      counts.triaged = 1;
      await prisma.researchPost.update({
        where: { id: post.id },
        data: { triage: outcome.blob as Prisma.InputJsonValue }
      });

      if (!outcome.accept) {
        /* The body gate: a reddit feed post rejected on its body alone is only
           worth a rate-limited comment request when the model says its topic is
           ours. Everything else stops here. */
        if (wantsComments(post, outcome.result)) {
          await prisma.researchPost.update({
            where: { id: post.id },
            data: { status: "awaiting_comments", error: null, processedAt: null }
          });
          counts.awaiting_comments = 1;
          console.info(
            `[research] holding ${post.externalId} for its comments: ${outcome.verdict}, domain_relevant=${outcome.result.domain_relevant}`
          );
          return [counts, touched];
        }
        await prisma.researchPost.update({
          where: { id: post.id },
          data: { status: "rejected", error: null, processedAt: new Date() }
        });
        counts.rejected = 1;
        console.info(`[research] rejected ${post.externalId} at triage: ${outcome.verdict}`);
        return [counts, touched];
      }
    }

    touched = await processPost(post);
    counts.extracted = 1;
    counts.ideas_created = touched.created.length;
    counts.ideas_merged = touched.merged.length;
  } catch (error) {
    /* A post that failed after its triage call still cost that call, so the
       triage counter survives the reset. */
    const triaged = counts.triaged;
    const reset = blankCounts();
    reset.processed = 1;
    reset.triaged = triaged;
    reset.failed = 1;
    console.error(`[research] processing failed for post ${post.id}:`, error);
    try {
      await prisma.researchPost.update({
        where: { id: post.id },
        data: {
          status: "failed",
          error: `${error instanceof Error ? error.name : "Error"}: ${String(error)}`.slice(
            0,
            MAX_ERROR_CHARS
          ),
          processedAt: new Date()
        }
      });
    } catch (inner) {
      console.error(`[research] could not record failure for post ${post.id}:`, inner);
    }
    return [reset, blankIdeas()];
  }

  return [counts, touched];
}

/** Process up to `limit` posts with status `new`, oldest first.

    `deadline` is an absolute timestamp: no new post is started past it, which is
    what keeps a tick inside its serverless time budget. */
export async function processPending(
  limit: number,
  deadline?: number
): Promise<[Counts, PostIdeas]> {
  const totals = blankCounts();
  const ideas = blankIdeas();
  if (limit <= 0) return [totals, ideas];

  const posts = await prisma.researchPost.findMany({
    where: { status: "new" },
    orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: POST_SELECT
  });

  for (const post of posts) {
    if (deadline && Date.now() > deadline) break;
    const [counts, touched] = await runOnePost(post);
    addCounts(totals, counts);
    ideas.created.push(...touched.created);
    ideas.merged.push(...touched.merged);
  }
  return [totals, ideas];
}

/** Run the pipeline over an explicit list of posts, whatever their order.

    Research mode's counterpart to processPending. Posts that are no longer `new`
    (already processed, or parked in awaiting_comments by a concurrent tick) are
    left alone. */
export async function processPosts(
  postIds: string[],
  deadline?: number
): Promise<[Counts, PostIdeas]> {
  const totals = blankCounts();
  const ideas = blankIdeas();
  if (!postIds.length) return [totals, ideas];

  const posts = await prisma.researchPost.findMany({
    where: { id: { in: postIds }, status: "new" },
    orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
    select: POST_SELECT
  });

  for (const post of posts) {
    if (deadline && Date.now() > deadline) break;
    const [counts, touched] = await runOnePost(post);
    addCounts(totals, counts);
    ideas.created.push(...touched.created);
    ideas.merged.push(...touched.merged);
  }
  return [totals, ideas];
}
