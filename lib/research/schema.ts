/* The extraction schema Gemini fills in, the triage schema, the research plan
   schema, and the prompt text for all four calls.

   The prompts are copied verbatim from the Python reference implementation
   (app/llm/schema.py). Do not reword them casually: the triage and extraction
   behaviour of the whole library is defined by these strings.

   Core design rule: nothing is mandatory. Every extraction field is optional and
   the model must leave a field null rather than guess. */

export type ScopeCategory =
  | "activation"
  | "marketing_activation"
  | "crowd_engagement"
  | "event_technology"
  | "captivating_activity";

export type InteractionMode = "one_to_one" | "one_to_many" | "many_to_many" | "self_guided";
export type SettingValue = "indoor" | "outdoor" | "hybrid" | "virtual";
export type BudgetBand = "low" | "medium" | "high" | "premium";
export type PhysicalIntensity = "low" | "medium" | "high";

export const SCOPE_CATEGORIES: ScopeCategory[] = [
  "activation",
  "marketing_activation",
  "crowd_engagement",
  "event_technology",
  "captivating_activity"
];
export const INTERACTION_MODES: InteractionMode[] = [
  "one_to_one",
  "one_to_many",
  "many_to_many",
  "self_guided"
];
export const SETTINGS: SettingValue[] = ["indoor", "outdoor", "hybrid", "virtual"];
export const BUDGET_BANDS: BudgetBand[] = ["low", "medium", "high", "premium"];
export const PHYSICAL_INTENSITIES: PhysicalIntensity[] = ["low", "medium", "high"];

/** One reusable event / activation idea pulled out of a source post. */
export type IdeaExtraction = {
  scope_category?: ScopeCategory | null;
  title?: string | null;
  summary?: string | null;
  how_it_works?: string | null;
  event_types?: string[] | null;
  formats?: string[] | null;
  interaction_mode?: InteractionMode | null;
  audience_min?: number | null;
  audience_max?: number | null;
  minutes_per_participant?: number | null;
  total_duration_minutes?: number | null;
  setting?: SettingValue | null;
  space_requirements?: string | null;
  tech_requirements?: string | null;
  staffing?: string | null;
  staff_count?: number | null;
  setup_time_minutes?: number | null;
  materials?: string | null;
  budget_band?: BudgetBand | null;
  budget_notes?: string | null;
  audience_types?: string[] | null;
  age_group?: string | null;
  brandable?: boolean | null;
  physical_intensity?: PhysicalIntensity | null;
  region?: string | null;
  occasion?: string | null;
  tags?: string[] | null;
  attributes?: Record<string, unknown> | null;
  confidence?: Record<string, number> | null;
};

export type TriageGate = "yes" | "no" | "unclear";
export type TriageCategory = ScopeCategory | "other";

export type TriageResult = {
  is_idea: boolean;
  category: TriageCategory;
  corporate_fit: TriageGate;
  india_fit: TriageGate;
  domain_relevant: TriageGate;
  reason: string;
  confidence: number;
};

export type ResearchPlan = {
  web_queries: string[];
  reddit_queries: string[];
};

export type WebHit = {
  url: string;
  title?: string | null;
  snippet?: string | null;
};

/* ------------------------------------------------------------------------- */
/* Gemini response schemas                                                    */
/*                                                                            */
/* The API rejects free-form JSON objects in a response schema                */
/* ("additionalProperties is not supported"), so `attributes` and             */
/* `confidence` are requested as JSON-encoded strings and decoded back into   */
/* objects. Purely a transport detail; callers only ever see IdeaExtraction.  */
/* ------------------------------------------------------------------------- */

type GeminiSchema = Record<string, unknown>;

const str = (description: string): GeminiSchema => ({
  type: "STRING",
  nullable: true,
  description
});
const enumStr = (values: string[], description: string): GeminiSchema => ({
  type: "STRING",
  nullable: true,
  enum: values,
  description
});
const int = (description: string): GeminiSchema => ({
  type: "INTEGER",
  nullable: true,
  description
});
const numberField = (description: string): GeminiSchema => ({
  type: "NUMBER",
  nullable: true,
  description
});
const boolField = (description: string): GeminiSchema => ({
  type: "BOOLEAN",
  nullable: true,
  description
});
const strList = (description: string): GeminiSchema => ({
  type: "ARRAY",
  nullable: true,
  items: { type: "STRING" },
  description
});

