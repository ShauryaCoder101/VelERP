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
};

const api = async (payload: Record<string, unknown>) => {
  const res = await fetch("/api/uploads/multipart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("Upload could not be prepared");
  return res.json();
};

const multipartUpload = async (file: File, opts: MultipartOpts, onProgress: ProgressFn) => {
  const { uploadId, key, fileUrl } = await api({
    action: "create",
    purpose: opts.purpose,
    eventId: opts.eventId,
    relativePath: opts.relativePath,
    fileName: file.name,
    fileType: contentTypeOf(file)
  });

  const partSize = partSizeFor(file.size);
  const count = Math.max(1, Math.ceil(file.size / partSize));
  const numbers = Array.from({ length: count }, (_, i) => i + 1);

  // Signatures are minted in batches; one request per part would be absurd.
  const urls: Record<number, string> = {};
  for (let i = 0; i < numbers.length; i += 500) {
    const batch = numbers.slice(i, i + 500);
    const { urls: got } = await api({ action: "sign", purpose: opts.purpose, key, uploadId, partNumbers: batch });
    Object.assign(urls, got);
  }

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
          const { urls: fresh } = await api({
            action: "sign",
            purpose: opts.purpose,
            key,
            uploadId,
            partNumbers: [partNumber]
          });
          Object.assign(urls, fresh);
        }

        if (attempt === MAX_ATTEMPTS) throw new Error(lastError);
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, count) }, worker));
    await api({
      action: "complete",
      purpose: opts.purpose,
      key,
      uploadId,
      parts: [...etags.entries()].map(([partNumber, etag]) => ({ partNumber, etag }))
    });
    onProgress(100);
    return fileUrl as string;
  } catch (error) {
    // Leave no half-uploaded parts behind to be billed for.
    await api({ action: "abort", purpose: opts.purpose, key, uploadId }).catch(() => {});
    throw error;
  }
};

/**
 * Uploads one file and returns the URL it was stored at.
 * Small files take a single PUT; large ones are split and retried per part.
 */
export const uploadFile = async (
  file: File,
  opts: MultipartOpts & { presignedUrl?: string; fileUrl?: string },
  onProgress: ProgressFn
): Promise<string> => {
  if (file.size <= MULTIPART_THRESHOLD && opts.presignedUrl && opts.fileUrl) {
    await simpleUpload(opts.presignedUrl, file, onProgress);
    return opts.fileUrl;
  }
  return multipartUpload(file, opts, onProgress);
};
