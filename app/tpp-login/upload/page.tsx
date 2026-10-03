"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MULTIPART_THRESHOLD } from "../../../lib/upload-client";
import {
  failureReason,
  fetchExistingUploads,
  isOfflineError,
  isQuotaError,
  landedBytesUsable,
  MAX_CONSECUTIVE_OFFLINE,
  MAX_FILE_ATTEMPTS,
  notifyUploadBatch,
  OFFLINE_LANDED_MESSAGE,
  OFFLINE_MESSAGE,
  pendingRegistration,
  plannedFolder,
  QUOTA_MESSAGE,
  registerUpload,
  skipDecisions,
  uploadMediaFileWithRetry,
  type ExistingIndex,
  type PendingRegistration,
  type QueuedFile,
  type SkipReason
} from "../../../lib/media-upload";
import { markAsDirectoryInput, readDataTransfer, readFileInput, type DroppedFile } from "../../../lib/file-drop";
import FolderPicker from "../../components/FolderPicker";
import "./upload.css";

type EventOption = {
  id: string;
  eventName: string;
  companyName: string;
  fromDate: string;
  toDate: string;
};

type Quota = { usedBytes: number; quotaBytes: number };

/* GET /api/media-folders. uploadRoot and viewRoot are the same string for the
   firm's main login — the firm folder is both what it may fill and what it may
   see — but the endpoint reports them separately because a contributor's are
   not, so only uploadRoot is read here. */
type FolderPayload = { uploadRoot: string | null; viewRoot: string | null; folders: string[] };

type ItemStatus = "queued" | "uploading" | "done" | "error";

type Item = {
  id: string;
  file: File;
  /** Folder portion only ("Day 1/Stage"); empty for loose files. */
  path: string;
  status: ItemStatus;
  pct: number;
  error?: string;
  /* Set when this file is not going to be uploaded: we already hold it, or it is
     the same file twice in one batch. Recomputed rather than remembered, so
     unticking "upload them again" puts them straight back in the queue. */
  skip?: SkipReason;
  /** Which go at this file is in flight; only interesting past the first. */
  attempt?: number;
  /* Set when the bytes reached storage and only the Upload row is missing: the
     one failure where trying again must NOT send the file. Carried from the
     RegistrationFailure so Retry re-runs the registration POST and nothing else
     — a 40 GB video uploaded twice would be charged twice against the firm's
     1 TB, and only one copy would ever have a row pointing at it. Cleared the
     moment the row saves. */
  landed?: PendingRegistration;
};

/* Storage is billed in decimal units and the quota is a round 1 TB, so the
   allowance is shown in decimal too — a photographer told "931 GiB of 1 TB"
   would reasonably think the numbers were wrong. */
const GB = 1_000_000_000;

/* How long the "what have I already uploaded" answer is trusted for. Long enough
   that queueing a folder and pressing Upload is one lookup; short enough that a
   tab left open since this morning re-asks before it starts skipping files. */
const EXISTING_TTL_MS = 60_000;

/* The queue is a progress display, not a file manager. Past this many files the
   list shows what is moving and what broke rather than every row — a 400-file
   folder means ~50 progress patches a file, and each one rebuilds the array and
   re-renders the whole list. Same cap and same reasoning as the public page. */
const MAX_ROWS = 120;

