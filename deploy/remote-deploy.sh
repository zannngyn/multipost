#!/usr/bin/env bash
# Runs ON THE VPS, piped in over SSH by .github/workflows/deploy.yml.
#
# The workflow prepends `export` lines for the variables below, so nothing
# sensitive ever appears in the remote argv (where any user on the box could
# read it out of `ps`).
#
# Required: DEPLOY_PATH IMAGE_PREFIX IMAGE_TAG GHCR_USER GHCR_TOKEN
#
# Safe to re-run: every step is idempotent, and a failed health check leaves the
# previous containers' logs on stdout rather than a silent green tick.
set -euo pipefail

for var in DEPLOY_PATH IMAGE_PREFIX IMAGE_TAG GHCR_USER GHCR_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "remote-deploy: $var is not set" >&2
    exit 1
  fi
done

cd "$DEPLOY_PATH"

if [ ! -f .env ]; then
  echo "remote-deploy: $DEPLOY_PATH/.env is missing — run deploy/bootstrap.sh first" >&2
  exit 1
fi

stack() { sh ./deploy/stack.sh "$@"; }

cleanup() {
  # Whatever happened, do not leave a registry credential sitting in
  # ~/.docker/config.json between deploys.
  docker logout ghcr.io >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- login to ghcr.io"
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

echo "--- preflight: required variables"
# WHY THIS EXISTS: compose stops at the FIRST unresolved `:?` variable, so a
# stack whose .env predates a feature reveals its gaps one deploy at a time —
# fix MINIO_ACCESS_KEY, redeploy, discover MINIO_PUBLIC_ENDPOINT, redeploy.
# This reports every one of them in a single run, before anything is pulled.
#
# The list is DERIVED from the compose files, never typed here: a hardcoded copy
# is a second source of truth that drifts the moment someone adds a variable.
required="$(grep -oh '\${[A-Z_][A-Z0-9_]*:?' \
              docker-compose.yml docker-compose.prod.yml \
            | sed 's/\${//; s/:?$//' | sort -u)"

# Resolution order mirrors stack.sh exactly, later wins; a value already
# exported into this shell counts as set.
resolve() {
  _v=""
  for _f in .env .image-tag.env; do
    [ -f "$_f" ] || continue
    _line="$(grep -E "^[[:space:]]*$1=" "$_f" | tail -n 1 || true)"
    [ -n "$_line" ] && _v="${_line#*=}"
  done
  # The exported value wins over every file, same as compose treats it.
  eval "_e=\${$1:-}"
  [ -n "$_e" ] && _v="$_e"
  printf '%s' "$_v"
}

missing=""
for var in $required; do
  [ -n "$(resolve "$var")" ] || missing="$missing $var"
done

if [ -n "$missing" ]; then
  echo "remote-deploy: $DEPLOY_PATH/.env is missing required values:" >&2
  for var in $missing; do echo "    $var" >&2; done
  echo "  Add them to $DEPLOY_PATH/.env — the template with the current full set" >&2
  echo "  is deploy/env/prod.env.example in the repo. The MinIO credentials come" >&2
  echo "  from /srv/_infra/new-app-s3.sh and belong in that same file." >&2
  exit 1
fi
echo "  all $(echo "$required" | wc -w | tr -d ' ') required variables resolve"

echo "--- pin release $IMAGE_TAG"
# Written, not appended: this file IS the record of what is deployed.
cat > .image-tag.env <<EOF
# Written by CI on every deploy. Do not edit by hand — the next deploy
# overwrites it. Operator settings belong in .env.
IMAGE_PREFIX=$IMAGE_PREFIX
IMAGE_TAG=$IMAGE_TAG
EOF

echo "--- pull images"
stack pull --quiet

echo "--- start stack"
# --no-build: the VPS must never build. Building here competes for RAM with the
#   production containers, and a build failure would happen after the old ones
#   are already stopped.
# migrate runs first and must exit 0 — compose enforces that ordering, so a
#   failed migration stops the deploy instead of booting web against an old
#   schema.
# There is no proxy to start: Traefik in /srv/_infra picks the app up from the
#   labels in docker-compose.prod.yml as soon as the container joins `edge`.
stack up -d --no-build --remove-orphans

echo "--- seed the base rows"
# Not optional, despite the file calling itself a "development seed": every
# screen in src/ui hard-codes DEMO_TENANT_ID, so a database without that tenant
# row fails the FK on the first write. A fresh staging deploy proved it — the
# Facebook Page import fetched the Page fine and then died on
# `insert into tenant_integration ... field: tenantId`.
#
# Safe to repeat: seed() is one transaction that converges to the same two rows
# (tenant + demo user) and writes no business data.
#
# `< /dev/null` IS LOAD-BEARING, and its absence is invisible. This whole script
# arrives on the box as the STDIN of `bash -s` (deploy.yml). `docker compose run`
# attaches stdin to the container, so without the redirect it swallows every
# remaining line of this file: bash then hits EOF and exits 0. The deploy would
# report success having never waited for a healthcheck, never printed a failure
# log and never pruned an image — the one failure mode a green tick cannot show
# you.
stack run --rm --no-deps migrate pnpm db:seed < /dev/null

echo "--- wait for health"
wait_healthy() {
  local service="$1" cid status=""
  cid="$(stack ps -q "$service")"
  if [ -z "$cid" ]; then
    echo "  $service: no container started" >&2
    return 1
  fi
  # 60 x 5s = 5 minutes. The web image's own start_period is 20s; the slack is
  # for a cold Next.js boot on a small VPS under a concurrent staging deploy.
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo gone)"
    case "$status" in
      healthy) echo "  $service: healthy"; return 0 ;;
      none)    echo "  $service: no healthcheck defined, treating running as ok"; return 0 ;;
      gone)    echo "  $service: container disappeared" >&2; return 1 ;;
    esac
    sleep 5
  done
  echo "  $service: still '$status' after 5 minutes" >&2
  return 1
}

failed=0
for service in web worker; do
  if ! wait_healthy "$service"; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "--- deploy FAILED, last 100 log lines per service"
  stack logs --tail 100 migrate web worker || true
  exit 1
fi

echo "--- reclaim disk"
# Two passes. Dangling layers always; then unused images older than a week,
# because this VPS is shared with other services and three fresh images land on
# it per release. A week still leaves several rollback targets — and
# `-a` only touches images no container is using, so the other services' images
# are never candidates.
docker image prune -f >/dev/null
docker image prune -af --filter "until=168h" >/dev/null

df -h / | awk 'NR==2 {print "  root filesystem: " $4 " free (" $5 " used)"}'

echo "--- deployed $IMAGE_TAG"
stack ps
