/* Browser-side upload with retry.
 *
 * A single presigned PUT is all-or-nothing. A 1GB file that drops at 900MB
 * starts again from zero, and anything over 5GB cannot go that way at all.
 * Above a threshold we switch to multipart: the file is cut into parts, each
 * uploaded independently, and a failure costs one part rather than the upload.
 *
 * Requires ExposeHeaders: ["ETag"] in the bucket's CORS policy — the ETag of
 * each part is what stitches the object back together, and the browser cannot
 * read that header without it.
 */

const MB = 1024 * 1024;

/** Below this, one PUT is simpler and faster. */
export const MULTIPART_THRESHOLD = 16 * MB;

const BASE_PART_SIZE = 16 * MB;
const MAX_PARTS = 10_000; // S3/R2 hard limit
const PART_CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

export type ProgressFn = (pct: number) => void;

const contentTypeOf = (file: File) => file.type || "application/octet-stream";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Parts must be uniform (bar the last) and there can be at most 10,000, so a
   very large file needs a bigger part rather than more of them. */
export const partSizeFor = (fileSize: number) => {
  let size = BASE_PART_SIZE;
  while (Math.ceil(fileSize / size) > MAX_PARTS) size *= 2;
  return size;
};

type XhrResult = { ok: boolean; status: number; etag: string | null };

const putBlob = (
  url: string,
  blob: Blob,
  contentType: string | null,
  onLoaded: (bytes: number) => void
): Promise<XhrResult> =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onLoaded(e.loaded);
    };
    xhr.onload = () =>
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        etag: xhr.getResponseHeader("ETag")
      });
    xhr.onerror = () => resolve({ ok: false, status: 0, etag: null });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, etag: null });
    xhr.send(blob);
  });

const simpleUpload = async (url: string, file: File, onProgress: ProgressFn) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await putBlob(url, file, contentTypeOf(file), (loaded) =>
      onProgress(Math.round((loaded / file.size) * 100))
    );
    if (res.ok) return;
    // A rejected signature or a refused request will not improve on retry.
    if (res.status >= 400 && res.status !== 408 && res.status !== 429) {
      throw new Error(`Storage refused the file (${res.status})`);
    }
    if (attempt === MAX_ATTEMPTS) throw new Error("Network error reaching storage");
    await sleep(500 * 2 ** (attempt - 1));
  }
};

type MultipartOpts = {
  eventId: string;
  relativePath: string;
  purpose: "media" | "document";
  /* The key /api/uploads/presign already minted for this file, signed so the
     server will accept it back. Passing it through is what makes the original
     land on the same key the thumbnail and preview slots were signed against;
     without it the multipart route mints a second key and the derivatives are
     orphaned. Optional only so callers that never call presign still work. */
  reservation?: string;
};

const api = async (payload: Record<string, unknown>) => {
  const res = await fetch("/api/uploads/multipart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    /* The server's message is the useful one — "Upload limit reached" or "You
       don't have access to this event" tells the uploader what to do next. */
    const said = await res.json().catch(() => null);
    throw new Error(said?.error || "Upload could not be prepared");
  }
  return res.json();
};

const multipartUpload = async (file: File, opts: MultipartOpts, onProgress: ProgressFn) => {
  /* fileSize is declared up front because the server signs a Content-Length
     into every part URL. The part layout therefore has to come back from the
     server rather than being recomputed here — a disagreement of one byte would
     make storage reject the part. */
  const {
    fileUrl,
    token,
    partSize,
    partCount: count
  }: { fileUrl: string; token: string; partSize: number; partCount: number } = await api({
    action: "create",
    purpose: opts.purpose,
    eventId: opts.eventId,
    relativePath: opts.relativePath,
    fileName: file.name,
    fileType: contentTypeOf(file),
    fileSize: file.size,
    reservation: opts.reservation
  });

  const numbers = Array.from({ length: count }, (_, i) => i + 1);
  const urls: Record<number, string> = {};

  const loaded = new Map<number, number>();
  const report = () => {
    let sum = 0;
    for (const v of loaded.values()) sum += v;
    onProgress(Math.min(99, Math.round((sum / file.size) * 100)));
  };

  const etags = new Map<number, string>();
  const queue = [...numbers];

  const worker = async () => {
    for (;;) {
      const partNumber = queue.shift();
      if (!partNumber) return;

      const start = (partNumber - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));

      let lastError = "";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Content-Type is deliberately omitted: it is set once on the object at
        // create time, and signing it per part invites signature mismatches.
        const res = await putBlob(urls[partNumber], blob, null, (bytes) => {
          loaded.set(partNumber, bytes);
          report();
        });

        if (res.ok && res.etag) {
          etags.set(partNumber, res.etag);
          loaded.set(partNumber, blob.size);
          report();
          break;
        }

        if (res.ok && !res.etag) {
          throw new Error("Storage did not return an ETag — add ExposeHeaders: [\"ETag\"] to the bucket CORS policy");
        }

        lastError = res.status ? `part ${partNumber} failed (${res.status})` : `part ${partNumber} lost connection`;
        loaded.set(partNumber, 0);
        report();

        // An expired signature is worth re-minting once before giving up.
        if (res.status === 403) {
          const { urls: fresh } = await api({ action: "sign", token, partNumbers: [partNumber] });
          Object.assign(urls, fresh);
        }

        if (attempt === MAX_ATTEMPTS) throw new Error(lastError);
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  };

  /* Everything after create lives in here. The part-signing loop used to sit
     above the try, so a network blip or a 5xx while minting signatures threw
     past the abort: the multipart upload stayed open in the bucket forever and,
     for a photographer, the bytes it reserved stayed charged forever. Nothing
     between create and complete may escape without aborting. */
  try {
    // Signatures are minted in batches; one request per part would be absurd.
    for (let i = 0; i < numbers.length; i += 500) {
      const batch = numbers.slice(i, i + 500);
      const { urls: got } = await api({ action: "sign", token, partNumbers: batch });
      Object.assign(urls, got);
    }

    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, count) }, worker));
    await api({
      action: "complete",
      token,
      parts: [...etags.entries()].map(([partNumber, etag]) => ({ partNumber, etag }))
    });
    onProgress(100);
    return fileUrl;
  } catch (error) {
    /* Leave no half-uploaded parts behind to be billed for — and, for a
       photographer, this is what gives the reserved bytes back. */
    await api({ action: "abort", token }).catch(() => {});
    throw error;
  }
};

/** Everything uploadFile accepts. Exported so callers can type their options. */
export type UploadFileOpts = MultipartOpts & {
  /** presign's single-PUT slot; only used when the file is under the threshold */
  presignedUrl?: string;
  /** the URL that slot writes to, returned as-is on the single-PUT path */
  fileUrl?: string;
};

/**
 * Uploads one file and returns the URL it was stored at.
 * Small files take a single PUT; large ones are split and retried per part.
 *
 * Pass `reservation` from the presign response whenever there is one: it is
 * what keeps the object on the key the thumbnail and preview were signed
 * against, on both paths.
 */
export const uploadFile = async (
  file: File,
  opts: UploadFileOpts,
  onProgress: ProgressFn
): Promise<string> => {
  if (file.size <= MULTIPART_THRESHOLD && opts.presignedUrl && opts.fileUrl) {
    await simpleUpload(opts.presignedUrl, file, onProgress);
    return opts.fileUrl;
  }
  return multipartUpload(file, opts, onProgress);
};
