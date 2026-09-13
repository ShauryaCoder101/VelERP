/* Canonical embedding text for an idea, and the embedding call itself.

   The same text builder is used when an idea is first stored and whenever it is
   re-embedded, so two runs over the same content produce the same vector. It
   reads either shape: an IdeaExtraction (snake_case, straight off the model) or
   a ResearchIdea row (camelCase, out of Postgres). */

import * as gemini from "../gemini";

type AnyIdea = Record<string, unknown>;

const read = (idea: AnyIdea, snake: string): unknown => {
  if (snake in idea) return idea[snake];
  const camel = snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return idea[camel];
};

const cleanStr = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

/** Join a list field into "a, b, c", dropping blanks. Null if empty. */
const cleanList = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === "string") return cleanStr(value);
  if (!Array.isArray(value)) return null;
  const items = value.map(cleanStr).filter((item): item is string => !!item);
  return items.length ? items.join(", ") : null;
};

/** Order matters: it is part of what makes the text canonical. */
const TEXT_FIELDS: Array<[string, string]> = [
  ["title", "Title"],
  ["summary", "Summary"],
  ["how_it_works", "How it works"]
];
const LIST_FIELDS: Array<[string, string]> = [
  ["event_types", "Event types"],
  ["formats", "Formats"]
];
const TAIL_LIST_FIELDS: Array<[string, string]> = [
  ["tags", "Tags"],
  ["audience_types", "Audience types"]
];

/** Render the audience range, tolerating either bound being unknown. */
function audiencePart(idea: AnyIdea): string | null {
  const low = read(idea, "audience_min");
  const high = read(idea, "audience_max");
  const lowNum = low === null || low === undefined ? null : Math.trunc(Number(low));
  const highNum = high === null || high === undefined ? null : Math.trunc(Number(high));
  if (lowNum === null && highNum === null) return null;
  if (lowNum !== null && highNum !== null) return `Audience: ${lowNum}-${highNum} people`;
  if (lowNum !== null) return `Audience: ${lowNum}+ people`;
  return `Audience: up to ${highNum} people`;
}

/** Build the canonical text for an extraction or a stored idea.

    Null fields are skipped entirely rather than rendered as "None", so an idea
    with sparse detail is not pushed away from a rich one by filler. */
export function embeddingText(idea: AnyIdea): string {
  const parts: string[] = [];

  const category = cleanStr(read(idea, "scope_category"));
  if (category) parts.push(`Category: ${category}`);

  for (const [field, label] of TEXT_FIELDS) {
    const value = cleanStr(read(idea, field));
    if (value) parts.push(`${label}: ${value}`);
  }
  for (const [field, label] of LIST_FIELDS) {
    const value = cleanList(read(idea, field));
    if (value) parts.push(`${label}: ${value}`);
  }

  const mode = cleanStr(read(idea, "interaction_mode"));
  if (mode) parts.push(`Interaction: ${mode}`);

  const audience = audiencePart(idea);
  if (audience) parts.push(audience);

  const setting = cleanStr(read(idea, "setting"));
  if (setting) parts.push(`Setting: ${setting}`);

  for (const [field, label] of TAIL_LIST_FIELDS) {
    const value = cleanList(read(idea, field));
    if (value) parts.push(`${label}: ${value}`);
  }

  return parts.join("\n");
}

/** Embed idea texts for storage (document side of the retrieval pair). */
export async function embedIdeas(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  return gemini.embed(texts, "RETRIEVAL_DOCUMENT");
}

/** pgvector literal for a parameterised `$1::vector` cast. */
export const vectorLiteral = (vector: number[]): string => `[${vector.join(",")}]`;
