import { makeZip } from "client-zip";

/* Zipping a delivery, in the browser.
 *
 * A finished shoot is 100-300 GB. A serverless function cannot build that: it
 * would time out, and it would pull every byte out of storage and push it back
 * out again — paying egress twice for bytes R2 gives us for free on the way to
 * the client. So the archive is assembled on the client instead.
 *
 * client-zip streams entries in and ZIP bytes out, and the File System Access
 * API pipes those bytes straight to a file the user chose. Nothing is buffered:
 * peak memory is one stream's worth of chunks no matter how large the archive.
 * Bytes go storage -> browser -> disk and never touch our servers.
 *
 * Two things about client-zip 2.5 that this code depends on (verified against
 * node_modules/client-zip/index.js):
 *   - It never compresses. Every entry is STORED, which is what we want for
 *     JPEG and H.264 — deflating them would burn CPU to gain nothing.
 *   - Sizes are measured from the stream, not taken from the metadata we pass,
 *     and every entry is written with a trailing data descriptor. It upgrades a
 *     single entry to ZIP64 once its real length crosses 4 GB, and the archive
 *     as a whole once the offsets do. So a wrong `size` here cannot corrupt the
 *     archive; the sizes we carry are only used to predict a percentage.
 *
 * Browser support is the catch: showSaveFilePicker is Chromium desktop only.
 * Callers must check `canSaveZipToDisk()` and keep their existing one-file-at-a-
 * time download as the fallback. */

