"use client";

import { useEffect, useMemo, useState } from "react";
import "./folder-picker.css";

/* Choosing where files land, and making a folder to land them in.
 *
 * Shared by the firm's main login and by a contributor on an open link. The two
 * differ only in what `uploadRoot` is — the firm folder, or one person's folder
 * inside it — so this component is deliberately told nothing about firms,
 * contributors, links or events. It is handed a list of full paths, the root it
 * may write under, and a way to create a folder; everything it shows is derived
 * from those.
 *
 * `folders` is the full set the caller can SEE, which for a contributor is the
 * whole firm's. Only the part under `uploadRoot` is rendered: showing another
 * photographer's folders as targets would offer a choice the server would then
 * refuse, which is worse than not offering it.
 *
 * Note what is absent, as in MediaGallery: no rename, no move, no delete. A
 * screen built on this cannot grow one by accident.
 */

/* The firm folder, plus a contributor folder, plus room to nest — the same
   ceiling the server enforces (MAX_FOLDER_DEPTH in lib/upload-links.ts, which is
   server-only and cannot be imported here). Kept in step by hand; the server is
   the one that decides, this only stops offering a button that would fail. */
const MAX_DEPTH = 8;

/* Mirrors sanitizeSegment in lib/uploadKey.ts closely enough to show the person
   what their folder will actually be called before they commit to it. The
   server sanitises again regardless — this is a preview, not a validation. */
const previewSegment = (name: string) =>
  name
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120);

/* The same, over a whole path. `uploadRoot` is a STORED name (a firm's folder,
   a contributor's) while `folders` holds paths the server derived from keys,
   which were sanitised on the way in. Comparing the two raw means a stored name
   that sanitises to something else matches nothing, and the tree renders empty
   with no error anywhere. */
const normalizePath = (path: string) =>
  path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .map((s) => previewSegment(s) || "_")
    .join("/");

export type FolderPickerProps = {
  /** Every folder the caller can see, as full paths relative to the event. */
  folders: string[];
  /** The prefix this caller may write under, as a full path. */
  uploadRoot: string;
  /** Current target, relative to uploadRoot. "" is the root itself. */
  value: string;
  onChange: (relative: string) => void;
  /** Creates a folder and resolves with its new path relative to uploadRoot. */
  onCreate: (parentRelative: string, name: string) => Promise<string>;
  /** What the root is called on screen — the firm's name, or the person's folder. */
  rootLabel: string;
  disabled?: boolean;
};

type Node = { relative: string; name: string; children: Node[] };

const segments = (path: string) => path.split("/").filter(Boolean);

/** Full paths under `root`, re-expressed relative to it. "" (the root) is dropped. */
const relativesUnder = (folders: string[], root: string): string[] => {
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot) return [];
  const prefix = `${normalizedRoot}/`;
  const out = new Set<string>();
  for (const raw of folders) {
    const full = normalizePath(raw);
    if (!full.startsWith(prefix)) continue;
    const rel = full.slice(prefix.length);
    if (!rel) continue;
    /* Every ancestor is a node too: a folder row may exist for "Day 1/Stage"
       without one for "Day 1" (keys are prefixes, and only leaves hold files). */
    const parts = segments(rel);
    for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
};