const SCOPE_CATEGORY_DESCRIPTION =
  "Which in-scope category this idea belongs to: 'activation' (a branded / " +
  "experiential brand activation), 'marketing_activation' (a campaign mechanic " +
  "run to pull an audience in), 'crowd_engagement' (a game, contest, " +
  "participatory mechanic, mass icebreaker or interactive installation), " +
  "'event_technology' (AR/VR, projection, LED, holograms, drones, interactive " +
  "screens, RFID, wearables, AI-driven interactive experiences), or " +
  "'captivating_activity' (an attention-capturing activity or performance). " +
  "Null only if you genuinely cannot tell.";

const IDEA_PROPERTIES: Record<string, GeminiSchema> = {
  scope_category: enumStr(SCOPE_CATEGORIES, SCOPE_CATEGORY_DESCRIPTION),
  title: str("Short punchy name for the idea, 3-8 words, e.g. 'Instant photo mosaic wall'."),
  summary: str(
    "One or two sentences describing what the activity is and why it lands with an audience."
  ),
  how_it_works: str(
    "Concrete step-by-step mechanics of running it, as described or clearly implied by the source."
  ),
  event_types: strList(
    "Kinds of event this suits, e.g. 'conference', 'offsite', 'product launch', " +
      "'trade show booth', 'town hall', 'annual day', 'wedding'."
  ),
  formats: strList(
    "Delivery formats, e.g. 'workshop', 'game', 'photo booth', 'installation', " +
      "'performance', 'competition', 'scavenger hunt'."
  ),
  interaction_mode: enumStr(
    INTERACTION_MODES,
    "How participants engage: 'one_to_one' (a host per guest), 'one_to_many' " +
      "(one facilitator addressing a group), 'many_to_many' (guests interact with " +
      "each other), 'self_guided' (guests do it alone with no staff)."
  ),
  audience_min: int(
    "Smallest headcount the activity still works for. Only if stated or clearly implied."
  ),
  audience_max: int(
    "Largest headcount the activity can handle. Only if stated or clearly implied."
  ),
  minutes_per_participant: numberField(
    "Minutes one participant spends actively engaged with the activity, for " +
      "queue/throughput planning. Not the length of the whole event."
  ),
  total_duration_minutes: numberField(
    "Minutes the activity runs end to end across all participants, excluding setup."
  ),
  setting: enumStr(
    SETTINGS,
    "Where it runs: 'indoor', 'outdoor', 'hybrid' or 'virtual' (fully online)."
  ),
  space_requirements: str(
    "Physical space needed: floor area, ceiling height, power, room type, layout."
  ),
  tech_requirements: str("Hardware, software, AV, network or app needed to run it."),
  staffing: str("Roles needed to run it, e.g. 'one host plus two photographers'."),
  staff_count: int("Number of crew needed on site to run it."),
  setup_time_minutes: numberField(
    "Minutes needed to build/install the activity before doors open."
  ),
  materials: str("Physical props, consumables, printing, furniture or kit required."),
  budget_band: enumStr(
    BUDGET_BANDS,
    "Rough cost tier: 'low' (near-free / DIY), 'medium', 'high', 'premium' " +
      "(custom-built, headline spend). Only if the source gives a cost signal."
  ),
  budget_notes: str("Any cost detail the source actually states, including currency and figures."),
  audience_types: strList(
    "Who it suits, e.g. 'employees', 'clients', 'sales teams', 'engineers', " +
      "'families', 'senior leadership', 'general public'."
  ),
  age_group: str("Age range it suits, e.g. 'adults', 'all ages', 'kids 6-12'."),
  brandable: boolField(
    "True if the activity can carry sponsor/company branding or be themed to a brand."
  ),
  physical_intensity: enumStr(
    PHYSICAL_INTENSITIES,
    "How physically demanding it is: 'low' (seated/standing), 'medium' (moving " +
      "around), 'high' (sport, sustained exertion)."
  ),
  region: str(
    "Geography the idea is tied to, if any, e.g. 'India', 'US Midwest'. Null if universal."
  ),
  occasion: str("Occasion it is tied to, e.g. 'Diwali', 'holiday party', 'onboarding week'."),
  tags: strList(
    "Free-form lowercase keywords for retrieval, e.g. 'ai', 'nostalgia', 'team building'."
  ),
  attributes: str(
    'Any additional useful detail that does not fit a field above, as a JSON ' +
      'object encoded in a string, e.g. "{\\"noise_level\\": \\"loud\\"}". ' +
      "Use short snake_case keys. Null if there is nothing to add."
  ),
  confidence: str(
    'A JSON object encoded in a string mapping each field you filled in to a ' +
      '0-1 confidence that it is correct, e.g. "{\\"title\\": 0.9, ' +
      '\\"audience_max\\": 0.4}". Omit fields you left null.'
  )
};

