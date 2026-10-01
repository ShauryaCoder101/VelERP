"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  canSaveZipToDisk,
  downloadOneByOne,
  pickZipFile,
  safeFileName,
  streamZipToDisk,
  type ZipProgress
} from "../../lib/zip-download";
import "./media-gallery.css";

/* The browsing half of an event's media: tabs, folders, selection, downloads,
 * ZIP and lightbox.
 *
 * This was the body of app/share/[token]/page.tsx until a photographer needed
 * the same gallery over their own session instead of a client token. The two
 * screens differ only in how the items were fetched and how a download URL is
 * signed, so everything else lives here once — a client and a photographer
 * looking at the same event now cannot disagree about what is in it.
 *
 * It deliberately knows nothing about tokens, sessions, events or roles. It is
 * handed items and a way to sign a batch of ids, and that is all. Note what is
 * absent: there is no delete, rename, move or replace anywhere in here, so no
 * screen built on it can grow one by accident.
 */

export type GalleryItem = {
  id: string;
  name: string;
  fileType: string;
  /** byte length, null for rows uploaded before sizes were recorded */
  size: number | null;
  folder: string;
  thumb: string | null;
  preview: string | null;
  original: string | null;
  download: string | null;
  archived: boolean;
  /** Only present when the caller identified a viewer (the photographer page). */
  mine?: boolean;
  /* Only present when the caller asked for attribution: who sent this file. A
     firm's contributors all upload under the firm's account, so without it a
     gallery of thirty people's work carries one name. Absent on the client
     share page, which renders exactly as it did before this existed. */
  by?: string;
};

export type MediaGalleryProps = {
  items: GalleryItem[];
  /** Base name for a saved ZIP; the current view ("Photos", a folder…) is appended. */
  zipName: string;
  /* The signal matters: a cancelled ZIP has to be able to abandon an in-flight
     batch rather than wait it out, so it is passed through to the caller's fetch. */
  signIds: (ids: string[], signal: AbortSignal) => Promise<Record<string, string>>;
  /** Rendered above the gallery — title block, actions, whatever the page needs. */
  header?: ReactNode;
  /** Rendered between the header and the tabs. */
  notice?: ReactNode;
  emptyMessage?: string;
};

type Tab = "photos" | "videos" | "folders";

const isImage = (t: string) => t.startsWith("image/");
const isVideo = (t: string) => t.startsWith("video/");

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

