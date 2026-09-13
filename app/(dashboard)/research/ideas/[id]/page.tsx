"use client";

import { use, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  BUDGET_BANDS,
  INTERACTION_MODES,
  PHYSICAL_INTENSITIES,
  SCOPE_CATEGORIES,
  SETTINGS,
  categoryStyle,
  confidencePercent,
  dash,
  day,
  humanise,
  minutes,
  type Idea
} from "../../../../components/research/format";

/* One idea, in full, plus the two things staff can do to it: correct a field and
   decide whether it stays in the library.

   Everything on this page has to survive an idea where every single field is
   null - that is not an edge case here, it is the common case early on. An
   unknown field is shown greyed with an em dash rather than hidden, so the
   reader can tell "nobody wrote this down" apart from "this idea has no
   audience size".

   A correction is the one value in the library that did not come from a model,
   so the API stamps it at 100% confidence and re-embeds the idea; the hint by
   the Save button says so, because otherwise a correction looks cosmetic. */

type SourceRow = {
  postId: string;
  kind: string;
  title: string | null;
  url: string | null;
  author: string | null;
  postedAt: string | null;
  extractionIndex: number;
};

type IdeaDetail = Idea & { sources: SourceRow[] };

type FieldKind = "text" | "textarea" | "number" | "enum" | "list" | "bool";

type FieldDef = {
  field: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
};

/* Same order as lib/research/serialize.ts IDEA_FIELDS, so the form reads like
   the detail view above it. */
const EDIT_FIELDS: FieldDef[] = [
  { field: "scopeCategory", label: "Category", kind: "enum", options: SCOPE_CATEGORIES },
  { field: "title", label: "Title", kind: "text" },
  { field: "summary", label: "Summary", kind: "textarea" },
  { field: "howItWorks", label: "How it works", kind: "textarea" },
  { field: "eventTypes", label: "Event types", kind: "list" },
  { field: "formats", label: "Formats", kind: "list" },
  { field: "interactionMode", label: "Interaction mode", kind: "enum", options: INTERACTION_MODES },
  { field: "audienceMin", label: "Audience min", kind: "number" },
  { field: "audienceMax", label: "Audience max", kind: "number" },
  { field: "minutesPerParticipant", label: "Minutes per participant", kind: "number" },
  { field: "totalDurationMinutes", label: "Total duration (minutes)", kind: "number" },
  { field: "setting", label: "Setting", kind: "enum", options: SETTINGS },
  { field: "spaceRequirements", label: "Space requirements", kind: "textarea" },
  { field: "techRequirements", label: "Tech requirements", kind: "textarea" },
  { field: "staffing", label: "Staffing", kind: "textarea" },
  { field: "staffCount", label: "Staff count", kind: "number" },
  { field: "setupTimeMinutes", label: "Setup time (minutes)", kind: "number" },
  { field: "materials", label: "Materials", kind: "textarea" },
  { field: "budgetBand", label: "Budget band", kind: "enum", options: BUDGET_BANDS },
  { field: "budgetNotes", label: "Budget notes", kind: "textarea" },
  { field: "audienceTypes", label: "Audience types", kind: "list" },
  { field: "ageGroup", label: "Age group", kind: "text" },
  { field: "brandable", label: "Brandable", kind: "bool" },
  { field: "physicalIntensity", label: "Physical intensity", kind: "enum", options: PHYSICAL_INTENSITIES },
  { field: "region", label: "Region", kind: "text" },
  { field: "occasion", label: "Occasion", kind: "text" },
  { field: "tags", label: "Tags", kind: "list" }
];

const read = (idea: Idea, field: string): unknown =>
  (idea as unknown as Record<string, unknown>)[field];

/** Current value of a field as the form would hold it: a string, always. */
function toInput(idea: Idea, def: FieldDef): string {
  const value = read(idea, def.field);
  if (value === null || value === undefined) return "";
  if (def.kind === "list") return Array.isArray(value) ? value.join(", ") : "";
  if (def.kind === "bool") return value === true ? "true" : value === false ? "false" : "";
  return String(value);
}

