/* Shared contract between source listeners and the ingestion pipeline.

   Every source module produces RawPostIn values; upsertRawPosts writes them.
   Nothing in sources/ talks to Gemini. */

import type { ResearchSourceKind } from "@prisma/client";

/** A post as fetched from a source, before any AI processing.

    `kind` + `externalId` must be stable across polls so re-fetching the same
    post updates engagement instead of creating a duplicate. */
export type RawPostIn = {
  kind: ResearchSourceKind;
  externalId: string;
  url?: string | null;
  author?: string | null;
  title?: string | null;
  body?: string | null;
  /** Top comment texts, best first. */
  comments: string[];
  mediaUrls: string[];
  /** score, comments, views, likes, plus bookkeeping markers like `via`. */
  engagement: Record<string, unknown>;
  postedAt?: Date | null;
};