export const EXTRACTION_RESPONSE_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    ideas: {
      type: "ARRAY",
      description:
        "Every distinct reusable idea found in the post. Empty list if there are none.",
      items: {
        type: "OBJECT",
        properties: IDEA_PROPERTIES,
        propertyOrdering: Object.keys(IDEA_PROPERTIES)
      }
    }
  },
  required: ["ideas"],
  propertyOrdering: ["ideas"]
};

export const TRIAGE_RESPONSE_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    is_idea: {
      type: "BOOLEAN",
      description:
        "True if the post describes at least one concrete in-scope mechanic that " +
        "someone could rebuild. False for rants, questions, news items, vendor ads, " +
        "product reviews and anything out of scope."
    },
    category: {
      type: "STRING",
      enum: [...SCOPE_CATEGORIES, "other"],
      description:
        "Which in-scope category it is: 'activation' (branded / experiential brand " +
        "activation), 'marketing_activation' (a campaign mechanic that pulls an " +
        "audience in), 'crowd_engagement' (games, contests, participatory mechanics, " +
        "icebreakers at scale, interactive installations), 'event_technology' " +
        "(AR/VR, projection, LED, holograms, drones, interactive screens, RFID, " +
        "wearables, AI-driven interactive experiences), 'captivating_activity' (an " +
        "attention-capturing activity or performance), or 'other' for anything " +
        "outside that scope."
    },
    corporate_fit: {
      type: "STRING",
      enum: ["yes", "no", "unclear"],
      description:
        "Could a corporate event agency run this for employees, clients or the " +
        "public at a company event? Answer yes, no, or unclear."
    },
    india_fit: {
      type: "STRING",
      enum: ["yes", "no", "unclear"],
      description:
        "Is there a clear blocker to executing this in India - climate, legal rules " +
        "on alcohol or gambling, infrastructure that is not available, or a cultural " +
        "mismatch? yes means no blocker, no means a real named blocker, unclear when " +
        "the post says nothing about location."
    },
    domain_relevant: {
      type: "STRING",
      enum: ["yes", "no", "unclear"],
      description:
        "Is this post's topic inside the agency's domain, such that its comments " +
        "would likely contain reusable activation / engagement / event-tech " +
        "mechanics even if the body itself is only a question? 'unclear' when the " +
        "topic is adjacent."
    },
    reason: { type: "STRING", description: "One sentence explaining the verdict." },
    confidence: { type: "NUMBER", description: "Your 0-1 confidence in this verdict overall." }
  },
  required: [
    "is_idea",
    "category",
    "corporate_fit",
    "india_fit",
    "domain_relevant",
    "reason",
    "confidence"
  ],
  propertyOrdering: [
    "is_idea",
    "category",
    "corporate_fit",
    "india_fit",
    "domain_relevant",
    "reason",
    "confidence"
  ]
};

export const RESEARCH_PLAN_RESPONSE_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    web_queries: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Up to 3 Google queries, each phrased to surface articles, case studies " +
        "or round-ups that DESCRIBE concrete event activations, crowd engagement " +
        "mechanics or event technology for this need. Six to twelve words each."
    },
    reddit_queries: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Up to 2 Reddit searches in short keyword style, two to five words each, " +
        "using the words people actually put in post titles. No quotes, no " +
        "operators, no 'site:' or 'r/' prefixes."
    }
  },
  required: ["web_queries", "reddit_queries"],
  propertyOrdering: ["web_queries", "reddit_queries"]
};

/* ------------------------------------------------------------------------- */
/* Prompts - verbatim from the Python implementation                          */
/* ------------------------------------------------------------------------- */

