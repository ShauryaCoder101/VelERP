/* Picking up files while keeping the folder they came from.
 *
 * Photographers deliver structure ("Day 1/Stage", "Day 2/Candids") and every
 * gallery in the ERP groups by that folder, so a picker that flattens the drop
 * loses information we cannot recover later. Three routes have to agree on the
 * same shape: a multi-file <input>, a webkitdirectory <input>, and a drag from
 * the desktop — which is the awkward one, because dropped directories arrive as
 * filesystem *entries* rather than files and have to be walked.
 */

export type DroppedFile = { file: File; path: string };

/* readEntries hands back a batch at a time and signals the end with an empty
   batch — a single call silently truncates a large folder (Chrome caps it at
   100), so it is called until it comes back empty. */
const readEntry = (entry: any, parentPath: string, out: DroppedFile[]): Promise<void> =>
  new Promise((resolve) => {
    if (!entry) return resolve();

    if (entry.isFile) {
      entry.file(
        (file: File) => {
          out.push({ file, path: parentPath });
          resolve();
        },
        // An unreadable file is skipped rather than failing the whole drop.
        () => resolve()
      );
      return;
    }

    if (entry.isDirectory) {
      const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      const collected: any[] = [];
      const readBatch = () => {
        reader.readEntries(
          (entries: any[]) => {
            if (entries.length === 0) {
              Promise.all(collected.map((e) => readEntry(e, childPath, out))).then(() => resolve());
              return;
            }
            collected.push(...entries);
            readBatch();
          },
          () => resolve()
        );
      };
      readBatch();
      return;
    }

    resolve();
  });

/** Everything in a drop, folders walked, each file tagged with its folder path. */
export const readDataTransfer = async (dt: DataTransfer): Promise<DroppedFile[]> => {
  const out: DroppedFile[] = [];

  /* webkitGetAsEntry must be called synchronously while the DataTransfer is
     still live, so the entries are collected before any awaiting starts. */
  const entries = Array.from(dt.items)
    .map((item) => (typeof (item as any).webkitGetAsEntry === "function" ? (item as any).webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length > 0) {
    await Promise.all(entries.map((e: any) => readEntry(e, "", out)));
    return out;
  }

  // Browser without the entries API — plain files only, no structure to keep.
  return Array.from(dt.files).map((file) => ({ file, path: "" }));
};

/** Files from an <input type="file">, plain or webkitdirectory. */
export const readFileInput = (list: FileList | null): DroppedFile[] => {
  if (!list) return [];
  return Array.from(list).map((file) => {
    // webkitRelativePath is "Day 1/Stage/img.jpg"; we want the folder portion.
    const rel = (file as any).webkitRelativePath as string | undefined;
    return { file, path: rel ? rel.split("/").slice(0, -1).join("/") : "" };
  });
};

/** Sets webkitdirectory on an input — it is absent from the React typings. */
export const markAsDirectoryInput = (el: HTMLInputElement | null) => {
  if (!el) return;
  el.setAttribute("webkitdirectory", "");
  el.setAttribute("directory", "");
};