/* Not in TypeScript's DOM lib as of 5.5 (FileSystemFileHandle itself is). */
type SaveFilePicker = (options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

declare global {
  interface Window {
    showSaveFilePicker?: SaveFilePicker;
  }
}

export type ZipEntry = {
  /** Opaque handle the caller's `sign` understands — an upload id, or a fileUrl. */
  key: string;
  /** Path inside the archive. "Day 1/Stage/IMG_0001.jpg", or just a name at the root. */
  path: string;
  /** Known byte length, for the progress percentage only. */
  size?: number | null;
  lastModified?: string | Date | null;
  /** Set to skip this entry without ever fetching it — the reason is reported to the user. */
  skipReason?: string | null;
};

/** Mint download URLs for a batch of keys. Called repeatedly, mid-stream. */
export type SignBatch = (keys: string[], signal: AbortSignal) => Promise<Record<string, string>>;

export type ZipProgress = {
  filesDone: number;
  filesTotal: number;
  skipped: number;
  bytesWritten: number;
  /** Sum of known entry sizes, or null when any size is unknown. */
  totalBytes: number | null;
  /** The entry currently streaming. */
  current: string;
};

export type ZipOutcome = {
  filesWritten: number;
  bytesWritten: number;
  skipped: { path: string; reason: string }[];
  cancelled: boolean;
};

/* Presigned URLs live an hour; a 300 GB archive runs for many. Signing the
   whole set up front would hand out thousands of URLs that expire long before
   their turn, so URLs are minted a window at a time from inside the generator,
   just ahead of the files that need them. A transfer that has already started
   keeps streaming past its URL's expiry — only the handshake is checked. */
const SIGN_BATCH = 50;

/* ...but a window is not enough on its own. A batch of 50 is minted in one go
   and then consumed one file at a time; on a slow link the fiftieth entry can
   be reached hours after its URL was signed, and storage answers 403. So the
   mint time is remembered and anything approaching the one-hour signature life
   is re-signed before it is used. 45 minutes leaves room for a large file to
   finish streaming on the signature it started with. */
const URL_MAX_AGE_MS = 45 * 60 * 1000;

/* Per entry, not per archive: a dropped connection in the middle of a body used
   to discard the whole ZIP. Five consecutive failures on one file is a genuine
   outage; a hiccup every few gigabytes is just a long download. */
const MAX_BODY_RETRIES = 5;

/* Backstop for a server that hands back a byte and dies, over and over — that
   resets the consecutive counter forever, so cap the total as well. */
const MAX_BODY_RESUMES = 50;

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/* Opening a file used to get one retry, and only for a 403. Everything else —
   including the bare TypeError that a dropped Wi-Fi link produces — wrote the
   file off immediately. Since every following file then failed the same way
   within milliseconds, one blip emptied the rest of the delivery into
   _NOT_INCLUDED.txt. Opening is cheap and idempotent, so it gets a proper
   backoff instead. */
const MAX_OPEN_ATTEMPTS = 6;

/* ...and while the machine is genuinely offline, retrying on a timer would burn
   all six attempts in under a minute. Park on the browser's own 'online' event
   instead. This is a JOB-WIDE budget, not a per-wait one: it caps the TOTAL
   time spent parked across the whole run, so a persistent outage cannot make
   every remaining file wait the full ten minutes in turn (which would hang a
   big archive for hours). Once the budget is spent, later opens fail fast and
   land in _NOT_INCLUDED.txt, so the job still ends with a finished archive.
   Longer than a lift or a train tunnel; short enough that a laptop shut for the
   night finishes rather than hanging. */
const OFFLINE_WAIT_MS = 10 * 60 * 1000;

/** Shown through `current` in the progress callback while the network is gone. */
const WAITING_LABEL = "Waiting for connection…";

/* Worth another go when opening a file: an expired signature (403), storage
   having a moment (5xx, 408, 429), and anything with no status at all — a
   TypeError from fetch is every network-level failure there is (offline, DNS,
   CORS, dropped link), and "no link could be issued" means the signing call
   itself failed. A 404 or 416 will not change, so those are final. */
const retryableOpen = (err: unknown) => {
  const status = (err as { status?: number }).status;
  if (typeof status !== "number") return true;
  return status === 403 || status === 408 || status === 429 || status >= 500;
};

/** Progress fires per chunk otherwise, which is thousands of renders a second. */
const PROGRESS_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const canSaveZipToDisk = () =>
  typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";

/* Strip anything a filesystem or a ZIP reader would object to. May return an
   empty string, which is how callers spot a segment with nothing left in it. */
const scrub = (value: string) =>
  (value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot hides the file on Unix and makes ".." out of a bare "..".
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);

/** A single filesystem-safe name — for the archive's own file name. */
export const safeFileName = (value: string) => scrub(value) || "download";

/* Must be CALLED synchronously from the click handler: the save picker needs
   user activation, and the first `await` in the handler spends it. Callers take
   the promise this returns and await it inside the async work. */
export const pickZipFile = (suggestedName: string): Promise<FileSystemFileHandle> => {
  try {
    if (typeof window === "undefined" || typeof window.showSaveFilePicker !== "function") {
      throw new Error("Saving a ZIP is not supported in this browser.");
    }
    return window.showSaveFilePicker({
      suggestedName,
      types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }]
    });
  } catch (err) {
    return Promise.reject(err);
  }
};

/* Keep the folder structure but never let a path escape the archive root.
   "." and ".." are dropped BEFORE scrubbing, so a traversal segment disappears
   instead of being scrubbed into some innocent-looking folder name. */
const zipSafePath = (path: string) =>
  (path || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(scrub)
    .filter(Boolean)
    .join("/") || "file";

/* Two cameras on the same shoot both produce DSC_0001.JPG, and a ZIP with two
   identical paths extracts to one file. Suffix the later ones the way a desktop
   file manager would. */
const dedupePaths = (entries: ZipEntry[]) => {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const path = zipSafePath(entry.path);
    const taken = seen.get(path.toLowerCase());
    if (taken === undefined) {
      seen.set(path.toLowerCase(), 1);
      return path;
    }

    let next = taken + 1;
    let candidate = "";
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const stem = dot > slash + 1 ? path.slice(0, dot) : path;
    const ext = dot > slash + 1 ? path.slice(dot) : "";
    do {
      candidate = `${stem} (${next})${ext}`;
      next += 1;
    } while (seen.has(candidate.toLowerCase()));

    seen.set(path.toLowerCase(), next - 1);
    seen.set(candidate.toLowerCase(), 1);
    return candidate;
  });
};