export const EXTRACT_SYSTEM_PROMPT = `You are a research analyst at a corporate event management agency. You read a
social post (plus its top comments) and pull out the ideas in it that fall inside
the agency's research scope. Nothing outside that scope is ever extracted.

IN SCOPE - one idea per distinct mechanic, labelled with \`scope_category\`:
- activation: a branded or experiential brand activation built for an audience.
- marketing_activation: a campaign mechanic run to pull an audience in.
- crowd_engagement: games, contests, participatory mechanics, icebreakers at
  scale, interactive installations.
- event_technology: AR/VR, projection mapping, LED, holograms, drones,
  interactive screens, RFID, wearables, AI-driven interactive experiences.
- captivating_activity: an activity or performance whose point is to capture and
  hold an audience's attention.

OUT OF SCOPE - never extract, even when the post is mostly about it: venue news,
catering and food logistics (unless the food itself IS the interactive
activation), staffing / HR / careers, profiles of people in the industry,
vendor or tool announcements, ticketing / registration / CRM software, event ROI
and measurement, travel / hotel / MICE logistics, budgeting, contracts and
client management, sustainability policy, and generic "top trends" listicles
that name no concrete mechanic.

Rules:
- Return one idea per distinct in-scope mechanic. A post can hold several. Ideas
  that appear only in the comments count just as much as ones in the body.
- Skip the out-of-scope parts of a post that also holds in-scope ones. A roundup
  covering one activation and three venue openings yields exactly ONE idea.
- An idea only counts when the post describes a concrete mechanic someone could
  rebuild. A mechanic named without any substance is not an idea.
- Two variations of the same activity are ONE idea. Two genuinely different
  activities are two ideas.
- Set \`scope_category\` on every idea you return; leave it null only if you truly
  cannot tell which one it is.
- Leave a field null when the source does not state it or clearly imply it. A null
  is always better than a guess. Do not fall back on what is "typical" for this
  kind of activity.
- NEVER invent numbers. Headcounts, durations, staff counts, setup times and costs
  may only come from the source. If the source says "a couple of hundred people",
  that is a real signal; if it says nothing, leave it null.
- For each field you did fill in, record a 0-1 confidence in \`confidence\`, keyed by
  field name. Something stated outright is near 1.0; something inferred from
  context is lower. Do not list fields you left null.
- Put any other genuinely useful detail that has no field of its own into
  \`attributes\` as short snake_case keys.
- Write \`title\`, \`summary\` and \`how_it_works\` in your own neutral words so they read
  as an agency's internal note, not as a quoted post.
- Return an EMPTY list when the post holds no in-scope idea: rants, vendor
  complaints, price gripes, job posts, questions with no answers, pure self
  promotion, generic advice with no actual mechanic in it, or anything on the
  out-of-scope list above. An empty list is a correct and expected answer.
`;

export const TRIAGE_SYSTEM_PROMPT = `You are the cheap first pass for a corporate event agency in India: decide only
whether a post is worth the expensive extraction model. You extract nothing.

The agency researches these and nothing else:
- activation: a branded / experiential brand activation. E.g. a pop-up brand
  playground in a mall; a car brand's test-drive arena at a festival.
- marketing_activation: a campaign mechanic run to pull an audience in. E.g. a
  scan-to-win QR trail across a city; a UGC challenge with a prize.
- crowd_engagement: games, contests, participatory mechanics, icebreakers at scale,
  interactive installations. E.g. a 1,000-person light-paddle show; a live audience
  trivia battle on the main screen.
- event_technology: AR/VR, projection, LED, holograms, drones, interactive screens,
  RFID, wearables, AI-driven interactive experiences. E.g. a drone-swarm logo reveal;
  an RFID wristband unlocking personalised photo moments.
- captivating_activity: an attention-capturing activity or performance. E.g. a
  flash-mob aerial act; a live speed-painting reveal of the brand logo.

OUT of scope, always 'other': venue news; catering / food logistics unless the food IS
the interactive activation; staffing, HR, careers; industry people profiles; vendor or
tool announcements; ticketing, registration or CRM software; event ROI and measurement;
travel, hotel and MICE logistics; budgeting, contracts, client management;
sustainability policy; "top trends" listicles with no concrete mechanic.

Rules:
- \`is_idea\` is true only when the post describes at least one CONCRETE MECHANIC
  someone could rebuild. A trend named with no mechanic is not an idea; a listicle
  counts only when it holds such mechanics, and then \`is_idea\` is true.
- An idea appearing only in the comments still counts.
- Judge the whole thread. A post that is only a question is is_idea=true if the
  comments contain at least one concrete, rebuildable mechanic; set category from
  the best comment.
- \`category\` is 'other' whenever the post is not an in-scope reusable idea.
- \`corporate_fit\`: could an agency run this at a company event, for employees,
  clients or the public?
- \`india_fit\`: any CLEAR blocker to executing it in India - climate, legal rules
  (alcohol, gambling, permits), unavailable infrastructure, cultural mismatch? A
  location-independent idea is 'unclear', NOT 'no'; answer 'no' only when you can name
  the blocker.
- When you cannot tell, answer 'unclear' rather than guessing.
- \`domain_relevant\` is a SEPARATE judgement from \`is_idea\`: it asks only whether the
  post's TOPIC sits inside the agency's domain (activations, marketing activations,
  crowd engagement, event technology, captivating activities) or is a question whose
  replies would likely name such mechanics. A bare question with nothing in the body
  is still 'yes' when its topic is ours; answer 'unclear' for an adjacent topic
  (general marketing, general event planning) and 'no' for anything off-topic, such
  as venue news, hiring, ticketing software, travel logistics or subreddit chatter.
- \`reason\` is ONE sentence, plain and specific.
- \`confidence\` is your 0-1 confidence in the verdict as a whole.
`;