/** A form string back to what the API expects, or null when it was emptied. */
function fromInput(def: FieldDef, raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (def.kind === "number") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (def.kind === "bool") return trimmed === "true";
  if (def.kind === "list") {
    const parts = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length ? parts : null;
  }
  return trimmed;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const buildForm = (idea: Idea): Record<string, string> => {
  const form: Record<string, string> = {};
  for (const def of EDIT_FIELDS) form[def.field] = toInput(idea, def);
  return form;
};

/* ── Detail rendering ── */

function Entry({
  label,
  field,
  value,
  confidence
}: {
  label: string;
  field: string;
  value: string | null;
  confidence: Record<string, number>;
}) {
  const percent = value ? confidencePercent(confidence, field) : null;
  return (
    <div>
      <span className="rs-dt">
        {label}
        {percent ? <span className="rs-conf">{percent}</span> : null}
      </span>
      {value ? (
        <span className="rs-dd">{value}</span>
      ) : (
        <span className="rs-dd unknown">—</span>
      )}
    </div>
  );
}

const text = (value: string | null | undefined): string | null => (value && value.trim() ? value : null);
const list = (value: string[] | null | undefined): string | null =>
  value && value.length ? value.join(", ") : null;
const num = (value: number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rs-group">
      <h3>{title}</h3>
      <div className="rs-dl">{children}</div>
    </div>
  );
}

/* ── Page ── */

