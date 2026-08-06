#!/usr/bin/env bash
#
# Move event originals older than the hot window from R2 into S3 Glacier
# Deep Archive. Run monthly from any machine with rclone — an office PC or a
# small VPS. It cannot run on Vercel: functions time out long before a few
# hundred gigabytes have moved.
#
#   ./scripts/archive-event-media.sh            # dry run, moves nothing
#   ./scripts/archive-event-media.sh --commit
#
# One-time rclone setup (rclone config):
#   remote "r2"        type=s3 provider=Cloudflare
#                      endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
#   remote "s3archive" type=s3 provider=AWS region=ap-south-1
#
set -euo pipefail

R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-velocity-media}"
ARCHIVE_REMOTE="${ARCHIVE_REMOTE:-s3archive}"
ARCHIVE_BUCKET="${S3_ARCHIVE_BUCKET:-velocity-archive}"
MIN_AGE="${ARCHIVE_AFTER_DAYS:-60}d"

DRY="--dry-run"
[ "${1:-}" = "--commit" ] && DRY=""

echo "source     : ${R2_REMOTE}:${R2_BUCKET}/uploads"
echo "destination: ${ARCHIVE_REMOTE}:${ARCHIVE_BUCKET}/uploads"
echo "min age    : ${MIN_AGE}"
echo "mode       : $([ -z "$DRY" ] && echo COMMIT || echo 'dry run')"
echo

# --exclude on .derived is load-bearing. Thumbnails and previews must stay on
# R2 or every gallery in the ERP goes blank until they are thawed.
#
# --min-age filters on the object's own age, which is what Upload.createdAt
# tracks in the database, so the UI and the storage stay in agreement.
rclone move \
  "${R2_REMOTE}:${R2_BUCKET}/uploads" \
  "${ARCHIVE_REMOTE}:${ARCHIVE_BUCKET}/uploads" \
  --min-age "${MIN_AGE}" \
  --exclude "**/.derived/**" \
  --s3-storage-class DEEP_ARCHIVE \
  --transfers 8 \
  --checkers 16 \
  --progress \
  --stats 30s \
  $DRY

echo
echo "Done. Objects keep the same key, so the ERP finds them in the archive"
echo "bucket without any database change."
