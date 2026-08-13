#!/usr/bin/env bash
# Throwaway Postgres + migrate + seed + one LIVE Drive/Sheet sync.
#
#   ./scripts/live-sync-smoke.sh              # live sources (needs a Service Account)
#   ./scripts/live-sync-smoke.sh --fixtures   # same harness, sample-data instead of Google
#   KEEP_DB=1 ./scripts/live-sync-smoke.sh    # leave the container up for inspection
#
# The container is named mysp-live-pg on an unusual port so it can never collide
# with the compose stack (or with anything the developer is already running).
# Credentials are read by the Node process from .env via `tsx --env-file`; this
# script never reads, copies or echoes them.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=mysp-live-pg
PORT=${LIVE_PG_PORT:-55437}
PG_IMAGE=postgres:16-alpine   # same major as docker-compose.yml
DB_URL="postgresql://mysp:mysp@127.0.0.1:${PORT}/mysp_live"

MODE=live
case "${1:-}" in
  --fixtures) MODE=fixtures ;;
  --catalog)  MODE=catalog ;;
esac

cleanup() {
  if [[ "${KEEP_DB:-0}" == "1" ]]; then
    echo "KEEP_DB=1 — leaving ${CONTAINER} up on port ${PORT} (DATABASE_URL=${DB_URL})"
    return
  fi
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
echo "starting ${CONTAINER} (${PG_IMAGE}) on port ${PORT}"
docker run -d --name "${CONTAINER}" \
  -e POSTGRES_USER=mysp -e POSTGRES_PASSWORD=mysp -e POSTGRES_DB=mysp_live \
  -p "${PORT}:5432" "${PG_IMAGE}" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "${CONTAINER}" pg_isready -U mysp -d mysp_live >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "${CONTAINER}" pg_isready -U mysp -d mysp_live

export DATABASE_URL="${DB_URL}"
export NODE_ENV=development
# Not used by these scripts, but loadConfig() validates it for every process.
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

# The signed media chain needs a signing secret. It is minted and verified
# inside this one process, so an ephemeral value is enough — but never override
# a real one the environment or .env already provides.
if [[ -z "${MEDIA_SIGNING_SECRET:-}" ]] && ! grep -qE '^MEDIA_SIGNING_SECRET=.+' .env 2>/dev/null; then
  MEDIA_SIGNING_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  export MEDIA_SIGNING_SECRET
  echo "MEDIA_SIGNING_SECRET is empty — using an ephemeral one for this run"
fi
if [[ -z "${MEDIA_PUBLIC_BASE_URL:-}" ]] && ! grep -qE '^MEDIA_PUBLIC_BASE_URL=.+' .env 2>/dev/null; then
  export MEDIA_PUBLIC_BASE_URL="http://localhost:3000"
fi

echo "== migrate =="
pnpm exec drizzle-kit migrate
echo "== seed =="
pnpm exec tsx src/adapters/db/seed.ts

# .env supplies the Service Account plus MEDIA_SIGNING_SECRET / MEDIA_PUBLIC_BASE_URL
# (the signed media chain needs them in BOTH modes). Values exported above win.
if [[ "${MODE}" == "catalog" ]]; then
  echo "== catalog-smoke (sample-data sync + catalog screen read models) =="
  pnpm exec tsx --env-file-if-exists=.env scripts/catalog-smoke.ts
elif [[ "${MODE}" == "fixtures" ]]; then
  echo "== live-sync-smoke --fixtures (harness self-test on sample-data) =="
  pnpm exec tsx --env-file-if-exists=.env scripts/live-sync-smoke.ts --fixtures
else
  echo "== live-sync-smoke (real Drive + Sheet) =="
  pnpm exec tsx --env-file-if-exists=.env scripts/live-sync-smoke.ts
fi
