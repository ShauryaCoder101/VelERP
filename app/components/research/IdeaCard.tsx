"use client";

import Link from "next/link";
import {
  audienceRange,
  categoryStyle,
  humanise,
  minutes,
  type Hit,
  type Idea,
  type SourceLink
} from "./format";

/* One idea, as it appears in search results, the browse grid and a research
   panel. Shared so those three never drift apart on what a card says.

   A chip is either a value or a greyed "<field> unknown" — never absent. The
   sources leave most fields empty, and a card that silently dropped them would
   read as if the idea had no audience size rather than as if nobody wrote one
   down. */

type Props = {
  idea: Idea;
  /** Search and research results carry a similarity; browse does not. */
  hit?: Hit | null;
  source?: SourceLink | null;
  /** Browse leads with the category pill instead of a similarity bar. */
  categoryFirst?: boolean;
  badge?: string | null;
  /** Appended to the detail link so "back" can return to these exact filters. */
  linkQuery?: string;
};

function Chip({ label, value, unknownLabel }: { label: string; value: string | null; unknownLabel: string }) {
  if (!value) {
    return (
      <span className="rs-chip unknown" title={`${label}: the sources never said`}>
        {unknownLabel} unknown
      </span>
    );
  }
  return (
    <span className="rs-chip" title={label}>
      {value}
    </span>
  );
}

export default function IdeaCard({
  idea,
  hit = null,
  source = null,
  categoryFirst = false,
  badge = null,
  linkQuery = ""
}: Props) {
  const href = `/research/ideas/${idea.id}${linkQuery}`;
  const percent = hit ? Math.floor(hit.similarity * 100) : 0;
  const seen = idea.sourceCount ?? 0;

  return (
    <li className="rs-card">
      <div className="rs-card-head">
        <span className="rs-card-head-main">
          <Link className="rs-card-title" href={href}>
            {idea.title || "Untitled idea"}
          </Link>
          {badge ? <span className="rs-badge-new">{badge}</span> : null}
        </span>

        {hit ? (
          <span className="rs-sim" title={`Cosine similarity to the need: ${hit.similarity.toFixed(3)}`}>
            <span className="rs-sim-bar">
              <i style={{ width: `${percent}%` }} />
            </span>
            <span className="rs-sim-num">{percent}</span>
          </span>
        ) : categoryFirst ? (
          idea.scopeCategory ? (
            <span className="rs-chip category" style={categoryStyle(idea.scopeCategory)} title="Scope category">
              {humanise(idea.scopeCategory)}
            </span>
          ) : (
            <span className="rs-chip unknown" title="Scope category: the sources never said">
              category unknown
            </span>
          )
        ) : null}
      </div>

      <p className="rs-card-summary">{idea.summary || "No summary was recorded for this idea."}</p>

      <div className="rs-chips">
        {!categoryFirst ? (
          <Chip
            label="Scope category"
            value={idea.scopeCategory ? humanise(idea.scopeCategory) : null}
            unknownLabel="category"
          />
        ) : null}
        <Chip
          label="Interaction mode"
          value={idea.interactionMode ? humanise(idea.interactionMode) : null}
          unknownLabel="interaction"
        />
        <Chip label="Audience" value={audienceRange(idea.audienceMin, idea.audienceMax)} unknownLabel="size" />
        <Chip
          label="Minutes per participant"
          value={minutes(idea.minutesPerParticipant) ? `${minutes(idea.minutesPerParticipant)} each` : null}
          unknownLabel="per person"
        />
        <Chip label="Total duration" value={minutes(idea.totalDurationMinutes)} unknownLabel="duration" />
        <Chip label="Setting" value={idea.setting ? humanise(idea.setting) : null} unknownLabel="setting" />
        <Chip label="Budget band" value={idea.budgetBand ? humanise(idea.budgetBand) : null} unknownLabel="budget" />
        {seen > 1 ? (
          <span className="rs-chip seen" title={`Seen in ${seen} separate sources`}>
            seen {seen}×
          </span>
        ) : null}
      </div>

      <div className="rs-card-foot">
        <Link href={href}>Details</Link>
        {source?.url ? (
          <>
            <span className="sep">·</span>
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              Original {source.kind} post ↗
            </a>
          </>
        ) : null}
        {hit?.unknownFields?.length ? (
          <>
            <span className="sep">·</span>
            <span className="muted">unknown here: {hit.unknownFields.join(", ")}</span>
          </>
        ) : null}
      </div>
    </li>
  );
}