const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatAllowance = (bytes: number) => {
  if (bytes >= 1_000 * GB) return `${(bytes / (1_000 * GB)).toFixed(bytes % (1_000 * GB) === 0 ? 0 : 2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
};

export default function PhotographerUploadPage() {
  const [events, setEvents] = useState<EventOption[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [eventId, setEventId] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState("");
  /* Stop, for a batch that is still going. It has to reach the uploads
     themselves — the XHR in flight and every backoff in the retry layer — or
     "Stop" would mean "finish the 40 GB video first, and the two retries after
     it". Same shape as the public page. */
  const abort = useRef<AbortController | null>(null);

  /* Where in the firm's folder this batch lands. `target` is relative to
     uploadRoot, "" meaning the firm folder itself — the loose-files case. */
  const [uploadRoot, setUploadRoot] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [foldersError, setFoldersError] = useState("");

  /* What this login has already uploaded to the chosen event, so a folder
     re-dropped after a failed run does not go up twice out of the firm's 1 TB.

     Held in a ref with its own revision counter rather than in state read by a
     memo: deciding what to skip is a pass over the whole queue, and a memo over
     `items` would redo it on every progress tick. It is recomputed only when the
     queue's MEMBERSHIP changes (queueRev), the target folder moves, the lookup
     comes back, or the checkbox is touched. */
  const existingRef = useRef<{ index: ExistingIndex; at: number } | null>(null);
  const existingFetch = useRef<Promise<ExistingIndex | null> | null>(null);
  /* Bumped whenever the answer would be about a different event. A lookup in
     flight when the event changes must not come back and have its list believed
     for the new one — files would be skipped on the strength of another event. */
  const existingScope = useRef(0);
  const [existingRev, setExistingRev] = useState(0);
  const [existingError, setExistingError] = useState("");
  const [reupload, setReupload] = useState(false);
  const [queueRev, setQueueRev] = useState(0);
  const itemsRef = useRef<Item[]>(items);

  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => markAsDirectoryInput(folderRef.current), []);

  /* Only the events an employee has explicitly handed over — a photographer
     must never see the rest of the calendar. */
  const loadAccess = async (): Promise<void> => {
    const res = await fetch("/api/photographer/events");
    if (!res.ok) {
      const said = await res.json().catch(() => null);
      throw new Error(said?.error || "Could not load your events");
    }
    const data: { events: EventOption[]; quota: Quota } = await res.json();
    setEvents(data.events);
    setQuota(data.quota);
    // One event is the normal case; preselecting it removes a pointless step.
    setEventId((prev) => (prev && data.events.some((e) => e.id === prev) ? prev : (data.events[0]?.id ?? "")));
  };

  useEffect(() => {
    loadAccess()
      .catch((err) => setNotice(err instanceof Error ? err.message : "Could not load your events"))
      .finally(() => setLoaded(true));
  }, []);

  /* The folder tree belongs to the event, so it is reloaded whenever the event
     changes — and the chosen target is dropped with it, because a folder in one
     event means nothing in another. */
  const loadFolders = useCallback(async (): Promise<void> => {
    if (!eventId) {
      setFolders([]);
      setUploadRoot("");
      return;
    }
    const res = await fetch(`/api/media-folders?eventId=${encodeURIComponent(eventId)}`);
    if (!res.ok) {
      const said = await res.json().catch(() => null);
      throw new Error(said?.error || "Your folders could not be loaded");
    }
    const data: FolderPayload = await res.json();
    setFolders(data.folders);
    setUploadRoot(data.uploadRoot ?? "");
  }, [eventId]);

  useEffect(() => {
    setTarget("");
    setFoldersError("");
    /* The already-uploaded list is per event, so switching events must not leave
       the previous event's answer deciding what to skip. */
    existingRef.current = null;
    existingFetch.current = null;
    existingScope.current += 1;
    setExistingError("");
    setExistingRev((n) => n + 1);
    loadFolders().catch((err) =>
      setFoldersError(err instanceof Error ? err.message : "Your folders could not be loaded")
    );
  }, [loadFolders]);

  /* Creating a folder is the one write this page makes outside an upload. The
     picker wants back the new path relative to uploadRoot, and the row it
     created has to appear in the tree, so the list is refreshed alongside. */
  const createFolder = async (parentRelative: string, name: string): Promise<string> => {
    const res = await fetch("/api/media-folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, parent: parentRelative, name })
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || "The folder could not be created.");
    await loadFolders().catch(() => {});
    return body.relative as string;
  };

  const totalBytes = useMemo(() => items.reduce((s, i) => s + i.file.size, 0), [items]);
  const waiting = items.filter((i) => i.status === "queued" || i.status === "error");
  const pending = waiting.filter((i) => !i.skip);
  const alreadyCount = waiting.filter((i) => i.skip === "already").length;
  const duplicateCount = waiting.filter((i) => i.skip === "duplicate").length;
  /* Rows the retry button would actually send: one marked skip is not sent,
     however it got there (a file that errored and turned out to be registered
     after all is marked "already" by the next lookup). */
  const failedCount = waiting.filter((i) => i.status === "error" && !i.skip).length;
  const doneCount = items.filter((i) => i.status === "done").length;

  /* What is happening, what went wrong, then the head of what is waiting. */
  const shown = useMemo(() => {
    if (items.length <= MAX_ROWS) return items;
    const by = (status: ItemStatus) => items.filter((i) => i.status === status);
    return [...by("uploading"), ...by("error"), ...by("queued")].slice(0, MAX_ROWS);
  }, [items]);

  const usedPct = quota && quota.quotaBytes > 0 ? Math.min(100, (quota.usedBytes / quota.quotaBytes) * 100) : 0;

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  /**
   * Fetch (or reuse) the list of files this login has already uploaded to the
   * chosen event.
   *
   * Never throws and never blocks an upload: a lookup that fails leaves the
   * index null, which means "skip nothing", and says so on screen. Not being
   * able to check whether a file is a duplicate is not a reason to refuse to
   * upload it.
   */
  const ensureExisting = useCallback(
    async (force: boolean): Promise<ExistingIndex | null> => {
      if (!eventId) return null;
      const held = existingRef.current;
      if (!force && held && Date.now() - held.at < EXISTING_TTL_MS) return held.index;
      /* Dropping a folder arms the lookup and pressing Upload asks for it again.
         On a slow connection both would be in the air at once, and this query
         reads every row this login has on the event — one is enough. */
      if (!force && existingFetch.current) return existingFetch.current;

      const scope = existingScope.current;
      const run = (async () => {
        try {
          const index = await fetchExistingUploads(`/api/uploads/existing?eventId=${encodeURIComponent(eventId)}`);
          // An answer about the previous event, or the previous person, is dropped.
          if (existingScope.current !== scope) return null;
          existingRef.current = { index, at: Date.now() };
          setExistingError("");
          setExistingRev((n) => n + 1);
          return index;
        } catch {
          if (existingScope.current !== scope) return null;
          existingRef.current = null;
          setExistingError(
            "We couldn't check what you've already uploaded, so nothing will be skipped. Everything in the queue will be sent."
          );
          setExistingRev((n) => n + 1);
          return null;
        }
      })();

      existingFetch.current = run;
      try {
        return await run;
      } finally {
        if (existingFetch.current === run) existingFetch.current = null;
      }
    },
    [eventId]
  );

  /** The queue as the skip check sees it: the folder each file would land in,
   *  sanitised exactly as its key will be, plus the name and size to match on.
   *
   *  Only the files that would actually be sent. A file already uploaded in this
   *  session is "done", and judging it against the list it is now ON would mark
   *  it as a duplicate of itself. */
  const candidates = (queue: Item[]): QueuedFile[] =>
    queue
      .filter((i) => i.status === "queued" || i.status === "error")
      .map((i) => ({
        id: i.id,
        folder: plannedFolder(target, i.path),
        name: i.file.name,
        size: i.file.size
      }));

  /* "Upload them again anyway" withholds the index, which is what turns off the
     already-uploaded half of the check. Duplicates WITHIN one batch are dropped
     either way: nobody wants the same file sent twice in one go. */
  const decide = (queue: Item[], index: ExistingIndex | null) =>
    skipDecisions(candidates(queue), reupload ? null : index);

  useEffect(() => {
    // Nothing moves mid-batch — the folder picker and the checkbox are both
    // disabled while busy — and recomputing here would fight progress patches.
    if (busy) return;
    const skip = decide(itemsRef.current, existingRef.current?.index ?? null);
    setItems((prev) => {
      let changed = false;
      const next = prev.map((i) => {
        const nextSkip = skip.get(i.id);
        /* A row that failed but the fresh lookup now finds saved: it did land
           after all (a registration whose reply was lost). Clear the stale error
           and the landed state and let it read "Already uploaded", so it is
           neither counted as failed nor sent again by Retry. */
        const resolved = nextSkip === "already" && i.status === "error";
        if (i.skip === nextSkip && !resolved) return i;
        changed = true;
        return resolved
          ? { ...i, skip: nextSkip, status: "queued" as ItemStatus, pct: 0, error: undefined, landed: undefined }
          : { ...i, skip: nextSkip };
      });
      return changed ? next : prev;
    });
    // decide() is rebuilt every render; the inputs that matter are listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queueRev, target, existingRev, reupload]);

  // Asked once the queue is non-empty, so the count is on screen before Upload
  // is pressed rather than appearing as files start disappearing.
  useEffect(() => {
    if (!eventId || busy || itemsRef.current.length === 0) return;
    void ensureExisting(false);
  }, [eventId, busy, queueRev, ensureExisting]);

  const addFiles = (incoming: DroppedFile[]) => {
    if (incoming.length === 0) return;
    setNotice("");
    setBlocked("");
    setItems((prev) => [
      ...prev,
      ...incoming.map(({ file, path }, i) => ({
        id: `${Date.now()}-${prev.length + i}-${file.name}`,
        file,
        path,
        status: "queued" as ItemStatus,
        pct: 0
      }))
    ]);
    setQueueRev((n) => n + 1);
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    setQueueRev((n) => n + 1);
  };

  const patch = (id: string, next: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...next } : i)));

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    addFiles(await readDataTransfer(e.dataTransfer));
  };

  /**
   * One file, end to end. Throws; the caller decides whether to stop.
   * Resolves with the number of derivatives (thumb/preview) that did not land —
   * never fatal, but the caller reports it rather than letting blank tiles be
   * the first anyone hears of it.
   *
   * The pipeline itself lives in lib/media-upload.ts, shared with the public
   * open-link page. The path sent is relative to this firm's own folder: the
   * server prepends the root. A dropped directory structure nests UNDER the
   * chosen target rather than replacing it, so "Day 1/Stage" dropped into
   * "Gujarat" lands in "Gujarat/Day 1/Stage".
   */
  const uploadOne = async (item: Item, signal: AbortSignal) => {
    /* Every patch walks the whole queue and re-renders the list; on a
       four-hundred-file folder that is the most frequent work on the page. Two
       percentage points is below what anyone can see move. */
    let shownPct = 0;
    const { derivativeFailures } = await uploadMediaFileWithRetry({
      file: item.file,
      eventId,
      relativePath: [target, item.path].filter(Boolean).join("/"),
      /* Without this the retry layer's 2 s and 8 s backoffs are plain sleeps and
         the part in flight keeps streaming: Stop would do nothing for the three
         attempts this file is entitled to. */
      signal,
      /* A retry starts the file from scratch — new previews, a new key — so the
         bar goes back to zero rather than appearing to run backwards. */
      onAttempt: (attempt) => {
        shownPct = 0;
        patch(item.id, { pct: 0, attempt });
      },
      onProgress: (pct) => {
        if (pct < 100 && pct - shownPct < 2) return;
        shownPct = pct;
        patch(item.id, { pct });
      }
    });
    return derivativeFailures;
  };

  const handleUpload = async () => {
    if (!eventId) {
      setNotice("Choose the event these files belong to.");
      return;
    }
    if (waiting.length === 0) {
      setNotice("Add photos, videos or a folder first.");
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setNotice("");
    setBlocked("");

    /* The skip list is settled against a FRESH answer, not against whatever was
       on screen: a batch that ran ten minutes ago changed what we hold, and the
       whole point is that this batch does not pay for those files again. */
    const existingIndex = await ensureExisting(false);
    const skip = decide(itemsRef.current, existingIndex);
    setItems((prev) => prev.map((i) => ({ ...i, skip: skip.get(i.id) })));

    const queue = waiting.filter((i) => !skip.has(i.id));
    const skippedAlready = waiting.filter((i) => skip.get(i.id) === "already").length;
    const skippedDuplicate = waiting.filter((i) => skip.get(i.id) === "duplicate").length;
    const skipped = skippedAlready + skippedDuplicate;

    if (queue.length === 0) {
      abort.current = null;
      setBusy(false);
      setNotice(
        `Nothing to upload — all ${skipped} file${skipped !== 1 ? "s" : ""} in the queue ${
          skipped !== 1 ? "are" : "is"
        } already uploaded, or a second copy of another file in it.` +
          (skippedAlready > 0 ? ' Tick "Upload them again anyway" if you need another copy.' : "")
      );
      return;
    }

    const batchBytes = queue.reduce((sum, i) => sum + i.file.size, 0);
    let failures = 0;
    let stopped = 0;
    /* The server's own words for why the batch stopped. There is more than one
       reason now — the 1 TB allowance, or one of the in-progress ceilings —
       and only the server knows which, so the message is carried rather than
       reconstructed. */
    let stoppedBecause = "";
    let thumbFailures = 0;
    /* Files left when Stop was pressed, so the end-of-batch line can say
       "stopped" rather than reporting a failure nobody suffered. */
    let cancelled = 0;
    /* Files in a row whose request never reached Velocity. The batch gives up at
       MAX_CONSECUTIVE_OFFLINE: with retries, a dead connection otherwise costs
       three attempts and ~10 s of backoff per file for the whole folder. */
    let offline = 0;
    /* Whether every failure in the current offline run landed its bytes. Decides
       which message the breaker shows: all landed → Velocity couldn't record
       them; any genuine send failure in the run → files didn't send. */
    let offlineAllLanded = true;

    /* Fire-and-forget: the upload must not wait on an email server. */
    const notify = (phase: "start" | "end", failed = 0) =>
      notifyUploadBatch({ eventId, phase, fileCount: queue.length, totalBytes: batchBytes, failed });

    void notify("start");

    // One bad file must not strand the rest of the shoot.
    for (let index = 0; index < queue.length; index++) {
      if (controller.signal.aborted) {
        cancelled = queue.length - index;
        for (const rest of queue.slice(index)) patch(rest.id, { status: "queued", pct: 0 });
        break;
      }

      const item = queue[index];
      /* The file is already in storage and only its row is missing, so the whole
         of "try again" is the one POST that did not finish. Sending the bytes a
         second time would charge the firm twice for a video it already holds —
         see RegistrationFailure. The bar sits at 100 because the upload part of
         this row genuinely is done. */
      const landed = item.landed;
      patch(item.id, { status: "uploading", pct: landed ? 100 : 0, error: undefined, attempt: 1 });
      try {
        if (landed) await registerUpload(landed, undefined, controller.signal);
        else thumbFailures += await uploadOne(item, controller.signal);
        patch(item.id, { status: "done", pct: 100, landed: undefined });
        offline = 0;
        offlineAllLanded = true;
      } catch (err) {
        /* Stop, not a failure: the file is put back in the queue rather than
           marked as having gone wrong. */
        if (controller.signal.aborted) {
          cancelled = queue.length - index;
          for (const rest of queue.slice(index)) patch(rest.id, { status: "queued", pct: 0 });
          break;
        }

        const message = err instanceof Error ? err.message : "Upload failed";
        /* The row says what actually happened and how many goes it had, rather
           than "failed": a wall of identical generic errors is what let ~290
           missing videos go unnoticed for two days. */
        /* Remembered on the row, not just described in it: this is what makes the
           next press of Retry a registration rather than another 40 GB. A retry
           of a landed row that fails again comes back as a RegistrationFailure
           of its own, so the state is refreshed rather than lost. */
        /* Keep the landed state only while another registration POST could still
           record the bytes. Only a 422 means the object is no
           good (422: storage says the object is not there), so drop it and let Retry
           re-upload the file — failureReason switches to the server's sentence to
           match. */
        const landedPending = pendingRegistration(err) ?? landed;
        patch(item.id, {
          status: "error",
          error: failureReason(err),
          landed: landedPending && landedBytesUsable(err) ? landedPending : undefined
        });
        failures += 1;

        /* A full allowance, or a ceiling on uploads already in progress, is not
           a per-file problem: every remaining file would fail the same way, so
           the batch stops and says so once. */
        if (isQuotaError(err)) {
          stopped = queue.length - index - 1;
          stoppedBecause = message;
          for (const rest of queue.slice(index + 1)) patch(rest.id, { status: "queued", pct: 0 });
          break;
        }

        /* Nor is a connection that has gone. Counted rather than acted on at the
           first one: a single file nobody can reach is bad luck, five in a row
           is the network, and anything that succeeds resets it. */
        if (isOfflineError(err)) {
          offline += 1;
          /* A landed failure is Velocity unreachable for the record; a bare
             status 0 is unreachable for the file itself. Both count, but only an
             all-landed run earns the "reaching storage" message. */
          if (pendingRegistration(err) === null) offlineAllLanded = false;
        } else {
          offline = 0;
          offlineAllLanded = true;
        }
        if (offline >= MAX_CONSECUTIVE_OFFLINE) {
          stopped = queue.length - index - 1;
          stoppedBecause = offlineAllLanded ? OFFLINE_LANDED_MESSAGE : OFFLINE_MESSAGE;
          for (const rest of queue.slice(index + 1)) patch(rest.id, { status: "queued", pct: 0 });
          break;
        }
      }
    }

    abort.current = null;
    setBusy(false);
    void notify("end", failures);

    // The allowance moved, whether or not the files landed.
    await loadAccess().catch(() => {});
    // Dropped directories make folders too; the tree should show them.
    await loadFolders().catch(() => {});
    /* What we hold has changed, so the next batch must not be judged against the
       list from before this one. */
    void ensureExisting(true);

    /* Said out loud at the end as well as before the batch: "392 uploaded" out
       of a 704-file folder is alarming unless the other 312 are accounted for. */
    const parts: string[] = [];
    if (skippedAlready > 0) parts.push(`${skippedAlready} already uploaded`);
    if (skippedDuplicate > 0) parts.push(`${skippedDuplicate} listed twice in this batch`);
    const alsoSkipped = parts.length
      ? ` ${skipped} file${skipped !== 1 ? "s" : ""} skipped: ${parts.join(" and ")}.`
      : "";

    if (cancelled > 0) {
      setNotice(
        `Stopped. ${cancelled} file${cancelled !== 1 ? "s are" : " is"} still queued — press Upload to carry on.` +
          alsoSkipped
      );
      return;
    }

    if (stopped > 0) {
      /* "The allowance is full" is only one of the reasons the batch stops now,
         and it is the one that needs a human: the in-progress ceilings clear
         themselves in minutes, so telling someone to ring Velocity about one
         would be wrong. The server distinguishes them, so its message is shown
         verbatim and only the queue count is added. */
      const stillQueued = `${stopped} file${stopped !== 1 ? "s are" : " is"} still queued.`;
      setBlocked(
        stoppedBecause.startsWith(QUOTA_MESSAGE)
          ? `Your 1 TB storage allowance is full, so the upload stopped — ${stillQueued} Ask your Velocity contact to free up room before trying again.`
          : stoppedBecause === OFFLINE_LANDED_MESSAGE
            ? `${stoppedBecause} ${stillQueued}`
            : `${stoppedBecause} The upload stopped, so ${stillQueued}`
      );
      return;
    }

    const ok = queue.length - failures;
    setNotice(
      (failures === 0
        ? `${ok} file${ok !== 1 ? "s" : ""} uploaded.`
        : /* Not "sends just those": the button calls this same function, which
             takes everything still waiting — the failures AND anything left
             queued. Saying otherwise is how someone concludes the remainder was
             sent when it was not. */
          `${ok} uploaded, ${failures} failed. Each row says what went wrong; "Retry failed files" below sends them, along with anything still queued.`) +
        alsoSkipped +
        (thumbFailures > 0
          ? ` ${thumbFailures} preview image${thumbFailures !== 1 ? "s" : ""} could not be saved — those files are safely stored, but their tiles will load the full version.`
          : "")
    );
  };

  const selectedEvent = events.find((e) => e.id === eventId);

  return (
    <>
      <div className="page-header">
        <h1>Upload event media</h1>
        <p>Photos and video go straight to Velocity&apos;s secure storage.</p>
      </div>

      <div className="upload-form">
        {quota && (
          <div className={`quota${usedPct >= 80 ? " quota-tight" : ""}`}>
            <div className="quota-line">
              <span>Storage used</span>
              <span className="quota-figure">
                {formatAllowance(quota.usedBytes)} of {formatAllowance(quota.quotaBytes)}
              </span>
            </div>
            <div
              className="quota-bar"
              role="progressbar"
              aria-label="Storage allowance used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedPct)}
            >
              <span style={{ width: `${usedPct}%` }} />
            </div>
          </div>
        )}

        {loaded && events.length === 0 ? (
          <div className="upload-empty">
            <strong>No events yet</strong>
            <span className="muted">
              You haven&apos;t been given access to any events yet. Ask your Velocity contact to add you to an
              event.
            </span>
          </div>
        ) : (
          <>
            <label className="auth-label" htmlFor="photo-event">Event</label>
            <select
              id="photo-event"
              className="input select"
              value={eventId}
              disabled={busy || !loaded}
              onChange={(e) => setEventId(e.target.value)}
            >
              <option value="">Choose an event</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.eventName} — {e.companyName}
                </option>
              ))}
            </select>
            {selectedEvent && <span className="cell-meta">Filing under {selectedEvent.companyName}</span>}

            {/* Everything this firm sends lands inside its own folder; this
                chooses where inside it. The root is the loose-files case, and
                is deliberately the default — picking a folder is a decision,
                not a toll. */}
            {eventId && uploadRoot && (
              <>
                <span className="auth-label">Folder</span>
                <FolderPicker
                  folders={folders}
                  uploadRoot={uploadRoot}
                  value={target}
                  onChange={setTarget}
                  onCreate={createFolder}
                  rootLabel={uploadRoot}
                  disabled={busy}
                />
              </>
            )}
            {foldersError && <div className="auth-error" role="alert">{foldersError}</div>}

            {/* Uploading is only half the job: the same events can be browsed —
                every file on them, not just this photographer's — and shared
                with a client from there. Listed per event rather than hung off
                the dropdown, so the way through is visible without first
                choosing something. */}
            {/* Held back until the list has actually arrived: rendering the frame first
                put an empty bordered box on screen on every load. */}
            {loaded && events.length > 0 && (
            <div className="share-list">
              <div className="share-list-head">Your events</div>
              {/* The other half of this account: handing a password-less upload
                  URL to a photographer in the field who has no login at all.
                  Kept at the top of the event list because it is reached far
                  more often than any one event. */}
              <div className="share-row">
                <div className="share-row-main">
                  <strong>Upload links</strong>
                  <span className="muted">
                    Let your team upload to an event without a login, into your folder.
                  </span>
                </div>
                <div className="share-row-actions">
                  <Link className="edit-btn" href="/tpp-login/links">Open</Link>
                </div>
              </div>
              {events.map((option) => (
                <div key={option.id} className="share-row">
                  <div className="share-row-main">
                    <strong>{option.eventName}</strong>
                    <span className="muted">{option.companyName}</span>
                  </div>
                  <div className="share-row-actions">
                    <Link className="edit-btn" href={`/tpp-login/media/${option.id}`}>
                      View photos &amp; client links
                    </Link>
                  </div>
                </div>
              ))}
            </div>
            )}

            <div
              className={`dropzone${dragging ? " dropzone-active" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (!busy) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <strong>Drop photos, videos or whole folders here</strong>
              <span className="muted">
                Folder names are kept, so &ldquo;Day 1/Stage&rdquo; stays as you delivered it. Large files upload in
                parts, and a dropped connection retries that part rather than starting over.
              </span>
              <div className="upload-actions">
                <button className="btn-outline" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
                  Select files
                </button>
                <button
                  className="btn-outline"
                  type="button"
                  disabled={busy}
                  onClick={() => folderRef.current?.click()}
                >
                  Select a folder
                </button>
              </div>
            </div>

            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,video/*,.zip,.rar,.7z"
              style={{ display: "none" }}
              onChange={(e) => {
                addFiles(readFileInput(e.target.files));
                e.target.value = "";
              }}
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                addFiles(readFileInput(e.target.files));
                e.target.value = "";
              }}
            />
          </>
        )}

        {/* Said plainly BEFORE the upload starts, with the count, because the
            alternative is files quietly not being sent and nobody knowing which.
            The checkbox is the way out for the one legitimate case: a file that
            genuinely does need sending again. */}
        {!busy && (alreadyCount > 0 || duplicateCount > 0) && (
          <div className="upload-skip">
            <span>
              {alreadyCount > 0 && (
                <>
                  <strong>
                    {alreadyCount} of {waiting.length} file{waiting.length !== 1 ? "s" : ""}
                  </strong>{" "}
                  {alreadyCount !== 1 ? "are" : "is"} already uploaded and will be skipped.
                </>
              )}
              {duplicateCount > 0 && (
                <>
                  {alreadyCount > 0 ? " " : ""}
                  {duplicateCount} file{duplicateCount !== 1 ? "s are" : " is"} listed twice in this batch; only one
                  copy will be sent.
                </>
              )}
            </span>
            {alreadyCount > 0 && (
              <label className="checkbox-option">
                <input type="checkbox" checked={reupload} onChange={(e) => setReupload(e.target.checked)} />
                Upload them again anyway
              </label>
            )}
          </div>
        )}
        {existingError && <span className="cell-meta">{existingError}</span>}

        {items.length > 0 && (
          <div className="uploader-list">
            <div className="uploader-list-head">
              <span>{items.length} file{items.length !== 1 ? "s" : ""} · {formatBytes(totalBytes)}</span>
              <span>
                {doneCount > 0 && `${doneCount} uploaded`}
                {items.length > shown.length && `${doneCount > 0 ? " · " : ""}showing ${shown.length}`}
              </span>
            </div>
            {shown.map((item) => (
              <div
                key={item.id}
                className={`uploader-row uploader-${item.status}${item.skip ? " uploader-skipped" : ""}`}
              >
                <span className="uploader-name" title={item.path ? `${item.path}/${item.file.name}` : item.file.name}>
                  {item.file.name}
                  {item.path && <span className="uploader-folder">{item.path}</span>}
                </span>
                <span className="uploader-size">
                  {formatBytes(item.file.size)}
                  {item.file.size > MULTIPART_THRESHOLD && <span className="uploader-parts"> · in parts</span>}
                </span>
                <span className="uploader-state">
                  {item.status === "queued" &&
                    (item.skip === "already"
                      ? "Already uploaded"
                      : item.skip === "duplicate"
                        ? "Listed twice"
                        : "Queued")}
                  {item.status === "uploading" &&
                    (item.attempt && item.attempt > 1
                      ? `Try ${item.attempt} of ${MAX_FILE_ATTEMPTS} · ${item.pct}%`
                      : `${item.pct}%`)}
                  {item.status === "done" && "Uploaded"}
                  {item.status === "error" && (item.error ?? "Failed")}
                </span>
                {item.status === "uploading" ? (
                  <span className="uploader-bar"><span style={{ width: `${item.pct}%` }} /></span>
                ) : (
                  <button
                    className="row-remove"
                    type="button"
                    aria-label={`Remove ${item.file.name}`}
                    disabled={busy}
                    onClick={() => removeItem(item.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {blocked && <div className="auth-error" role="alert">{blocked}</div>}
        {notice && <div className="muted">{notice}</div>}

        {events.length > 0 && (
          <button className="btn-primary auth-submit" type="button" onClick={handleUpload} disabled={busy}>
            {busy
              ? "Uploading…"
              : pending.length > 0
                ? `Upload ${pending.length} file${pending.length !== 1 ? "s" : ""}`
                : "Upload"}
          </button>
        )}

        {/* The way out of a batch that is going nowhere. Without it the only exit
            was closing the tab, which strands every OPEN multipart session —
            holding its bytes against the firm's 1 TB until the janitor sweeps,
            hours later. Stopping aborts them properly, which is what refunds
            them. */}
        {busy && (
          <button
            className="btn-outline"
            type="button"
            onClick={() => {
              abort.current?.abort();
              setNotice("Stopping…");
            }}
          >
            Stop
          </button>
        )}

        {/* Sends the files that failed — and, deliberately, anything still queued
            behind them, because this calls the same handler as Upload. The files
            that landed are "done" and are never in the queue it builds, so
            nothing that succeeded can go up a second time by pressing it. */}
        {!busy && failedCount > 0 && (
          <button className="btn-outline" type="button" onClick={() => void handleUpload()}>
            Retry {failedCount} failed file{failedCount !== 1 ? "s" : ""}
          </button>
        )}
      </div>
    </>
  );
}
