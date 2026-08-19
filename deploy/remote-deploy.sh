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
# --scale caddy=0: the per-stack Caddy from the base compose file is unused;
#   the single edge Caddy in /srv/mysp/edge fronts both stacks on 443.
# migrate runs first and must exit 0 — compose enforces that ordering, so a
#   failed migration stops the deploy instead of booting web against an old
#   schema.
stack up -d --no-build --remove-orphans --scale caddy=0

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
# Dangling layers only. The previous release's images are deliberately kept:
# they are the rollback (see the runbook in deploy/bootstrap.sh).
docker image prune -f >/dev/null

echo "--- deployed $IMAGE_TAG"
stack ps
