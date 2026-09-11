"use client";

import { useEffect, useRef, useState } from "react";

/* The staff clip inbox.

   A clip is the one way into the pipeline that a person drives by hand, so the
   screen is deliberately small: four fields, one button, and a bookmarklet for
   the times someone is already looking at the thing they want to keep.

   The query string is read from window.location rather than useSearchParams on
   purpose — the hook forces a Suspense boundary around the whole page, which is
   more machinery than a prefill is worth. */

type ClipResponse = {
  id: string | null;
  externalId: string;
  status: string;
  duplicate: boolean;
};

type Form = { url: string; text: string; title: string; note: string };

const EMPTY: Form = { url: "", text: "", title: "", note: "" };

/** The bookmarklet, as one line, with the ERP's own origin baked in so it works
    the same from a dev server and from production. */
const bookmarkletFor = (origin: string) =>
  `javascript:(function(){var u=encodeURIComponent(location.href);var t=encodeURIComponent(String(window.getSelection()||''));window.open('${origin}/research/clip?url='+u+'&text='+t,'_blank');})();`;

export default function ClipPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ClipResponse | null>(null);
  const [bookmarklet, setBookmarklet] = useState("");
  const bookmarkRef = useRef<HTMLAnchorElement | null>(null);

  /* Prefill from ?url=&text=&title=&note= — what the bookmarklet sends. */
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const seeded: Form = {
        url: params.get("url") ?? "",
        text: params.get("text") ?? "",
        title: params.get("title") ?? "",
        note: params.get("note") ?? ""
      };
      if (seeded.url || seeded.text || seeded.title || seeded.note) setForm(seeded);
      setBookmarklet(bookmarkletFor(window.location.origin));
    } catch {
      /* A malformed query string is not worth failing the page over. */
    }
  }, []);

  /* React refuses to render a javascript: href, so the anchor gets its href the
     long way round once the origin is known. */
  useEffect(() => {
    if (bookmarklet && bookmarkRef.current) {
      bookmarkRef.current.setAttribute("href", bookmarklet);
    }
  }, [bookmarklet]);

  const set = (key: keyof Form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    if (!form.url.trim() && !form.text.trim()) {
      setError("Give it a link or some text — one of the two is enough.");
      return;
    }
    setError(null);
    setPosting(true);
    try {
      const response = await fetch("/api/research/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: form.url.trim() || null,
          text: form.text.trim() || null,
          title: form.title.trim() || null,
          note: form.note.trim() || null
        })
      });
      const payload = (await response.json().catch(() => null)) as
        | (ClipResponse & { error?: string })
        | null;
      if (!response.ok) {
        setError(payload?.error || `The clip was not accepted (${response.status}).`);
        return;
      }
      if (!payload) {
        setError("The server answered with something that was not a clip.");
        return;
      }
      setDone(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the pipeline.");
    } finally {
      setPosting(false);
    }
  };

  const again = () => {
    setDone(null);
    setError(null);
    setForm(EMPTY);
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Clip something in</h1>
          <p>
            Paste a link or a snippet you saw and the pipeline will read it. A clip skips triage —
            you already decided it was worth a look — but is extracted, embedded and deduplicated
            like everything else.
          </p>
        </div>
      </section>

      {done ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Queued.</h2>
          </div>
          <div className="panel-body">
            <p className="rs-hint">
              Post id <code>{done.id ?? done.externalId}</code>. The next tick will pick it up,
              usually within a minute.
            </p>
            {done.duplicate && (
              <p className="rs-hint" style={{ marginTop: 8 }}>
                We already had this one; it was not queued twice.
              </p>
            )}
            <div style={{ marginTop: 14 }}>
              <button className="link-button hover-text" type="button" onClick={again}>
                Clip another
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-body">
            {error && <p className="rs-error">{error}</p>}

            <label className="auth-label">Link</label>
            <input
              className="input"
              value={form.url}
              onChange={(e) => set("url")(e.target.value)}
              placeholder="https://…"
            />

            <label className="auth-label">Text</label>
            <textarea
              className="input textarea"
              rows={7}
              value={form.text}
              onChange={(e) => set("text")(e.target.value)}
              placeholder="or paste the text itself"
            />

            <label className="auth-label">Title</label>
            <input
              className="input"
              value={form.title}
              onChange={(e) => set("title")(e.target.value)}
              placeholder="optional"
            />

            <label className="auth-label">Note</label>
            <input
              className="input"
              value={form.note}
              onChange={(e) => set("note")(e.target.value)}
              placeholder="why this is interesting — optional"
            />

            <div style={{ marginTop: 16 }}>
              <button className="btn-primary" type="button" onClick={submit} disabled={posting}>
                {posting ? "Sending…" : "Send to the pipeline"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-header">
          <h2>Bookmarklet</h2>
        </div>
        <div className="panel-body">
          <p className="rs-hint">
            Drag this to your bookmarks bar. On any page, select the bit that caught your eye and
            click it — this form opens with the page URL and your selection already filled in.
          </p>
          <p style={{ marginTop: 12 }}>
            <a
              ref={bookmarkRef}
              href="#"
              className="btn-outline hover-text"
              onClick={(e) => e.preventDefault()}
            >
              Clip to Vel
            </a>
            <span className="rs-hint" style={{ marginLeft: 10 }}>
              ← drag me
            </span>
          </p>
          <p className="rs-hint" style={{ marginTop: 12 }}>
            Or copy it by hand:
          </p>
          <code
            style={{
              display: "block",
              marginTop: 6,
              padding: "10px 12px",
              fontSize: 11.5,
              lineHeight: 1.5,
              wordBreak: "break-all",
              background: "var(--gray-100)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r)"
            }}
          >
            {bookmarklet || "…"}
          </code>
        </div>
      </section>
    </>
  );
}
