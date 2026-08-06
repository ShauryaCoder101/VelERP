/* S3 keys carry the folder structure, so no schema change is needed to know
   which folder a file came from — the key is the record.

     uploads/<eventId>/<folder>/<timestamp>-<name>   folder upload
     uploads/<eventId>/<timestamp>-<name>            loose file

   Everything is sanitised segment by segment, and "." / ".." are dropped, so
   a crafted webkitRelativePath cannot escape the event's prefix. */

const sanitizeSegment = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120) || "_";

export const splitFolderSegments = (relativePath: string) =>
  (relativePath || "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .map(sanitizeSegment);

export const buildUploadKey = (eventId: string, relativePath: string, fileName: string) => {
  const folder = splitFolderSegments(relativePath);
  const prefix = folder.length ? `${folder.join("/")}/` : "";
  return `uploads/${sanitizeSegment(eventId)}/${prefix}${Date.now()}-${sanitizeSegment(fileName)}`;
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

/* The display name, with the timestamp prefix the key added stripped back off. */
export const displayNameFromFileUrl = (fileUrl: string) => {
  const raw = decodeURIComponent(fileUrl.split("/").pop() ?? "file");
  return raw.replace(/^\d{10,}-/, "");
};

/* Browsing a 300GB shoot at full resolution is what makes S3 expensive, so the
   browser renders a small preview and thumbnail at upload time and stores them
   beside the original. Their location is a pure function of the original key,
   so no extra columns are needed to find them again.

     uploads/<eventId>/<folder>/<ts>-<name>
     uploads/<eventId>/<folder>/.derived/thumb/<ts>-<name>.jpg
     uploads/<eventId>/<folder>/.derived/preview/<ts>-<name>.jpg

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
