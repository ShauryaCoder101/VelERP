/* Shared vocabulary for the research screens.

   The library records "we do not know" as often as it records a value, so every
   helper here has to have an answer for null — that is the whole reason these
   live in one place rather than being re-typed per page. */

export type Idea = {
  id: string;
  scopeCategory: string | null;
  title: string | null;
  summary: string | null;
  howItWorks: string | null;
  eventTypes: string[] | null;
  formats: string[] | null;
  interactionMode: string | null;
  audienceMin: number | null;
  audienceMax: number | null;
  minutesPerParticipant: number | null;
  totalDurationMinutes: number | null;
  setting: string | null;
  spaceRequirements: string | null;
  techRequirements: string | null;
  staffing: string | null;
  staffCount: number | null;
  setupTimeMinutes: number | null;
  materials: string | null;
  budgetBand: string | null;
  budgetNotes: string | null;
  audienceTypes: string[] | null;
  ageGroup: string | null;
  brandable: boolean | null;
  physicalIntensity: string | null;
  region: string | null;
  occasion: string | null;
  tags: string[] | null;
  attributes: Record<string, unknown>;
  confidence: Record<string, number>;
  popularityScore: number | null;
  sourceCount: number;
  status: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SourceLink = {
  postId: string;
  kind: string;
  url: string | null;
  title: string | null;
};

export type Hit = {
  similarity: number;
  score: number;
  unknownFields: string[];
  source: SourceLink | null;
  idea: Idea;
};

/* ── Vocabulary ── */

export const SCOPE_CATEGORIES = [
  "activation",
  "marketing_activation",
  "crowd_engagement",
  "event_technology",
  "captivating_activity"
];
export const INTERACTION_MODES = ["one_to_one", "one_to_many", "many_to_many", "self_guided"];
export const SETTINGS = ["indoor", "outdoor", "hybrid", "virtual"];
export const BUDGET_BANDS = ["low", "medium", "high", "premium"];
export const PHYSICAL_INTENSITIES = ["low", "medium", "high"];
export const SOURCE_KINDS = ["reddit", "rss", "web", "clip", "youtube"];

/** Enum value → something a person reads. Falls back to de-underscoring, so a
    value the backend adds later still shows up sensibly. */
export const humanise = (value: string | null | undefined): string =>
  value ? value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";

/** Category colours. Deliberately mostly greys with the brand red reserved for
    the agency's bread and butter, so a grid of cards does not turn into a
    rainbow. */
export const CATEGORY_COLOUR: Record<string, { bg: string; fg: string }> = {
  activation: { bg: "#fdecef", fg: "#b50f20" },
  marketing_activation: { bg: "#f5f5f6", fg: "#3d3d45" },
  crowd_engagement: { bg: "#ececf1", fg: "#27272b" },
  event_technology: { bg: "#f0f0f5", fg: "#565660" },
  captivating_activity: { bg: "#f5f5f6", fg: "#6c6c75" }
};

export const categoryStyle = (value: string | null | undefined) => {
  const colour = (value && CATEGORY_COLOUR[value]) || { bg: "#f5f5f6", fg: "#6c6c75" };
  return { background: colour.bg, color: colour.fg };
};

/* ── Values ── */

export const dash = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

/** "40–200 people", or one-sided when only one end is known. */
export const audienceRange = (min: number | null, max: number | null): string | null => {
  if (min && max) return `${min}–${max} people`;
  if (max) return `up to ${max} people`;
  if (min) return `${min}+ people`;
  return null;
};

/** Minutes as something sayable: 45 min, 1 h 30 min, 2 h. */
export const minutes = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const total = Math.round(Number(value));
  if (!Number.isFinite(total)) return null;
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

export const confidencePercent = (
  confidence: Record<string, number> | null | undefined,
  field: string
): string | null => {
  const value = confidence?.[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${Math.round(value * 100)}%`;
};

export const when = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
};

export const day = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  } catch {
    return iso;
  }
};
