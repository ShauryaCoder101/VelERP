/* Staff "clips" - the manual intake.

   Nothing to poll: staff push a link and/or some pasted text through the API,
   and this turns that into the same RawPostIn shape the automatic listeners
   produce. Clips bypass triage (someone already decided the post is worth the
   agency's time) but go through extraction, dedupe and everything else. */

import { createHash } from "crypto";
import { fetchReadableText, truncate } from "../html";
import type { RawPostIn } from "./types";

export const KIND = "clip" as const;
export const CLIP_IDENTIFIER = "manual";

const BODY_CHARS = 12_000;
const FETCH_TIMEOUT = 10_000;

/** Stable id so re-clipping the same link or text updates one row. */
export function clipExternalId(url: string | null, text: string | null): string {
  const basis = (url || text || "").trim();
  return createHash("sha1").update(basis, "utf8").digest("hex");
}

export type ClipInput = {
  url?: string | null;
  text?: string | null;
  title?: string | null;
  author?: string | null;
  note?: string | null;
  mediaUrls?: string[] | null;
};

/** Build a clip RawPostIn from what a staff member submitted.

    At least one of url or text is required. When only a url is given the page is
    fetched and reduced to readable text; a fetch failure is not fatal - the clip
    is still recorded (with the staff note, if any) so it can be revisited. */
export async function makeClip(input: ClipInput): Promise<RawPostIn> {
  const url = (input.url || "").trim() || null;
  const text = (input.text || "").trim() || null;
  const note = (input.note || "").trim() || null;

  if (!url && !text) throw new Error("A clip needs at least a url or some text");

  const parts: string[] = [];
  if (note) parts.push(`STAFF NOTE: ${note}`);
  if (text) {
    parts.push(text);
  } else if (url) {
    const fetched = await fetchReadableText(url, BODY_CHARS, FETCH_TIMEOUT);
    if (fetched) parts.push(fetched);
    else console.warn("[research] clip", url, "- page text could not be fetched");
  }

  return {
    kind: KIND,
    externalId: clipExternalId(url, text),
    url,
    author: (input.author || "").trim() || null,
    title: (input.title || "").trim() || null,
    body: truncate(parts.join("\n\n"), BODY_CHARS) || null,
    comments: [],
    mediaUrls: input.mediaUrls ?? [],
    engagement: {},
    postedAt: null
  };
}
