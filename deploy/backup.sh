#!/bin/sh
# Bundled PostgreSQL + local uploads. Schedule this script and alert on nonzero exit.
set -eu
umask 077

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backup_dir=${1:?Usage: sh deploy/backup.sh /absolute/backup/directory}
case "$backup_dir" in /*) ;; *) echo 'Backup directory must be absolute' >&2; exit 1;; esac
cd "$project_dir"
mkdir -p -- "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump_tmp=$(mktemp "$backup_dir/.rentflow-db.XXXXXX")
compressed_tmp=''
uploads_tmp=''
cleanup() {
  rm -f -- "$dump_tmp"
  if [ -n "$compressed_tmp" ]; then rm -f -- "$compressed_tmp"; fi
  if [ -n "$uploads_tmp" ]; then rm -f -- "$uploads_tmp"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
compressed_tmp=$(mktemp "$backup_dir/.rentflow-gzip.XXXXXX")
uploads_tmp=$(mktemp "$backup_dir/.rentflow-uploads.XXXXXX")

# No pipeline can mask a failing pg_dump or tar exit status.
docker compose -f compose.prod.yaml --env-file .env.production exec -T postgres \
  pg_dump -U rentflow -d rentflow --format=custom > "$dump_tmp"
test -s "$dump_tmp"
gzip -c "$dump_tmp" > "$compressed_tmp"
gzip -t "$compressed_tmp"
docker compose -f compose.prod.yaml --env-file .env.production run --rm --no-deps -T --entrypoint tar api \
  -C /data -czf - uploads > "$uploads_tmp"
gzip -t "$uploads_tmp"

mv -- "$compressed_tmp" "$backup_dir/rentflow-$stamp.dump.gz"
mv -- "$uploads_tmp" "$backup_dir/rentflow-uploads-$stamp.tar.gz"
printf 'Backups completed: %s/rentflow-%s.dump.gz and uploads archive\n' "$backup_dir" "$stamp"