const reasonFor = (err: unknown) => {
  /* A cross-origin fetch that storage refuses — CORS, DNS, a dropped link —
     surfaces only as a bare TypeError, so say something a person can act on. */
  if (err instanceof TypeError) return "Could not be reached from the browser";
  if (err instanceof Error && err.message) return err.message;
  return "Could not be downloaded";
};

const manifest = (skipped: { path: string; reason: string }[], total: number) =>
  [
    "Files not included in this ZIP",
    "",
    `${skipped.length} of ${total} file${total !== 1 ? "s" : ""} could not be added. Everything else is here.`,
    "Ask your Velocity contact for the files below — originals in long-term storage",
    "have to be retrieved by staff, which takes about a day.",
    "",
    ...skipped.map((s) => `${s.path}  —  ${s.reason}`),
    ""
  ].join("\r\n");

/**
 * Stream a ZIP of `entries` into the file the user picked.
 *
 * Resolves once the file is written and closed. A file that cannot be fetched
 * is skipped rather than failing the archive, and every skip is listed in a
 * `_NOT_INCLUDED.txt` entry at the end.
 */
export async function streamZipToDisk(opts: {
  handle: FileSystemFileHandle;
  entries: ZipEntry[];
  sign: SignBatch;
  signal: AbortSignal;
  batchSize?: number;
  onProgress?: (progress: ZipProgress) => void;
}): Promise<ZipOutcome> {
  const { handle, entries, sign, signal } = opts;
  const batchSize = opts.batchSize ?? SIGN_BATCH;
  const paths = dedupePaths(entries);

  const wanted = entries.filter((e) => !e.skipReason);
  const totalBytes = wanted.every((e) => typeof e.size === "number")
    ? wanted.reduce((sum, e) => sum + (e.size as number), 0)
    : null;

  const skipped: { path: string; reason: string }[] = [];
  let filesDone = 0;
  let bytesWritten = 0;
  let current = "";
  let lastReport = 0;

  const report = (force = false) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    opts.onProgress({
      filesDone,
      filesTotal: entries.length,
      skipped: skipped.length,
      bytesWritten,
      totalBytes,
      current
    });
  };

  /* Total time already spent parked waiting for the connection, measured across
     the whole run so OFFLINE_WAIT_MS can be enforced as a job-wide budget. */
  let offlineWaitedMs = 0;

  /**
   * Block until the browser says it is back online, the JOB-WIDE offline budget
   * runs out, or the user cancels. Returns immediately when the browser has no
   * opinion (navigator.onLine is true, or unavailable) — `onLine === false` is
   * the only reliable half of that flag, and it is exactly the case worth
   * waiting on — and also once the run's total wait has exhausted the budget,
   * so a persistent outage stops stalling instead of pausing every file.
   */
  async function waitForOnline() {
    if (typeof navigator === "undefined" || navigator.onLine !== false) return;
    if (signal.aborted) return;

    /* Only ever wait for what is left of the budget; when it is gone, fail fast
       so the open path can skip the file into _NOT_INCLUDED.txt. */
    const remaining = OFFLINE_WAIT_MS - offlineWaitedMs;
    if (remaining <= 0) return;

    const was = current;
    current = WAITING_LABEL;
    report(true);
    const startedAt = Date.now();
    try {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener("online", finish);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        timer = setTimeout(finish, remaining);
        window.addEventListener("online", finish);
        signal.addEventListener("abort", finish);
      });
    } finally {
      offlineWaitedMs += Date.now() - startedAt;
      current = was;
      report(true);
    }
  }

  /** Minted URL plus the moment it was minted, so staleness is knowable. */
  const urls = new Map<string, { url: string; mintedAt: number }>();
  /** Keys a signing attempt has already failed for — never asked for twice. */
  const unsignable = new Set<string>();

  /** The failure that killed the archive, so the caller can name the file. */
  let fatal: Error | null = null;

  const isFresh = (held: { mintedAt: number } | undefined) =>
    !!held && Date.now() - held.mintedAt < URL_MAX_AGE_MS;

  /**
   * A usable URL for entry `i`, minting a batch ahead when there is nothing
   * fresh to hand. `force` re-signs even a fresh URL — the answer to a 403,
   * which is what a link signed against a short-lived share window looks like
   * when it ages out well inside URL_MAX_AGE_MS.
   */
  async function urlFor(i: number, force = false): Promise<string | null> {
    const key = entries[i].key;
    const held = urls.get(key);
    if (!force && isFresh(held)) return held!.url;
    if (!force && unsignable.has(key)) return null;

    /* One request covers this entry and everything close behind it that is
       missing or going stale — re-signing one URL per file would be 6,000
       round trips on a full delivery. */
    const need: string[] = [key];
    for (let j = i + 1; j < entries.length && need.length < batchSize; j++) {
      const ahead = entries[j];
      if (ahead.skipReason || unsignable.has(ahead.key) || need.includes(ahead.key)) continue;
      if (isFresh(urls.get(ahead.key))) continue;
      need.push(ahead.key);
    }

    /* One retry, because a multi-hour download will cross the odd dropped
       connection and losing fifty files to it would be a poor trade. A
       second failure is treated as final: retrying forever would turn a
       real outage into a request storm. */
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const minted = await sign(need, signal);
        const mintedAt = Date.now();
        for (const [k, url] of Object.entries(minted)) {
          if (typeof url === "string" && url) urls.set(k, { url, mintedAt });
        }
        break;
      } catch {
        if (signal.aborted) return null;
        if (attempt === 0) await sleep(1500);
      }
    }
    /* Whatever the server declined, or never answered for, is settled — but
       only if we never had a URL for it. A stale URL that failed to re-sign is
       still worth trying: it may have minutes left on it. */
    for (const k of need) if (!urls.has(k)) unsignable.add(k);

    return urls.get(key)?.url ?? held?.url ?? null;
  }

  /* A chunk source that can be swapped out underneath the entry's stream. */
  type ChunkReader = {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
  };

  const plain = (reader: ReadableStreamDefaultReader<Uint8Array>): ChunkReader => ({
    read: () => reader.read() as Promise<{ done: boolean; value?: Uint8Array }>,
    cancel: (reason) => reader.cancel(reason).catch(() => {})
  });

  /* For a server that answered a Range request with the whole object: drop the
     bytes already in the archive before letting any through. */
  const skipping = (reader: ReadableStreamDefaultReader<Uint8Array>, skip: number): ChunkReader => {
    let left = skip;
    return {
      async read() {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            /* Short body: we can neither rewind the archive nor fabricate the
               missing bytes, so fail and let the retry loop try again. */
            if (left > 0) throw new Error("The resumed download was shorter than the file");
            return { done: true };
          }
          if (left <= 0) return { done: false, value };
          if (value.byteLength <= left) {
            left -= value.byteLength;
            continue;
          }
          const rest = value.subarray(left);
          left = 0;
          return { done: false, value: rest };
        }
      },
      cancel: (reason) => reader.cancel(reason).catch(() => {})
    };
  };

  /**
   * Open entry `i`'s body positioned at byte `from`.
   * Returns "complete" when storage says there is nothing left past `from` —
   * the body only died on the last byte.
   */
  async function openAt(i: number, from: number, force: boolean): Promise<ChunkReader | "complete"> {
    const url = await urlFor(i, force);
    if (!url) throw new Error("No download link could be issued");

    const response = await fetch(url, {
      signal,
      ...(from > 0 ? { headers: { Range: `bytes=${from}-` } } : {})
    });

    if (from > 0 && response.status === 416) {
      await response.body?.cancel().catch(() => {});
      return "complete";
    }

    if (!response.ok || !response.body) {
      const status = response.status;
      // Drain the error body so the connection is not left hanging.
      await response.body?.cancel().catch(() => {});
      const err = new Error(`Storage returned ${status}`) as Error & { status?: number };
      err.status = status;
      throw err;
    }

    if (from === 0) return plain(response.body.getReader());

    if (response.status === 206) {
      /* Where the server actually started. Content-Range is only readable
         cross-origin when the bucket's CORS ExposeHeaders lists it (ours lists
         ETag only), so an unreadable header is not an error: a server that
         answers 206 answered the range it was asked for, and we take the body
         as positioned at `from`. */
      const range = response.headers.get("Content-Range");
      const start = range ? Number(/bytes\s+(\d+)-/i.exec(range)?.[1]) : NaN;
      if (Number.isFinite(start)) {
        /* Bytes already in the archive cannot be taken back, so a server that
           started LATER than we asked would tear a hole in the file. */
        if (start > from) {
          await response.body.cancel().catch(() => {});
          throw new Error("Storage resumed past the bytes already written");
        }
        return skipping(response.body.getReader(), from - start);
      }
      return plain(response.body.getReader());
    }

    // 200: the Range was ignored and this is the whole object from zero.
    return skipping(response.body.getReader(), from);
  }

  /**
   * The entry's bytes as a stream we control. client-zip reads this; if a read
   * throws we re-open the body at the exact next byte and keep going, so a
   * blip costs a pause rather than the whole archive.
   */
  function resumable(i: number, path: string, first: ChunkReader): ReadableStream<Uint8Array> {
    let reader = first;
    let delivered = 0;
    let consecutive = 0;
    let resumes = 0;
    let closed = false;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              closed = true;
              controller.close();
              return;
            }
            if (!value) continue;
            delivered += value.byteLength;
            // Progress past the wobble; the next one starts from a clean slate.
            consecutive = 0;
            controller.enqueue(value);
            return;
          } catch (err) {
            if (signal.aborted) {
              controller.error(err);
              return;
            }
            consecutive += 1;
            resumes += 1;
            if (consecutive > MAX_BODY_RETRIES || resumes > MAX_BODY_RESUMES) {
              const stop = new Error(
                `${path} stopped downloading after ${resumes} attempt${resumes !== 1 ? "s" : ""} — ${reasonFor(err)}`
              );
              fatal = stop;
              controller.error(stop);
              return;
            }

            await sleep(RETRY_DELAYS_MS[Math.min(consecutive - 1, RETRY_DELAYS_MS.length - 1)]);
            /* Same reason as the open path: five retries against a dead network
               are spent in half a minute, and losing a half-written multi-GB
               file to a Wi-Fi drop is the expensive failure here. */
            await waitForOnline();
            if (signal.aborted) {
              controller.error(err);
              return;
            }

            try {
              /* Always re-sign: by the time a body has died mid-transfer the
                 URL it was fetched with is usually the reason. */
              const next = await openAt(i, delivered, true);
              if (next === "complete") {
                closed = true;
                controller.close();
                return;
              }
              reader = next;
            } catch {
              // Counts as this attempt; the loop retries or gives up above.
              continue;
            }
          }
        }
      },
      cancel(reason) {
        if (closed) return;
        return reader.cancel(reason);
      }
    });
  }

  async function* source() {
    /* client-zip cancels its stream by calling .throw() on this generator, which
       is what happens on the abort path. Absorb that so cancelling does not
       surface as a second, unhandled rejection alongside the abort itself. */
    try {
      yield* entriesOf();
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }

  async function* entriesOf() {
    for (let i = 0; i < entries.length; i++) {
      if (signal.aborted) return;
      const entry = entries[i];
      const path = paths[i];

      if (entry.skipReason) {
        skipped.push({ path, reason: entry.skipReason });
        report();
        continue;
      }

      let reader: ChunkReader | "complete" | null = null;
      let openError: unknown = null;

      for (let attempt = 0; attempt < MAX_OPEN_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          /* Offline first: there is no point spending an attempt, or waiting out
             a backoff, on a fetch that cannot leave the machine. */
          await waitForOnline();
          if (signal.aborted) return;
          await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
          if (signal.aborted) return;
        }
        try {
          /* Force a re-sign on every retry: an expired signature is the most
             likely reason a first open failed, and the batch this URL came from
             may simply have been minted too long ago. */
          reader = await openAt(i, 0, attempt > 0);
          openError = null;
          break;
        } catch (err) {
          if (signal.aborted) return;
          openError = err;
          /* The signer deliberately declined this key (it answered 200 with no
             URL — archived, out of scope). Retrying just burns another batch of
             sign calls for an answer that will not change, so treat it as final
             and let it fall through to the skip below. */
          if (unsignable.has(entry.key)) break;
          if (!retryableOpen(err)) break;
        }
      }

      if (reader === null || openError !== null) {
        skipped.push({ path, reason: reasonFor(openError) });
        report();
        continue;
      }
      // from === 0 never produces a 416, but the union has to be narrowed.
      if (reader === "complete") continue;

      current = path;
      report();

      /* No `size` on purpose: client-zip measures the stream, and the stored
         size can be stale. Passing one would only risk disagreeing with reality. */
      yield {
        name: path,
        input: resumable(i, path, reader),
        lastModified: entry.lastModified ? new Date(entry.lastModified) : new Date()
      };

      // Control returns here only once this entry has been fully written out.
      filesDone += 1;
      report();
    }

    if (skipped.length > 0) {
      yield {
        name: "_NOT_INCLUDED.txt",
        input: manifest(skipped, entries.length),
        lastModified: new Date()
      };
    }
  }

  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesWritten += chunk.byteLength;
      report();
      controller.enqueue(chunk);
    }
  });

  report(true);

  const writable = await handle.createWritable();
  try {
    await makeZip(source(), { buffersAreUTF8: true }).pipeThrough(counter).pipeTo(writable, { signal });
  } catch (err) {
    /* pipeTo already aborts the destination on both failure and cancellation;
       this is belt and braces for the case where it did not get that far. */
    await writable.abort().catch(() => {});
    if (signal.aborted) {
      report(true);
      return { filesWritten: filesDone, bytesWritten, skipped, cancelled: true };
    }
    /* pipeTo rejects with whatever errored the stream, but a stream error from
       inside client-zip can arrive wrapped or reordered. `fatal` is the reason
       we actually decided to stop, and it names the file. */
    throw fatal ?? err;
  }

  current = "";
  report(true);
  return { filesWritten: filesDone, bytesWritten, skipped, cancelled: false };
}