export default function IdeaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [idea, setIdea] = useState<Idea | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [back, setBack] = useState<{ href: string; label: string }>({
    href: "/research",
    label: "← Back to research"
  });

  /* The back link restores the browse filters the reader arrived with, so it is
     read from the querystring rather than from useSearchParams (which would
     force a Suspense boundary around this page). */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    params.delete("from");
    const rest = params.toString();
    if (from === "browse") {
      setBack({ href: rest ? `/research/browse?${rest}` : "/research/browse", label: "← Back to browse" });
    } else if (from === "search") {
      setBack({ href: "/research", label: "← Back to search" });
    }
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/research/ideas/${id}`)
      .then(async (response) => {
        if (response.status === 404) throw new Error("That idea is not in the library.");
        if (!response.ok) throw new Error(`The library did not answer (${response.status}).`);
        return (await response.json()) as IdeaDetail;
      })
      .then((payload) => {
        if (!live) return;
        const { sources: rows, ...rest } = payload;
        setIdea(rest as Idea);
        setSources(rows ?? []);
        setForm(buildForm(rest as Idea));
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : "Could not load this idea.");
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id]);

  const patch = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      setSaving(true);
      setSaveError(null);
      setSaved(null);
      try {
        const response = await fetch(`/api/research/ideas/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(detail || `The change was not saved (${response.status}).`);
        }
        const updated = (await response.json()) as Idea;
        setIdea(updated);
        setForm(buildForm(updated));
        setSaved("Saved.");
        return true;
      } catch (cause: unknown) {
        setSaveError(cause instanceof Error ? cause.message : "The change was not saved.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [id]
  );

  const save = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!idea) return;
      /* Only what actually changed: a full payload would stamp every field as
         staff-confirmed at 100%, including ones nobody looked at. */
      const body: Record<string, unknown> = {};
      for (const def of EDIT_FIELDS) {
        const next = fromInput(def, form[def.field] ?? "");
        if (!sameValue(next, read(idea, def.field))) body[def.field] = next;
      }
      if (!Object.keys(body).length) {
        setSaveError(null);
        setSaved("Nothing changed.");
        return;
      }
      await patch(body);
    },
    [idea, form, patch]
  );

  const attributeKeys = useMemo(
    () => (idea?.attributes ? Object.keys(idea.attributes).sort() : []),
    [idea]
  );

  if (loading) {
    return (
      <>
        <section className="page-header">
          <div className="skeleton skeleton-text medium" style={{ height: 26, width: 320 }} />
        </section>
        <div className="panel">
          <div className="skeleton skeleton-text long" />
          <div className="skeleton skeleton-text long" />
          <div className="skeleton skeleton-text medium" />
          <div className="skeleton skeleton-text short" />
        </div>
      </>
    );
  }

  if (error || !idea) {
    return (
      <>
        <section className="page-header">
          <div>
            <Link className="muted hover-text" href={back.href}>
              {back.label}
            </Link>
            <h1>Idea</h1>
          </div>
        </section>
        <p className="rs-error">{error ?? "Could not load this idea."}</p>
      </>
    );
  }

  const confidence = idea.confidence ?? {};
  const seen = idea.sourceCount ?? 0;

  return (
    <>
      <section className="page-header">
        <div>
          <Link className="muted hover-text" href={back.href}>
            {back.label}
          </Link>
          <h1 style={{ marginTop: 8 }}>{idea.title || "Untitled idea"}</h1>
          <div className="rs-chips">
            {idea.scopeCategory ? (
              <span className="rs-chip category" style={categoryStyle(idea.scopeCategory)}>
                {humanise(idea.scopeCategory)}
              </span>
            ) : (
              <span className="rs-chip unknown">category unknown</span>
            )}
            <span className={`status-pill ${idea.status === "active" ? "active" : "inactive"}`}>
              {humanise(idea.status) || idea.status}
            </span>
            {seen > 1 ? <span className="rs-chip seen">seen {seen}×</span> : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Details</h2>
        </div>
        <div className="panel-body">
          <Group title="What it is">
            <Entry label="Summary" field="summary" value={text(idea.summary)} confidence={confidence} />
            <Entry label="How it works" field="howItWorks" value={text(idea.howItWorks)} confidence={confidence} />
            <Entry label="Event types" field="eventTypes" value={list(idea.eventTypes)} confidence={confidence} />
            <Entry label="Formats" field="formats" value={list(idea.formats)} confidence={confidence} />
            <Entry label="Occasion" field="occasion" value={text(idea.occasion)} confidence={confidence} />
          </Group>

          <Group title="Audience">
            <Entry
              label="Interaction mode"
              field="interactionMode"
              value={idea.interactionMode ? humanise(idea.interactionMode) : null}
              confidence={confidence}
            />
            <Entry label="Audience min" field="audienceMin" value={num(idea.audienceMin)} confidence={confidence} />
            <Entry label="Audience max" field="audienceMax" value={num(idea.audienceMax)} confidence={confidence} />
            <Entry
              label="Audience types"
              field="audienceTypes"
              value={list(idea.audienceTypes)}
              confidence={confidence}
            />
            <Entry label="Age group" field="ageGroup" value={text(idea.ageGroup)} confidence={confidence} />
            <Entry
              label="Physical intensity"
              field="physicalIntensity"
              value={idea.physicalIntensity ? humanise(idea.physicalIntensity) : null}
              confidence={confidence}
            />
          </Group>

          <Group title="Time">
            <Entry
              label="Minutes per participant"
              field="minutesPerParticipant"
              value={minutes(idea.minutesPerParticipant)}
              confidence={confidence}
            />
            <Entry
              label="Total duration"
              field="totalDurationMinutes"
              value={minutes(idea.totalDurationMinutes)}
              confidence={confidence}
            />
            <Entry
              label="Setup time"
              field="setupTimeMinutes"
              value={minutes(idea.setupTimeMinutes)}
              confidence={confidence}
            />
          </Group>

          <Group title="Space & kit">
            <Entry
              label="Setting"
              field="setting"
              value={idea.setting ? humanise(idea.setting) : null}
              confidence={confidence}
            />
            <Entry
              label="Space requirements"
              field="spaceRequirements"
              value={text(idea.spaceRequirements)}
              confidence={confidence}
            />
            <Entry
              label="Tech requirements"
              field="techRequirements"
              value={text(idea.techRequirements)}
              confidence={confidence}
            />
            <Entry label="Materials" field="materials" value={text(idea.materials)} confidence={confidence} />
          </Group>

          <Group title="People & money">
            <Entry label="Staffing" field="staffing" value={text(idea.staffing)} confidence={confidence} />
            <Entry label="Staff count" field="staffCount" value={num(idea.staffCount)} confidence={confidence} />
            <Entry
              label="Budget band"
              field="budgetBand"
              value={idea.budgetBand ? humanise(idea.budgetBand) : null}
              confidence={confidence}
            />
            <Entry label="Budget notes" field="budgetNotes" value={text(idea.budgetNotes)} confidence={confidence} />
          </Group>

          <Group title="Other">
            <Entry
              label="Brandable"
              field="brandable"
              value={idea.brandable === null || idea.brandable === undefined ? null : dash(idea.brandable)}
              confidence={confidence}
            />
            <Entry label="Region" field="region" value={text(idea.region)} confidence={confidence} />
            <Entry label="Tags" field="tags" value={list(idea.tags)} confidence={confidence} />
            {attributeKeys.map((key) => (
              <Entry
                key={key}
                label={humanise(key)}
                field={`attributes.${key}`}
                value={(() => {
                  const rendered = dash(idea.attributes[key]);
                  return rendered === "—" ? null : rendered;
                })()}
                confidence={confidence}
              />
            ))}
          </Group>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Where it came from</h2>
        </div>
        <div className="panel-body">
          {sources.length ? (
            <div className="table-wrap">
              <table className="claims-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Kind</th>
                    <th>Author</th>
                    <th>Posted</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => (
                    <tr key={`${source.postId}-${source.extractionIndex}`}>
                      <td>
                        {source.url ? (
                          <a href={source.url} target="_blank" rel="noopener noreferrer" className="hover-text">
                            {source.title || source.url} ↗
                          </a>
                        ) : (
                          source.title || <span className="muted">untitled</span>
                        )}
                      </td>
                      <td>{humanise(source.kind) || "—"}</td>
                      <td>{dash(source.author)}</td>
                      <td>{day(source.postedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">No source post is linked to this idea.</div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Correct this idea</h2>
        </div>
        <div className="panel-body">
          <p className="rs-hint">
            A field you edit here is recorded as staff-confirmed at 100% confidence and the idea is
            re-embedded, so search matches the corrected wording.
          </p>

          {saveError ? (
            <p className="rs-error" style={{ marginTop: 12 }}>
              {saveError}
            </p>
          ) : null}
          {saved ? (
            <p className="muted" style={{ marginTop: 12 }}>
              {saved}
            </p>
          ) : null}

          <form onSubmit={save}>
            <div className="rs-filter-grid">
              {EDIT_FIELDS.map((def) => {
                const value = form[def.field] ?? "";
                const onChange = (next: string) =>
                  setForm((current) => ({ ...current, [def.field]: next }));
                return (
                  <div key={def.field} style={def.kind === "textarea" ? { gridColumn: "1 / -1" } : undefined}>
                    <span className="rs-dt">{def.label}</span>
                    {def.kind === "textarea" ? (
                      <textarea
                        className="input textarea"
                        rows={3}
                        value={value}
                        onChange={(event) => onChange(event.target.value)}
                      />
                    ) : def.kind === "enum" ? (
                      <select
                        className="input"
                        value={value}
                        onChange={(event) => onChange(event.target.value)}
                      >
                        <option value="">—</option>
                        {(def.options ?? []).map((option) => (
                          <option key={option} value={option}>
                            {humanise(option)}
                          </option>
                        ))}
                      </select>
                    ) : def.kind === "bool" ? (
                      <select
                        className="input"
                        value={value}
                        onChange={(event) => onChange(event.target.value)}
                      >
                        <option value="">Any</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : def.kind === "number" ? (
                      <input
                        className="input"
                        type="number"
                        value={value}
                        onChange={(event) => onChange(event.target.value)}
                      />
                    ) : (
                      <input
                        className="input"
                        type="text"
                        value={value}
                        placeholder={def.kind === "list" ? "comma, separated, values" : undefined}
                        onChange={(event) => onChange(event.target.value)}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="rs-search-row">
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Saving…" : "Save corrections"}
              </button>
              <button
                type="button"
                className="link-button hover-text"
                onClick={() => {
                  setForm(buildForm(idea));
                  setSaved(null);
                  setSaveError(null);
                }}
                disabled={saving}
              >
                Undo my edits
              </button>
            </div>
          </form>

          <div className="rs-narrow">
            <div className="rs-search-row" style={{ marginTop: 0 }}>
              <button
                type="button"
                className="btn-outline hover-text"
                disabled={saving || idea.status === "active"}
                onClick={() => void patch({ status: "active" })}
              >
                Keep active
              </button>
              <button
                type="button"
                className="btn-outline hover-text"
                disabled={saving || idea.status === "rejected"}
                onClick={() => void patch({ status: "rejected" })}
              >
                Reject
              </button>
            </div>
            <p className="rs-hint" style={{ marginTop: 10 }}>
              Rejecting drops the idea out of search and browse. Nothing is deleted — the source posts
              it came from stay linked, and it can be made active again from here.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
