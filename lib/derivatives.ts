/* Browser-side thumbnail and preview generation.
 *
 * A one-day shoot is 100-300GB. Paying S3 egress to push originals at anyone
 * who merely *browses* a gallery is the whole cost problem, so the machine that
 * already holds the file — the uploader's browser — renders the small versions
 * before the upload starts. Zero server compute, which matters on Vercel.
 *
 * Everything here is best-effort. If a codec is unsupported (HEIC is the common
 * case) the caller simply uploads the original and the viewer falls back to it.
 */

export const THUMB_EDGE = 400;
export const PREVIEW_EDGE = 1600;

const THUMB_QUALITY = 0.7;
const PREVIEW_QUALITY = 0.82;

const canvasToBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", quality));

const fit = (w: number, h: number, maxEdge: number) => {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
};

const draw = async (
  source: CanvasImageSource,
  sw: number,
  sh: number,
  maxEdge: number,
  quality: number
) => {
  const { w, h } = fit(sw, sh, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  return canvasToBlob(canvas, quality);
};

const decodeImage = async (file: File) => {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
  } finally {
    // Revoked after load resolves; the bitmap is already rasterised.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
};

/* Videos cannot be transcoded in-browser, but a poster frame is enough to make
   a gallery browsable without streaming a single byte of the original. */
const videoPoster = (file: File) =>
  new Promise<{ source: CanvasImageSource; w: number; h: number } | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;

    const done = (value: { source: CanvasImageSource; w: number; h: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    video.preload = "metadata";
    video.muted = true;
    (video as any).playsInline = true;

    video.onloadedmetadata = () => {
      // A frame at the very start is often black; step in a little.
      video.currentTime = Math.min(1, (video.duration || 2) / 10);
    };
    video.onseeked = () => done({ source: video, w: video.videoWidth, h: video.videoHeight });
    video.onerror = () => done(null);
    setTimeout(() => done(null), 15_000);

    video.src = url;
  });

export type Derivatives = { thumb: Blob | null; preview: Blob | null };

export const makeDerivatives = async (file: File): Promise<Derivatives> => {
  const empty: Derivatives = { thumb: null, preview: null };
  const type = file.type || "";

  try {
    if (type.startsWith("image/")) {
      const bitmap = await decodeImage(file);
      const w = "width" in bitmap ? bitmap.width : (bitmap as HTMLImageElement).naturalWidth;
      const h = "height" in bitmap ? bitmap.height : (bitmap as HTMLImageElement).naturalHeight;
      if (!w || !h) return empty;
      const [thumb, preview] = await Promise.all([
        draw(bitmap as CanvasImageSource, w, h, THUMB_EDGE, THUMB_QUALITY),
        draw(bitmap as CanvasImageSource, w, h, PREVIEW_EDGE, PREVIEW_QUALITY)
      ]);
      if ("close" in bitmap && typeof (bitmap as ImageBitmap).close === "function") {
        (bitmap as ImageBitmap).close();
      }
      return { thumb, preview };
    }

    if (type.startsWith("video/")) {
      const frame = await videoPoster(file);
      if (!frame || !frame.w || !frame.h) return empty;
      const [thumb, preview] = await Promise.all([
        draw(frame.source, frame.w, frame.h, THUMB_EDGE, THUMB_QUALITY),
        draw(frame.source, frame.w, frame.h, PREVIEW_EDGE, PREVIEW_QUALITY)
      ]);
      return { thumb, preview };
    }
  } catch {
    /* unsupported codec — the original still uploads */
  }

  return empty;
};