/* ---------------------------------------------------------------------------
 * The fallback, for every browser without showSaveFilePicker.
 *
 * Safari, Firefox and everything on a phone cannot write a stream to disk, so
 * there is no single-archive path for them at all. What is left is the plain
 * one-file-at-a-time queue — which both the client gallery and the staff viewer
 * need, and which used to exist only on the share page.
 * ------------------------------------------------------------------------- */

export type DownloadQueueItem = { url: string; name: string };

export type DownloadQueueProgress = { done: number; total: number; failed: number };

const clickToSave = (href: string, name: string) => {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
};

/**
 * Save `items` one after another.
 *
 * Every URL must already carry `Content-Disposition: attachment` — both signers
 * (the share link route and /api/uploads/view with `download: true`) put one
 * there. The anchor then just navigates to it and the browser streams the file
 * to disk itself, so a 40 GB video costs the page nothing.
 *
 * There used to be a `viaBlob` mode for URLs without a disposition, which
 * fetched the bytes and handed the anchor a same-origin `blob:` URL. It was
 * removed: on Safari and iOS — the browsers that need this fallback in the
 * first place, since they have no showSaveFilePicker — a multi-GB Blob is held
 * in memory and takes the tab down with it.
 */
export async function downloadOneByOne(opts: {
  items: DownloadQueueItem[];
  signal?: AbortSignal;
  /** Pause between saves. Browsers throttle a burst of downloads otherwise. */
  gapMs?: number;
  onProgress?: (progress: DownloadQueueProgress) => void;
}): Promise<DownloadQueueProgress & { cancelled: boolean }> {
  const { items, signal } = opts;
  const gap = opts.gapMs ?? 900;

  let done = 0;
  const failed = 0;
  const report = () => opts.onProgress?.({ done, total: items.length, failed });
  report();

  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) return { done, total: items.length, failed, cancelled: true };

    /* Nothing to catch: the browser owns the transfer from here, so a failure
       surfaces in its own download list rather than to this page. */
    clickToSave(items[i].url, items[i].name);

    done += 1;
    report();
    if (gap > 0 && i < items.length - 1) await sleep(gap);
  }

  return { done, total: items.length, failed, cancelled: false };
}
