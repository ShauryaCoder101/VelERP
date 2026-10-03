/* S3 keys carry the folder structure, so no schema change is needed to know
   which folder a file came from — the key is the record.

     uploads/<eventId>/<folder>/<timestamp>.<nonce>-<name>   folder upload
     uploads/<eventId>/<timestamp>.<nonce>-<name>            loose file

   Everything is sanitised segment by segment, and "." / ".." are dropped, so
   a crafted webkitRelativePath cannot escape the event's prefix. */

/* Exported because folder names now outlive the key that carries them: a firm's
   folder and a contributor's folder are stored in PhotographerProfile /
   UploadContributor and have to be sanitised to EXACTLY the same string the key
   would have used, or the stored name and the key prefix would disagree and a
   root check would reject the firm's own files. */
export const sanitizeSegment = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120)
    /* Trimmed AGAIN after the cut, which is what makes this function its own
       fixed point. Slicing a 140-character segment can land on a space, and a
       segment ending in one is a segment a SECOND pass through here would trim —
       which is exactly what the server does to a stored path
       (normalizeFolderPath / pathUnderRoot re-sanitise). The upload page compares
       its own one-pass answer against the two-pass one /api/uploads/existing
       reports, so without this the two strings differ by a trailing space and
       every file in such a folder is silently re-uploaded. */
    .trim() || "_";

export const splitFolderSegments = (relativePath: string) =>
  (relativePath || "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .map(sanitizeSegment);

/* The random half of a key's uniqueness.
 *
 * Date.now() alone is not unique: two presigns for the same event, folder and
 * file name in the same millisecond produced the IDENTICAL key. That was two
 * separate failures at once. At storage the second upload silently overwrote
 * the first and both registered as one Upload row — two photographers dropping
 * IMG_0001.jpg into one folder lost a photo with nothing reporting it. And in
 * the quota ledger each presign wrote its own full set of UploadCharge rows for
 * that one key; both terminal settlements for a key whose object exists KEEP
 * the charge ("landed" is never refunded, "registered" stamps every unsettled
 * row matching the key), so N identical keys became N permanent charges backed
 * by one stored object, with nothing that reconciles allocatedBytes against
 * storage afterwards.
 *
 * 48 bits per millisecond makes a collision not worth reasoning about: even at
 * a scripted 10,000 presigns inside one millisecond the chance of any pair
 * meeting is under one in a million, and the ceiling would stop the flood long
 * before that. derivativeKeyFor / derivativeUrlFor are pure functions of the
 * key and multipart's keyState already assumes keys are unique, so nothing else
 * has to change.
 *
 * Web Crypto rather than node:crypto on purpose — this module is imported by
 * client components (EventMedia), and a node builtin here would break the
 * browser bundle. */
const KEY_NONCE_HEX = 12;

const keyNonce = () => {
  const bytes = new Uint8Array(KEY_NONCE_HEX / 2);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/* The nonce is joined to the timestamp with a DOT, not a hyphen.
 *
 * With "<epochMs>-<nonce>-<name>" the prefix was ambiguous against the keys
 * written before the nonce existed, which are "<epochMs>-<name>" and are still
 * in the gallery. displayNameFromFileUrl has to strip the prefix off both, so
 * its nonce group is optional — and a legacy file genuinely called
 * "deadbeef0123-raw.jpg" parses as timestamp + nonce + "raw.jpg". The name
 * shown is then not the name the photographer uploaded, with nothing to say so.
 *
 * A dot cannot collide: sanitizeSegment turns every leading dot into "_", so no
 * sanitised file name begins with one, so no legacy key can have a "." directly
 * after its timestamp. "<digits>.<hex>-" therefore means the new form and only
 * the new form, and "<digits>-" means the legacy one. */
const KEY_NONCE_JOIN = ".";

/* What the timestamp-and-nonce prefix costs a key, for the length check in
   lib/upload-links.ts (folderPathRejection) — a 13-digit epoch, the dot, the
   nonce and the hyphen before the file name. Exported so that estimate cannot
   drift from this format. */
export const KEY_PREFIX_BYTES = 13 + KEY_NONCE_JOIN.length + KEY_NONCE_HEX + 1;

export const buildUploadKey = (eventId: string, relativePath: string, fileName: string) => {
  const folder = splitFolderSegments(relativePath);
  const prefix = folder.length ? `${folder.join("/")}/` : "";
  const stamp = `${Date.now()}${KEY_NONCE_JOIN}${keyNonce()}`;
  return `uploads/${sanitizeSegment(eventId)}/${prefix}${stamp}-${sanitizeSegment(fileName)}`;
};

/* Recover the folder path from a stored file URL, for grouping in the UI. */
export const folderFromFileUrl = (fileUrl: string, eventId: string) => {
  const marker = `/uploads/${eventId}/`;
  const at = fileUrl.indexOf(marker);
  if (at === -1) return "";
  const rest = fileUrl.slice(at + marker.length);
  const segments = rest.split("/");
  segments.pop(); // the file itself
  return segments.map((s) => decodeURIComponent(s)).join("/");
};

/* The display name, with the timestamp prefix the key added stripped back off.
 *
 * The nonce group is optional because every key written before the nonce
 * existed carries the timestamp alone, and those files are still in the
 * gallery. It is unambiguous because the nonce is attached with a dot and no
 * sanitised file name can begin with one (see KEY_NONCE_JOIN): a legacy
 * "<epochMs>-<name>" can never present itself as "<epochMs>.<nonce>-<name>".
 *
 * The hex run is matched loosely (8-16) rather than at exactly KEY_NONCE_HEX so
 * that changing the nonce length does not orphan the names already written. */
export const displayNameFromFileUrl = (fileUrl: string) => {
  const raw = decodeURIComponent(fileUrl.split("/").pop() ?? "file");
  return raw.replace(/^\d{10,}(?:\.[0-9a-f]{8,16})?-/, "");
};

/* Browsing a 300GB shoot at full resolution is what makes S3 expensive, so the
   browser renders a small preview and thumbnail at upload time and stores them
   beside the original. Their location is a pure function of the original key,
   so no extra columns are needed to find them again.

     uploads/<eventId>/<folder>/<ts>.<nonce>-<name>
     uploads/<eventId>/<folder>/.derived/thumb/<ts>.<nonce>-<name>.jpg
     uploads/<eventId>/<folder>/.derived/preview/<ts>.<nonce>-<name>.jpg

   The ".derived" segment is never written to the database, so derivatives
   never appear as files in their own right. */
export type Derivative = "thumb" | "preview";

export const derivativeKeyFor = (key: string, kind: Derivative) => {
  const at = key.lastIndexOf("/");
  if (at === -1) return `.derived/${kind}/${key}.jpg`;
  return `${key.slice(0, at)}/.derived/${kind}/${key.slice(at + 1)}.jpg`;
};

export const derivativeUrlFor = (fileUrl: string, kind: Derivative) => {
  const at = fileUrl.lastIndexOf("/");
  if (at === -1) return null;
  return `${fileUrl.slice(0, at)}/.derived/${kind}/${fileUrl.slice(at + 1)}.jpg`;
};
