#!/bin/sh
# E11.4 — periodic pg_dump of the MYSP database.
#
# Runs as its own compose service (`pg-backup`) next to Postgres. No cron daemon:
# a sleep loop is one process, logs to stdout like every other service, and
# restarts with the container. `docker compose logs pg-backup` is the whole
# monitoring story.
#
# Format: custom (-Fc). It is compressed AND selective — `pg_restore --list`
# reads the table of contents without touching a server, and a single table can
# be restored from it. A plain .sql dump gives neither.
#
# Environment (all optional except the connection ones, see docker-compose.yml):
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE  standard libpq variables
#   BACKUP_DIR         where dumps land          (default /backups)
#   BACKUP_INTERVAL    seconds between dumps     (default 86400 = daily)
#   BACKUP_KEEP        how many dumps to keep    (default 7)
#   BACKUP_RUN_ONCE    "true" -> dump once and exit (for `compose run` + tests)
#
# RESTORE (what to actually type when the day comes):
#
#   1. List what is inside a dump — never restore blind:
#        docker compose run --rm --entrypoint pg_restore pg-backup \
#          --list /backups/mysp-20260813T020000Z.dump | head -50
#
#   2. Restore into a FRESH database first (never straight over production):
#        docker compose exec postgres createdb -U mysp mysp_restore
#        docker compose run --rm --entrypoint pg_restore pg-backup \
#          --no-owner --no-privileges --dbname \
#          "postgresql://mysp:$POSTGRES_PASSWORD@postgres:5432/mysp_restore" \
#          /backups/mysp-20260813T020000Z.dump
#        docker compose exec postgres psql -U mysp -d mysp_restore \
#          -c "select count(*) from post_job;"
#
#   3. Only then swap: stop web+worker, rename the databases, start again.
#        docker compose stop web worker
#        docker compose exec postgres psql -U mysp -d postgres \
#          -c 'alter database mysp rename to mysp_broken;' \
#          -c 'alter database mysp_restore rename to mysp;'
#        docker compose start web worker
#
#   A dump nobody has restored is not a backup. Do step 2 on a schedule.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL="${BACKUP_INTERVAL:-86400}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_RUN_ONCE="${BACKUP_RUN_ONCE:-false}"
DB_NAME="${PGDATABASE:-mysp}"

log() {
  # Same shape as the app logs: one JSON object per line.
  printf '{"level":"%s","time":"%s","service":"pg-backup","msg":"%s"%s}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "${3:-}"
}

# --- Edge cases first -------------------------------------------------------
if [ -z "${PGHOST:-}" ]; then
  log error "PGHOST is not set; refusing to guess the database host"
  exit 1
fi
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
  log error "Backup directory is not writable" ",\"dir\":\"$BACKUP_DIR\""
  exit 1
fi
case "$BACKUP_KEEP" in
  ''|*[!0-9]*|0)
    log error "BACKUP_KEEP must be a positive integer" ",\"value\":\"$BACKUP_KEEP\""
    exit 1
    ;;
esac

dump_once() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$BACKUP_DIR/$DB_NAME-$stamp.dump"
  tmp="$target.part"

  log info "Backup started" ",\"file\":\"$target\""
  # Write to a .part file first: a half-written dump must never look like a
  # usable backup, and the retention step below must never delete a good one to
  # keep a truncated one.
  if ! pg_dump --format=custom --compress=6 --file="$tmp" 2>/tmp/pg_dump.err; then
    log error "pg_dump failed" ",\"detail\":\"$(tr -d '\n\"' < /tmp/pg_dump.err | tail -c 400)\""
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$target"

  size="$(wc -c < "$target" | tr -d ' ')"
  # Proof the file is a readable dump, not just bytes on disk. Cheap: the table
  # of contents lives in the file, no server is involved.
  entries="$(pg_restore --list "$target" | grep -c ';' || true)"
  log info "Backup finished" ",\"file\":\"$target\",\"bytes\":$size,\"toc_entries\":$entries"

  prune
}

# Keeps the newest $BACKUP_KEEP dumps. Sorted by NAME, which is a UTC timestamp,
# so it does not depend on mtime surviving a copy.
prune() {
  total="$(ls -1 "$BACKUP_DIR"/"$DB_NAME"-*.dump 2>/dev/null | wc -l | tr -d ' ')"
  [ "$total" -le "$BACKUP_KEEP" ] && return 0
  ls -1 "$BACKUP_DIR"/"$DB_NAME"-*.dump | sort | head -n "$((total - BACKUP_KEEP))" |
    while IFS= read -r old; do
      rm -f "$old"
      log info "Old backup removed" ",\"file\":\"$old\",\"keep\":$BACKUP_KEEP"
    done
}

if [ "$BACKUP_RUN_ONCE" = "true" ]; then
  dump_once
  exit $?
fi

log info "Backup loop started" ",\"interval_s\":$BACKUP_INTERVAL,\"keep\":$BACKUP_KEEP"
while true; do
  # A failed dump must not kill the loop: the next window may well succeed, and
  # a dead backup container is a backup nobody notices is missing.
  dump_once || log warn "Backup attempt failed; will retry at the next interval"
  sleep "$BACKUP_INTERVAL"
done
