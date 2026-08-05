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
