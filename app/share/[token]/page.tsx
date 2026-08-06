"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Wordmark from "../../components/Wordmark";

type Item = {
  id: string;
  name: string;
  fileType: string;
  folder: string;
  thumb: string | null;
  preview: string | null;
  original: string | null;
  download: string | null;
  archived: boolean;
};

type Payload = {
  event: { name: string; company: string; fromDate: string; toDate: string };
  folder: string | null;
  expires: number;
  items: Item[];
};

type Tab = "photos" | "videos" | "folders";

const isImage = (t: string) => t.startsWith("image/");
const isVideo = (t: string) => t.startsWith("video/");

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<Item | null>(null);
  const [tick, setTick] = useState(0);

  const [tab, setTab] = useState<Tab | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dl, setDl] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useRef(false);

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

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setActive(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  const photos = useMemo(() => data?.items.filter((i) => isImage(i.fileType)) ?? [], [data]);
  const videos = useMemo(() => data?.items.filter((i) => isVideo(i.fileType)) ?? [], [data]);

  /* Folder structure is recovered from the storage key, so a folder that was
     dragged in as "Day 1/Stage" shows up under exactly that path. */
  const folders = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const item of data?.items ?? []) {
      if (!item.folder) continue;
      const list = map.get(item.folder);
      if (list) list.push(item);
      else map.set(item.folder, [item]);
    }
    return [...map.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const looseFiles = useMemo(() => data?.items.filter((i) => !i.folder) ?? [], [data]);
  const filesInFolders = folders.reduce((n, f) => n + f.items.length, 0);

  /* Open on whichever view holds the most, so a video-heavy delivery doesn't
     land the client on an near-empty Photos tab. */
  useEffect(() => {
    if (!data || tab) return;
    const ranked: [Tab, number][] = [
      ["folders", filesInFolders],
      ["photos", photos.length],
      ["videos", videos.length]
    ];
    ranked.sort((a, b) => b[1] - a[1]);
    setTab(ranked[0][1] > 0 ? ranked[0][0] : "photos");
  }, [data, tab, photos.length, videos.length, filesInFolders]);

  /* What the toolbar acts on. On the folders overview that is the whole
     delivery, not just the loose files — "Download all" from the top level
     has to mean all of it. */
  const scope = useMemo(() => {
    if (tab === "photos") return photos;
    if (tab === "videos") return videos;
    if (openFolder) return folders.find((f) => f.name === openFolder)?.items ?? [];
    return data?.items ?? [];
  }, [tab, photos, videos, openFolder, folders, data]);

  // What is actually laid out as tiles in the current view.
  const visible = useMemo(() => {
    if (tab === "folders" && !openFolder) return looseFiles;
    return scope;
  }, [tab, openFolder, looseFiles, scope]);

  const downloadable = scope.filter((i) => i.download);
  const selectedItems = (data?.items ?? []).filter((i) => selected.has(i.id) && i.download);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = downloadable.every((i) => next.has(i.id));
      for (const i of downloadable) allOn ? next.delete(i.id) : next.add(i.id);
      return next;
    });

  /* Browsers will not stream a 300GB zip, and building one server-side would
     both time out and double the egress. So downloads are triggered one file
     at a time, in a queue the client can watch and stop. */
  const runDownloads = useCallback(async (items: Item[]) => {
    const queue = items.filter((i) => i.download);
    if (queue.length === 0) return;
    cancelRef.current = false;
    setDl({ done: 0, total: queue.length });

    for (let i = 0; i < queue.length; i++) {
      if (cancelRef.current) break;
      const a = document.createElement("a");
      a.href = queue[i].download!;
      a.download = queue[i].name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setDl({ done: i + 1, total: queue.length });
      await sleep(queue.length > 1 ? 900 : 0);
    }
    setTimeout(() => setDl(null), 2500);
  }, []);

  const copyLinks = async (items: Item[]) => {
    const text = items.filter((i) => i.download).map((i) => i.download).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setDl({ done: -1, total: items.length });
      setTimeout(() => setDl(null), 2500);
    } catch {
      /* clipboard blocked; nothing useful to say */
    }
  };

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
  const allVisibleSelected = downloadable.length > 0 && downloadable.every((i) => selected.has(i.id));

  const tile = (item: Item) => {
    const checked = selected.has(item.id);
    return (
      <figure key={item.id} className={`share-tile${checked ? " share-tile-selected" : ""}`}>
        <div className="share-tile-frame">
          <button type="button" className="share-tile-btn" onClick={() => setActive(item)}>
            {item.thumb ? (
              <img
                src={item.thumb}
                alt={item.name}
                loading="lazy"
                onError={(e) => {
                  const img = e.currentTarget;
                  if (item.original && img.src !== item.original) img.src = item.original;
                }}
              />
            ) : item.original && isImage(item.fileType) ? (
              <img src={item.original} alt={item.name} loading="lazy" />
            ) : (
              <span className="share-tile-fallback">{isVideo(item.fileType) ? "Video" : "File"}</span>
            )}
            {isVideo(item.fileType) && (
              <span className="share-play" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              </span>
            )}
          </button>

          {item.download ? (
            <label className="share-check" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={checked} onChange={() => toggle(item.id)} aria-label={`Select ${item.name}`} />
            </label>
          ) : (
            <span className="share-tile-cold" title="Original is in long-term storage">Archived</span>
          )}
        </div>
        <figcaption className="share-tile-name">{item.name}</figcaption>
      </figure>
    );
  };

  return (
    <div className="share-page">
      <header className="share-masthead">
        <Wordmark />
        <span className="share-masthead-label">Event gallery</span>
      </header>

      <main className="share-main">
        <div className="share-head">
          <span className="share-eyebrow">{data.event.company}</span>
          <h1>{data.event.name}</h1>
          <p className="share-dates">
            {sameDay ? fmtDate(data.event.fromDate) : `${fmtDate(data.event.fromDate)} — ${fmtDate(data.event.toDate)}`}
            {data.folder ? ` · ${data.folder}` : ""}
          </p>
        </div>

        <div className={`share-notice${expired ? " share-notice-expired" : ""}`} key={tick}>
          <span>
            {expired ? "This gallery has expired." : `Available until ${fmtExpiry(data.expires)} · ${countdown(data.expires)}`}
          </span>
          <span className="share-notice-sub">
            {data.items.length} file{data.items.length !== 1 ? "s" : ""} · tick any item to download a selection, or use Download all
          </span>
        </div>

        {data.items.length === 0 ? (
          <div className="empty-state">Nothing has been added to this gallery yet.</div>
        ) : (
          <>
            <nav className="share-tabs">
              {([
                ["photos", "Photos", photos.length],
                ["videos", "Videos", videos.length],
                ["folders", "Folders", folders.length]
              ] as [Tab, string, number][]).map(([id, label, n]) => (
                <button
                  key={id}
                  type="button"
                  className={`share-tab${tab === id ? " share-tab-active" : ""}`}
                  onClick={() => { setTab(id); setOpenFolder(null); }}
                  disabled={n === 0}
                >
                  {label} <span className="share-tab-count">{n}</span>
                </button>
              ))}
            </nav>

            <div className="share-toolbar">
              <label className="share-selectall">
                <input type="checkbox" checked={allVisibleSelected} onChange={selectAllVisible} disabled={downloadable.length === 0} />
                <span>
                  {allVisibleSelected
                    ? "Clear selection"
                    : tab === "folders" && !openFolder
                      ? `Select all ${downloadable.length} files`
                      : "Select all shown"}
                </span>
              </label>

              <span className="share-toolbar-status">
                {dl
                  ? dl.done === -1
                    ? `${dl.total} link${dl.total !== 1 ? "s" : ""} copied`
                    : `Downloading ${dl.done} of ${dl.total}…`
                  : selected.size > 0
                    ? `${selected.size} selected`
                    : `${downloadable.length} downloadable`}
              </span>

              <span className="share-toolbar-actions">
                {dl && dl.done >= 0 && dl.done < dl.total && (
                  <button className="btn-outline" type="button" onClick={() => { cancelRef.current = true; }}>Stop</button>
                )}
                <button
                  className="btn-outline"
                  type="button"
                  disabled={selectedItems.length === 0}
                  onClick={() => copyLinks(selectedItems)}
                >
                  Copy links
                </button>
                <button
                  className="btn-outline"
                  type="button"
                  disabled={selectedItems.length === 0 || !!dl}
                  onClick={() => runDownloads(selectedItems)}
                >
                  Download selected ({selectedItems.length})
                </button>
                <button
                  className="btn-primary"
                  type="button"
                  disabled={downloadable.length === 0 || !!dl}
                  onClick={() => runDownloads(downloadable)}
                >
                  Download all ({downloadable.length})
                </button>
              </span>
            </div>

            {downloadable.length > 12 && (
              <p className="share-hint">
                Your browser will ask permission to download multiple files — allow it, and they will save one after another.
                For very large sets, Copy links works well with a download manager.
              </p>
            )}

            {tab === "folders" ? (
              openFolder ? (
                <section className="share-section">
                  <div className="share-section-head">
                    <button className="share-crumb" type="button" onClick={() => setOpenFolder(null)}>← All folders</button>
                    <h2>{openFolder}</h2>
                    <span className="muted">{scope.length} file{scope.length !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="share-grid">{visible.map(tile)}</div>
                </section>
              ) : (
                <>
                  <div className="share-folder-grid">
                    {folders.map((f) => (
                      <button key={f.name} type="button" className="share-folder" onClick={() => setOpenFolder(f.name)}>
                        <span className="share-folder-mosaic">
                          {f.items.slice(0, 4).map((i) => (
                            <span key={i.id}>{i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : null}</span>
                          ))}
                        </span>
                        <span className="share-folder-meta">
                          <strong>{f.name}</strong>
                          <span className="muted">{f.items.length} file{f.items.length !== 1 ? "s" : ""}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {looseFiles.length > 0 && (
                    <section className="share-section" style={{ marginTop: 40 }}>
                      <div className="share-section-head">
                        <h2>Not in a folder</h2>
                        <span className="muted">{looseFiles.length} file{looseFiles.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="share-grid">{looseFiles.map(tile)}</div>
                    </section>
                  )}
                </>
              )
            ) : (
              <div className="share-grid">{visible.map(tile)}</div>
            )}
          </>
        )}
      </main>

      <footer className="share-foot">
        <span>Velocity Brand Server Pvt. Ltd.</span>
        <span>contact@velocityindia.net · +91 93197 13708</span>
      </footer>

      {active && (
        <div className="share-lightbox" onClick={() => setActive(null)}>
          <div className="share-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <div className="share-lightbox-stage">
              {isVideo(active.fileType) && active.original ? (
                <video src={active.original} controls autoPlay poster={active.preview ?? undefined} />
              ) : active.preview || active.original ? (
                /* Files uploaded before previews existed have no derivative, and
                   a signed URL is minted whether or not the object is there — so
                   fall back to the original rather than showing a broken frame. */
                <img
                  src={active.preview ?? active.original ?? ""}
                  alt={active.name}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (active.original && img.src !== active.original) img.src = active.original;
                  }}
                />
              ) : (
                <p className="muted">Preview unavailable.</p>
              )}
            </div>
            <div className="share-lightbox-bar">
              <span className="share-lightbox-name">{active.name}</span>
              <span className="share-lightbox-actions">
                {active.download ? (
                  <a className="btn-primary" href={active.download}>Download original</a>
                ) : active.archived ? (
                  <span className="share-lightbox-note">
                    Full-resolution original is in long-term storage — ask your Velocity contact to retrieve it.
                  </span>
                ) : null}
                <button className="btn-outline" type="button" onClick={() => setActive(null)}>Close</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
