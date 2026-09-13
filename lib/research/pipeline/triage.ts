/* Cheap Gemini triage: the second gate, between filter and extract.

   shouldProcess throws out posts that are obviously worthless on heuristics
   alone. What survives still costs a call to the expensive extraction model, and
   most of it is not an event idea at all. Triage spends one call to a small
   model to answer five blunt questions - is this an idea, what kind, could an
   agency run it, could it run in India, is the topic even ours - and only what
   passes goes on.

   The verdict is always stored on post.triage (accepted or not) so a rejection
   is explainable and re-triageable later without re-calling anything. */

import { getGeminiConfig, pipelineConfig } from "../config";
import * as gemini from "../gemini";
import { triageVerdict, type TriageResult } from "../schema";
import { commentTexts, type FilterablePost } from "./filter";

export type TriagablePost = FilterablePost & { url: string | null };

/** Triage ran on the body alone, before any comments were fetched. */
export const BODY_ONLY = "body_only";
/** Triage ran on everything we have, comments included. */
export const WITH_COMMENTS = "with_comments";

/** domain_relevant values that earn a post its (rate-limited) comment fetch. */
const RELEVANT_ENOUGH = ["yes", "unclear"];

/** True for posts that must never be triaged away.

    Staff clips are chosen by hand: someone already decided the post is worth the
    agency's time, and a cheap model second-guessing that is worse than no gate. */
export const skipsTriage = (post: { kind: string }) => post.kind === "clip";

const engagement = (post: FilterablePost): Record<string, unknown> =>
  post.engagement && typeof post.engagement === "object" && !Array.isArray(post.engagement)
    ? (post.engagement as Record<string, unknown>)
    : {};

/** True for a reddit post that arrived through the public Atom feeds. */
export const isRedditFeedPost = (post: FilterablePost) =>
  post.kind === "reddit" && engagement(post).via === "rss";

/** True while the comment backfill has neither fetched nor given up on this post.

    comments_skipped_at is stamped when the backfill promotes a post without its
    comments. Without that marker such a post would be sent straight back to
    awaiting_comments by the body gate. */
export function commentsNeverFetched(post: FilterablePost): boolean {
  const blob = engagement(post);
  return !("comments_fetched_at" in blob) && !("comments_skipped_at" in blob);
}

/** Which pass this triage is: body only, or the full thread. */
export function triageStage(post: FilterablePost): string {
  return isRedditFeedPost(post) && commentsNeverFetched(post) ? BODY_ONLY : WITH_COMMENTS;
}

/** True when a rejected post should wait for its comments instead.

    The body gate: a reddit feed post is only worth a rate-limited comment
    request when the model says its topic is in (or near) the agency's domain.
    Everything else is rejected on the body alone and costs reddit nothing. */
export function wantsComments(post: FilterablePost, result: TriageResult): boolean {
  return (
    isRedditFeedPost(post) &&
    commentsNeverFetched(post) &&
    RELEVANT_ENOUGH.includes(result.domain_relevant)
  );
}

export type TriageOutcome = {
  accept: boolean;
  verdict: string;
  result: TriageResult;
  blob: Record<string, unknown>;
};

/** Run triage on a post and build the verdict blob for post.triage.

    The blob records which stage it came from, so a body-only verdict is visibly
    provisional and is overwritten wholesale when the post is re-triaged with its
    comments. The caller writes it. */
export async function triagePost(post: TriagablePost): Promise<TriageOutcome> {
  const config = pipelineConfig();
  const result = await gemini.triagePost({
    title: post.title,
    body: post.body,
    comments: commentTexts(post.comments),
    url: post.url,
    kind: post.kind
  });
  const [accept, verdict] = triageVerdict(result, config.triageStrict);
  return {
    accept,
    verdict,
    result,
    blob: {
      ...result,
      accepted: accept,
      verdict,
      stage: triageStage(post),
      model: getGeminiConfig()?.triageModel ?? null
    }
  };
}
