# Connection URI (adjust if you need user/pass)
MONGO_URI="${MONGO_URI:-mongodb://127.0.0.1:27017}"

umask 022
mkdir -p "$OUT_DIR"

# Prevent overlapping runs
exec 9>/tmp/mongo_public_backup.lock
if ! flock -n 9; then
  echo "$(date -Is) another backup is already running" >> "$LOG_FILE"
  exit 0
fi

# Ensure mongodump is installed
if ! command -v mongodump >/dev/null 2>&1; then
  echo "$(date -Is) ERROR: mongodump not found" >> "$LOG_FILE"
  exit 1
fi

# Timestamped filename
ts="$(date +%F_%H%M)"
outfile="$OUT_DIR/meeray-$ts.gz"

# Run mongodump
mongodump --uri="$MONGO_URI" --archive="$outfile" --gzip

# Create checksum
sha256sum "$outfile" > "$outfile.sha256"

# Update "latest" symlinks
ln -sfn "$(basename "$outfile")" "$OUT_DIR/meeray-latest.gz"
ln -sfn "$(basename "$outfile").sha256" "$OUT_DIR/meeray-latest.sha256"

chmod 644 "$outfile" "$outfile.sha256" || true

# Cleanup old backups
find "$OUT_DIR" -type f -name 'meeray-*.gz' -mtime +$RETENTION_DAYS -delete
find "$OUT_DIR" -type f -name 'meeray-*.sha256' -mtime +$RETENTION_DAYS -delete

echo "$(date -Is) created $(basename "$outfile")" >> "$LOG_FILE"