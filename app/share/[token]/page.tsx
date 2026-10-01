"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Wordmark from "../../components/Wordmark";
import MediaGallery, { type GalleryItem } from "../../components/MediaGallery";

/* The client gallery. The only screen a client ever sees, so it is deliberately
   thin: fetch what the token allows, wrap the masthead and footer around it,
   and hand the media to MediaGallery — the same component the photographer
   screen uses, so the two can never drift into showing different things.

   Everything specific to a client link stays here: the expiry countdown, the
   "link unavailable" state, and the fact that nothing identifies a viewer, so
   no tile is ever marked as anyone's. */

type Payload = {
  event: { name: string; company: string; fromDate: string; toDate: string };
  folder: string | null;
  expires: number;
  items: GalleryItem[];
};

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return iso;
  }
};

const fmtExpiry = (ms: number) => {
  try {
    return new Date(ms).toLocaleString("en-IN", {
      day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true
    });
  } catch {
    return "";
  }
};

const countdown = (ms: number) => {
  const left = ms - Date.now();
  if (left <= 0) return "expired";
  const hrs = Math.floor(left / 3_600_000);
  if (hrs >= 1) return `${hrs} hour${hrs !== 1 ? "s" : ""} remaining`;
  return `${Math.max(1, Math.floor(left / 60_000))} minutes remaining`;
};

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "This link is no longer available.");
        return body as Payload;
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    document.title = data ? `${data.event.name} — Velocity` : "Velocity";
  }, [data]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  /* Lazy signing for the in-browser ZIP: the token is the whole authorisation,
     so it goes back to the same endpoint that served the gallery. */
  const signIds = useCallback(
    async (ids: string[], signal: AbortSignal) => {
      const res = await fetch(`/api/share/${token}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
        signal
      });
      if (!res.ok) throw new Error(`Link server returned ${res.status}`);
      const body = await res.json();
      return (body.urls ?? {}) as Record<string, string>;
    },
    [token]
  );

  if (loading) {
    return (
      <div className="share-page">
        <div className="share-state"><Wordmark /><p className="muted">Opening gallery…</p></div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="share-page">
        <div className="share-state">
          <Wordmark />
          <h1>Link unavailable</h1>
          <p className="muted">{error || "This link is no longer available."}</p>
          <p className="muted">Gallery links expire after a set period. Please ask your Velocity contact for a fresh link.</p>
        </div>
      </div>
    );
  }

  const expired = data.expires <= Date.now();
  const sameDay = fmtDate(data.event.fromDate) === fmtDate(data.event.toDate);

  return (
    <div className="share-page">
      <header className="share-masthead">
        <Wordmark />
        <span className="share-masthead-label">Event gallery</span>
      </header>

      <main className="share-main">
        <MediaGallery
          items={data.items}
          zipName={data.event.name}
          signIds={signIds}
          emptyMessage="Nothing has been added to this gallery yet."
          header={
            <div className="share-head">
              <span className="share-eyebrow">{data.event.company}</span>
              <h1>{data.event.name}</h1>
              <p className="share-dates">
                {sameDay ? fmtDate(data.event.fromDate) : `${fmtDate(data.event.fromDate)} — ${fmtDate(data.event.toDate)}`}
                {data.folder ? ` · ${data.folder}` : ""}
              </p>
            </div>
          }
          notice={
            <div className={`share-notice${expired ? " share-notice-expired" : ""}`} key={tick}>
              <span>
                {expired ? "This gallery has expired." : `Available until ${fmtExpiry(data.expires)} · ${countdown(data.expires)}`}
              </span>
              <span className="share-notice-sub">
                {data.items.length} file{data.items.length !== 1 ? "s" : ""} · tick any item to download a selection, or use Download all
              </span>
            </div>
          }
        />
      </main>

      <footer className="share-foot">
        <span>Velocity Brand Server Pvt. Ltd.</span>
        <span>contact@velocityindia.net · +91 93197 13708</span>
      </footer>
    </div>
  );
}
