# Velocity ERP — working rules

## Deleting data requires an explicit typed confirmation

Before deleting **anything** that already exists — database rows, S3/R2 objects,
or whole tables — stop and ask. Show exactly what will be deleted (counts, names,
which table or bucket), then wait for the user to reply with:

```
DELETE_THESE_ITEMS
```

Nothing is deleted until that exact string comes back. "Yes", "go ahead", or
prior approval for a similar action do not count, and approval for one deletion
never carries over to the next.

This covers:
- `prisma.*.delete` / `deleteMany`, and any `DELETE`, `DROP`, `TRUNCATE` SQL
- `DeleteObjectCommand` against S3 or R2, including cleanup of test fixtures
- `rclone move` / `delete`, which removes from the source

It does **not** cover creating, updating, or additive migrations — those proceed
normally.

**Why:** this database and these buckets hold live business data — 28 events,
hundreds of gigabytes of client media, expense claims and sales pipeline. There
is no undo, and a deletion made in the middle of a task is easy to miss in a
wall of tool output. Typing the phrase forces a deliberate read of what is about
to go.

## Never run `prisma migrate dev` on this project

The migration history has drifted from the live schema (`sales_module.sql` and
`sales_module_v2.sql` were applied by hand). `migrate dev` cannot reconcile that
and will offer to reset the database, destroying everything.

Use `npx prisma migrate deploy`, which only applies pending migration folders and
does no schema diffing. Write migration SQL by hand rather than generating it
with `migrate dev --create-only`.

## Storage layout

Media is split by cost profile — see [STORAGE.md](STORAGE.md).

- Bulk event media → Cloudflare R2 (zero egress)
- Documents: bills, cost sheets, avatars → S3
- Originals older than 60 days → S3 Glacier Deep Archive via rclone

Reads route by the stored `fileUrl`, so objects predating R2 keep serving from
S3. Never rewrite stored URLs to "migrate" them.

Thumbnails and previews live under `.derived/` beside each original and must
never be archived — every gallery in the ERP goes blank if they are.