export default function MediaGallery({
  items,
  zipName,
  signIds,
  header,
  notice,
  emptyMessage = "Nothing has been added to this gallery yet."
}: MediaGalleryProps) {
  const [active, setActive] = useState<GalleryItem | null>(null);

  const [tab, setTab] = useState<Tab | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dl, setDl] = useState<{ done: number; total: number } | null>(null);
  const dlAbort = useRef<AbortController | null>(null);

  const [zipReady, setZipReady] = useState(false);
  const [zip, setZip] = useState<ZipProgress | null>(null);
  const [zipNote, setZipNote] = useState("");
  const zipAbort = useRef<AbortController | null>(null);

  /* Checked after mount, not during render: the server has no showSaveFilePicker
     and a render-time check would hydrate a different button than it painted. */
  useEffect(() => setZipReady(canSaveZipToDisk()), []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setActive(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  const photos = useMemo(() => items.filter((i) => isImage(i.fileType)), [items]);
  const videos = useMemo(() => items.filter((i) => isVideo(i.fileType)), [items]);

  /* Folder structure is recovered from the storage key, so a folder that was
     dragged in as "Day 1/Stage" shows up under exactly that path. */
  const folders = useMemo(() => {
    const map = new Map<string, GalleryItem[]>();
    for (const item of items) {
      if (!item.folder) continue;
      const list = map.get(item.folder);
      if (list) list.push(item);
      else map.set(item.folder, [item]);
    }
    return [...map.entries()]
      .map(([name, entries]) => ({ name, items: entries }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const looseFiles = useMemo(() => items.filter((i) => !i.folder), [items]);
  const filesInFolders = folders.reduce((n, f) => n + f.items.length, 0);

  /* Open on whichever view holds the most, so a video-heavy delivery doesn't
     land the client on an near-empty Photos tab. */
  useEffect(() => {
    if (items.length === 0 || tab) return;
    const ranked: [Tab, number][] = [
      ["folders", filesInFolders],
      ["photos", photos.length],
      ["videos", videos.length]
    ];
    ranked.sort((a, b) => b[1] - a[1]);
    setTab(ranked[0][1] > 0 ? ranked[0][0] : "photos");
  }, [items.length, tab, photos.length, videos.length, filesInFolders]);

  /* What the toolbar acts on. On the folders overview that is the whole
     delivery, not just the loose files — "Download all" from the top level
     has to mean all of it. */
  const scope = useMemo(() => {
    if (tab === "photos") return photos;
    if (tab === "videos") return videos;
    if (openFolder) return folders.find((f) => f.name === openFolder)?.items ?? [];
    return items;
  }, [tab, photos, videos, openFolder, folders, items]);

  // What is actually laid out as tiles in the current view.
  const visible = useMemo(() => {
    if (tab === "folders" && !openFolder) return looseFiles;
    return scope;
  }, [tab, openFolder, looseFiles, scope]);

  const downloadable = scope.filter((i) => i.download);
  const selectedItems = items.filter((i) => selected.has(i.id) && i.download);

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
     at a time, in a queue the client can watch and stop. The queue itself lives
     in lib/zip-download.ts — the staff viewer needs exactly the same fallback. */
  const runDownloads = useCallback(async (queueItems: GalleryItem[]) => {
    const queue = queueItems.filter((i) => i.download);
    if (queue.length === 0) return;
    const controller = new AbortController();
    dlAbort.current = controller;
    setDl({ done: 0, total: queue.length });

    /* No viaBlob: these URLs are signed with Content-Disposition: attachment,
       so an anchor streams them to disk with the right name and nothing is
       held in memory. */
    await downloadOneByOne({
      items: queue.map((i) => ({ url: i.download!, name: i.name })),
      signal: controller.signal,
      onProgress: (p) => setDl({ done: p.done, total: p.total })
    });

    dlAbort.current = null;
    setTimeout(() => setDl(null), 2500);
  }, []);

  /* What the current view is called, for the ZIP's file name. */
  const scopeLabel =
    tab === "photos" ? "Photos" : tab === "videos" ? "Videos" : openFolder ? openFolder : "All files";

  const runZip = async (picked: Promise<FileSystemFileHandle>, zipItems: GalleryItem[], label: string) => {
    let handle: FileSystemFileHandle;
    try {
      handle = await picked;
    } catch {
      // The user dismissed the save dialog. Nothing to report.
      return;
    }

    const controller = new AbortController();
    zipAbort.current = controller;
    setZipNote("");
    setZip({ filesDone: 0, filesTotal: zipItems.length, skipped: 0, bytesWritten: 0, totalBytes: null, current: "" });

    try {
      const outcome = await streamZipToDisk({
        handle,
        entries: zipItems.map((i) => ({
          key: i.id,
          path: i.folder ? `${i.folder}/${i.name}` : i.name,
          size: i.size,
          /* Known up front, so these never cost a request — they go straight
             into the archive's _NOT_INCLUDED.txt. */
          skipReason: i.archived ? "Original is in long-term storage" : null
        })),
        sign: signIds,
        signal: controller.signal,
        onProgress: setZip
      });

      setZipNote(
        outcome.cancelled
          ? "Stopped. The part-written ZIP on your computer is incomplete — delete it and start again."
          : outcome.skipped.length > 0
            ? `${label} saved — ${outcome.filesWritten} file${outcome.filesWritten !== 1 ? "s" : ""}, ${fmtBytes(outcome.bytesWritten)}. ${outcome.skipped.length} could not be included; _NOT_INCLUDED.txt inside the ZIP lists them.`
            : `${label} saved — ${outcome.filesWritten} file${outcome.filesWritten !== 1 ? "s" : ""}, ${fmtBytes(outcome.bytesWritten)}.`
      );
    } catch (err) {
      /* streamZipToDisk names the file it gave up on, which is the difference
         between "try again" and "that one video is the problem". */
      const why = err instanceof Error && err.message ? ` ${err.message}.` : "";
      setZipNote(`The ZIP could not be finished.${why} Start it again, or use Download selected.`);
    } finally {
      zipAbort.current = null;
      setZip(null);
    }
  };

  /* Not async, and the picker is the first thing it does: showSaveFilePicker
     needs the click's user activation, and the first await would spend it. */
  const startZip = () => {
    if (zip) return;
    const label = `${safeFileName(zipName)} — ${safeFileName(scopeLabel)}`;
    void runZip(pickZipFile(`${label}.zip`), scope, label);
  };

  const copyLinks = async (linkItems: GalleryItem[]) => {
    const text = linkItems.filter((i) => i.download).map((i) => i.download).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setDl({ done: -1, total: linkItems.length });
      setTimeout(() => setDl(null), 2500);
    } catch {
      /* clipboard blocked; nothing useful to say */
    }
  };

  const allVisibleSelected = downloadable.length > 0 && downloadable.every((i) => selected.has(i.id));

  const tile = (item: GalleryItem) => {
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

          {/* Ownership is a note, not a filter — the whole point of this gallery
              is that a photographer sees the rest of the team's work too. */}
          {item.mine && <span className="mg-mine">Uploaded by you</span>}
        </div>
        <figcaption className="share-tile-name">
          {item.name}
          {/* Quiet second line, not a badge: attribution is context for the
              occasional "who shot this", never the point of the tile. */}
          {item.by && <span className="mg-by">{item.by}</span>}
        </figcaption>
      </figure>
    );
  };

  return (
    <>
      {header}
      {notice}

      {items.length === 0 ? (
        <div className="empty-state">{emptyMessage}</div>
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
                <button className="btn-outline" type="button" onClick={() => dlAbort.current?.abort()}>Stop</button>
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
                disabled={selectedItems.length === 0 || !!dl || !!zip}
                onClick={() => runDownloads(selectedItems)}
              >
                Download selected ({selectedItems.length})
              </button>
              {/* One ZIP where the browser can write to disk; the per-file
                  queue everywhere else. */}
              <button
                className="btn-primary"
                type="button"
                disabled={downloadable.length === 0 || !!dl || !!zip}
                onClick={zipReady ? startZip : () => runDownloads(downloadable)}
              >
                {zipReady
                  ? `Download all as ZIP (${downloadable.length})`
                  : `Download all (${downloadable.length})`}
              </button>
            </span>
          </div>

          {zip && (
            <div className="share-zip">
              <div className="share-zip-main">
                <span className="share-zip-line">
                  Zipping {zip.filesDone} of {zip.filesTotal} · {fmtBytes(zip.bytesWritten)} written
                  {zip.totalBytes
                    ? ` of about ${fmtBytes(zip.totalBytes)} · ${Math.min(99, Math.floor((zip.bytesWritten / zip.totalBytes) * 100))}%`
                    : ""}
                  {zip.skipped > 0 ? ` · ${zip.skipped} skipped` : ""}
                </span>
                <span
                  className={`share-zip-track${zip.totalBytes ? "" : " share-zip-track-idle"}`}
                  aria-hidden="true"
                >
                  <span
                    style={
                      zip.totalBytes
                        ? { width: `${Math.min(99, (zip.bytesWritten / zip.totalBytes) * 100)}%` }
                        : undefined
                    }
                  />
                </span>
                <span className="share-zip-file">{zip.current || "Preparing…"}</span>
              </div>
              <button className="btn-outline" type="button" onClick={() => zipAbort.current?.abort()}>
                Cancel ZIP
              </button>
            </div>
          )}

          {zipNote && !zip && <p className="share-hint">{zipNote}</p>}

          {downloadable.length > 12 && !zip && (
            <p className="share-hint">
              {zipReady
                ? "Download all as ZIP asks where to save, then writes one archive straight to your computer — keep this tab open until it finishes. Download selected still saves plain files, one per photo."
                : "Your browser will ask permission to download multiple files — allow it, and they will save one after another. For a single ZIP, use Chrome or Edge on a computer. For very large sets, Copy links works well with a download manager."}
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
              <span className="share-lightbox-name">
                {active.name}
                {active.by && <span className="mg-by-lightbox">{active.by}</span>}
              </span>
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
    </>
  );
}
