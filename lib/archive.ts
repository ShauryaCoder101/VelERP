/* When originals go cold.
 *
 * Measured from UPLOAD time, not event date — that is what the storage layer
 * actually ages on, and photographers routinely deliver weeks after a shoot.
 * Upload.createdAt is written the moment the object lands, so it tracks the
 * object's own age to within seconds.
 *
 * The same window drives rclone's --min-age, so what the ERP claims is cold
 * and what has actually moved stay in step. The date is only a prediction
 * though; a read that comes back InvalidObjectState is the real answer, so
 * callers should treat a storage error as authoritative over this. */

export const ARCHIVE_AFTER_DAYS = Number(process.env.ARCHIVE_AFTER_DAYS || 60);

const DAY_MS = 86_400_000;

export const isArchived = (uploadedAt: string | Date) => {
  const at = uploadedAt instanceof Date ? uploadedAt : new Date(uploadedAt);
  if (Number.isNaN(at.getTime())) return false;
  return Date.now() - at.getTime() > ARCHIVE_AFTER_DAYS * DAY_MS;
};

export const daysUntilArchived = (uploadedAt: string | Date) => {
  const at = uploadedAt instanceof Date ? uploadedAt : new Date(uploadedAt);
  if (Number.isNaN(at.getTime())) return null;
  const left = Math.ceil((at.getTime() + ARCHIVE_AFTER_DAYS * DAY_MS - Date.now()) / DAY_MS);
  return left > 0 ? left : 0;
};

/* Thumbnails and previews are never archived — they are what keeps a ten-year-old
   gallery browsable — so anything under .derived/ stays hot regardless of age. */
export const isDerivedKey = (key: string) => key.includes("/.derived/");
