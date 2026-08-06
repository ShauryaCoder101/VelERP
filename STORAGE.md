# Media storage

Three tiers, split by what the bytes cost to keep versus to deliver.

| Tier | Contents | Where | Access |
|---|---|---|---|
| Hot | Thumbnails + previews, **forever** | R2 | Instant |
| Warm | Originals, first 60 days from upload | R2 | Instant, no egress charge |
| Cold | Originals, 60 days+ | S3 Glacier Deep Archive | Restore first, 12–48h |

Documents — bills, cost sheets, avatars — stay on S3 Standard. They are small and
rarely read, so there is nothing to gain by moving them.

## Why it is split this way

S3 charges little to store and a lot to deliver (~$0.109/GB egress). R2 charges
for storage and **nothing** for egress. Event media is the only thing large
enough for that to matter, so only event media moves.

Thumbnails never leave R2. That is what keeps a five-year-old gallery browsable
even though its originals are frozen — you are reading ~2GB of derivatives, not
300GB of masters.

## Configuration

Nothing below is required. With no R2 variables set, every profile falls back to
S3 and behaviour is exactly as before.

```
# Cloudflare R2 — bulk event media
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=velocity-media
R2_PUBLIC_BASE_URL=          # optional, only for a custom domain

# S3 Glacier Deep Archive — cold originals
S3_ARCHIVE_BUCKET=velocity-archive

# Optional: shorten or lengthen the hot window (default 60)
ARCHIVE_AFTER_DAYS=60
```

Set these in `.env` **and** in Vercel for both Production and Preview.

### R2 bucket CORS

Browser uploads go straight to R2, so it needs a CORS rule or every upload fails
with an opaque network error:

```json
[{
  "AllowedOrigins": ["https://your-app.vercel.app", "http://localhost:3000"],
  "AllowedMethods": ["PUT", "GET"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]
```

Keep the bucket **private**. Everything is read through short-lived signed URLs.

## How reads find the right bucket

`Upload.fileUrl` stores the full URL, so the bucket is discoverable per file:

- URL starts with the S3 base → signed against S3
- URL starts with the R2 base → signed against R2
- File is past the hot window → same key, archive bucket

This means **no migration and no backfill**. Objects uploaded before R2 was
switched on keep serving from S3 indefinitely. Old and new coexist.

## Archiving

`Upload.createdAt` decides what the UI calls cold; `rclone --min-age` decides
what has actually moved. Both measure the same thing — age since upload — so
they stay in step.

Run monthly from any machine with rclone (not Vercel: functions time out long
before hundreds of gigabytes have moved):

```bash
./scripts/archive-event-media.sh            # dry run
./scripts/archive-event-media.sh --commit
```

The `--exclude "**/.derived/**"` inside that script is load-bearing. If
thumbnails are ever archived, every gallery in the ERP goes blank until they
thaw.

### Restoring

Staff open an archived file and press **Request original**. That issues a
Glacier restore (Standard ≈12h, Bulk ≈48h and ~8× cheaper) and the object stays
readable for 7 days. Clients never see a broken download button — the share page
tells them to ask their Velocity contact instead.

Deep Archive bills a **180-day minimum per object**, so archive to keep, not to
delete shortly after.

## Rough cost

At 12 events a year, 300GB each:

| | Year 1 | Year 3 (~10.8TB) |
|---|---|---|
| All S3 Standard | ~₹79,000 | ~₹2,76,000 + egress |
| All R2 | ~₹28,000 | ~₹1,65,000 |
| **Tiered** | **~₹28,000** | **~₹21,000** |

Verify current rates before relying on these; they were accurate in mid-2026.
