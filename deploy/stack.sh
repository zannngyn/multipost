#!/bin/sh
# Compose wrapper for a deployed stack. Run it from the stack directory
# (/srv/mysp/prod or /srv/mysp/stg), which is where its .env lives:
#
#   ./deploy/stack.sh ps
#   ./deploy/stack.sh logs -f web
#   ./deploy/stack.sh exec -T web node -v
#
# It exists so nobody has to remember the flag soup — and so a hand-typed
# command is the SAME command CI runs. Two env files on purpose:
#   .env            operator-owned secrets and settings, never touched by CI
#   .image-tag.env  which image version is deployed, written by CI on every run
# Later --env-file wins, so .image-tag.env can only ever override IMAGE_TAG.
set -eu

cd "$(dirname "$0")/.."

for f in .env .image-tag.env docker-compose.yml docker-compose.prod.yml; do
  if [ ! -f "$f" ]; then
    echo "stack.sh: missing $f in $(pwd)" >&2
    echo "  .env comes from deploy/env/{prod,stg}.env.example; .image-tag.env from deploy/bootstrap.sh" >&2
    exit 1
  fi
done

exec docker compose \
  --env-file .env \
  --env-file .image-tag.env \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  "$@"