const buildTree = (relatives: string[]): Node[] => {
  const roots: Node[] = [];
  const byPath = new Map<string, Node>();
  for (const rel of relatives) {
    const parts = segments(rel);
    const node: Node = { relative: rel, name: parts[parts.length - 1], children: [] };
    byPath.set(rel, node);
    const parent = parts.length > 1 ? byPath.get(parts.slice(0, -1).join("/")) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
};

export default function FolderPicker({
  folders,
  uploadRoot,
  value,
  onChange,
  onCreate,
  rootLabel,
  disabled = false
}: FolderPickerProps) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const tree = useMemo(() => buildTree(relativesUnder(folders, uploadRoot)), [folders, uploadRoot]);

  /* Whatever is selected has to be visible, including a folder that was just
     created three levels down, so its ancestors are opened for it. */
  useEffect(() => {
    const parts = segments(value);
    if (parts.length === 0) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (let i = 1; i <= parts.length; i += 1) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [value]);

  const toggle = (relative: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(relative) ? next.delete(relative) : next.add(relative);
      return next;
    });

  /* Counted in full path segments, because that is what the server counts. */
  const depthOfTarget = segments(uploadRoot).length + segments(value).length;
  const canNest = depthOfTarget < MAX_DEPTH;

  const trail = [rootLabel, ...segments(value)];

  const submit = async () => {
    const wanted = previewSegment(name);
    if (!wanted) {
      setError("Give the folder a name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await onCreate(value, name.trim());
      setName("");
      setCreating(false);
      onChange(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The folder could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const row = (node: Node, depth: number) => {
    const selected = node.relative === value;
    const expanded = open.has(node.relative);
    return (
      <li key={node.relative}>
        <div className={`fp-row${selected ? " fp-row-on" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
          {node.children.length > 0 ? (
            <button
              type="button"
              className="fp-twisty"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
              onClick={() => toggle(node.relative)}
            >
              <span aria-hidden="true">{expanded ? "–" : "+"}</span>
            </button>
          ) : (
            <span className="fp-twisty fp-twisty-blank" aria-hidden="true" />
          )}
          <button
            type="button"
            className="fp-pick"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(node.relative)}
          >
            {node.name}
          </button>
        </div>
        {expanded && node.children.length > 0 && <ul className="fp-list">{node.children.map((c) => row(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className="fp">
      <div className="fp-tree" role="group" aria-label="Choose a folder to upload into">
        <div className={`fp-row${value === "" ? " fp-row-on" : ""}`} style={{ paddingLeft: 8 }}>
          <span className="fp-twisty fp-twisty-blank" aria-hidden="true" />
          <button
            type="button"
            className="fp-pick fp-pick-root"
            aria-pressed={value === ""}
            disabled={disabled}
            onClick={() => onChange("")}
          >
            {rootLabel}
          </button>
        </div>
        {tree.length > 0 && <ul className="fp-list">{tree.map((n) => row(n, 1))}</ul>}
      </div>

      <div className="fp-foot">
        <p className="fp-target">
          <span className="fp-target-label">Uploading to</span>
          <span className="fp-trail">
            {trail.map((part, i) => (
              <span key={`${part}-${i}`}>
                {i > 0 && <span className="fp-sep" aria-hidden="true">/</span>}
                {part}
              </span>
            ))}
          </span>
        </p>

        {creating ? (
          <div className="fp-new">
            <label className="auth-label" htmlFor="fp-new-name">
              New folder in {trail[trail.length - 1]}
            </label>
            <div className="fp-new-row">
              <input
                id="fp-new-name"
                className="input"
                value={name}
                autoFocus
                disabled={busy || disabled}
                maxLength={120}
                placeholder="Day 2"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                  if (e.key === "Escape") {
                    setCreating(false);
                    setError("");
                  }
                }}
              />
              <button className="btn-primary" type="button" disabled={busy || disabled} onClick={() => void submit()}>
                {busy ? "Creating…" : "Create"}
              </button>
              <button
                className="btn-outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setError("");
                }}
              >
                Cancel
              </button>
            </div>
            {/* Shown only once it diverges, so the usual case stays quiet. */}
            {name.trim() && previewSegment(name) !== name.trim() && (
              <span className="cell-meta">Will be saved as “{previewSegment(name)}”</span>
            )}
          </div>
        ) : (
          <button
            className="btn-outline fp-new-btn"
            type="button"
            disabled={disabled || !canNest}
            title={canNest ? undefined : "Folders cannot be nested any deeper"}
            onClick={() => {
              setCreating(true);
              setError("");
            }}
          >
            New folder
          </button>
        )}

        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