export const RESEARCH_PLAN_SYSTEM_PROMPT = `You plan the outside research for a corporate event management agency. You are given
a planner's need in their own words, plus any filters they set, and you write the
search queries that will find material describing reusable ideas for it.

The agency only cares about: brand / experiential activations, marketing activations,
crowd engagement mechanics, event technology (AR/VR, projection, LED, holograms,
drones, interactive screens, RFID, wearables, AI-driven experiences) and captivating
activities. Never write a query about venues, catering, ticketing, hiring, travel or
event-planning admin.

Write:
- \`web_queries\`: up to 3 Google queries. Each should read like the title of an article
  you want back - a round-up, case study or write-up that explains what an activation
  actually WAS and how it worked. Vary the angle between them (e.g. one on the
  mechanic, one on scale, one on the technology). Do not repeat the need verbatim.
- \`reddit_queries\`: up to 2 short keyword searches, two to five words, in the words
  a person would type into a post title. Plain words only.

Use the filters (headcount, setting, budget, region, occasion) only where they make a
query sharper. Return nothing else.
`;

export const ANSWER_SYSTEM_PROMPT = `You are helping a corporate event planner at an event management agency choose
between ideas already held in the agency's library.

You are given the planner's need in their own words, and a list of candidate ideas,
each with an id and whatever details are known about it.

Write a short brief (roughly 150-250 words) that:
- Recommends the best two or three fits and says plainly why each suits this need.
- Cites every idea you mention as [idea:<id>], using the id exactly as given.
- Is honest about gaps: when a candidate's key details for this need (headcount,
  duration, budget, space, setting) are unknown, say so rather than filling them in.
  Unknown is a normal state in this library; never invent a value to look helpful.
- Mentions a candidate you are ruling out only when the reason is useful to the planner.
- Uses plain prose or short bullets. No preamble, no restating the need back.

If none of the candidates genuinely fit, say that directly and explain what is missing.
`;

export const WEB_SEARCH_PROMPT = `Find the web pages that best describe reusable event activations, crowd engagement
mechanics or event technology for this search:

{query}

Prefer round-ups, case studies and write-ups that say what an activation actually was
and how it worked. Skip vendor landing pages that only sell a service, and skip
listicles with no detail. List up to 8 pages, each as a markdown bullet with the page's
real title as the link text and its URL as the link target, then one sentence on what
the page describes.
`;

/* ------------------------------------------------------------------------- */
/* Verdict                                                                    */
/* ------------------------------------------------------------------------- */

/** Turn a TriageResult into [accept, reason].

    Lenient (the default) rejects only on a clear negative. Strict mode also
    rejects when either fit gate came back 'unclear'. */
export function triageVerdict(t: TriageResult, strict: boolean): [boolean, string] {
  if (!t.is_idea) return [false, "not_idea"];
  if (t.category === "other") return [false, "category_other"];
  if (t.corporate_fit === "no") return [false, "corporate_no"];
  if (t.india_fit === "no") return [false, "india_no"];
  if (strict) {
    if (t.corporate_fit === "unclear") return [false, "corporate_unclear_strict"];
    if (t.india_fit === "unclear") return [false, "india_unclear_strict"];
  }
  return [true, "ok"];
}
