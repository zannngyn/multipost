#!/bin/sh
# Compose wrapper for the deployed stack. Run it from the stack directory
# (/srv/multipost), which is where its .env lives:
#
#   ./deploy/stack.sh ps
#   ./deploy/stack.sh logs -f web
#   ./deploy/stack.sh exec -T web node -v
#
# It exists so nobody has to remember the flag soup — and so a hand-typed
# command is the SAME command CI runs. Two env files on purpose:
#   .env             operator-owned secrets and settings, never touched by CI
#   .image-tag.env   which image version is deployed, written by CI every run
#
# ORDER IS LOAD-BEARING: later --env-file wins, so .image-tag.env last means it
# can only ever override IMAGE_PREFIX/IMAGE_TAG and nothing else.
#
# NAMING BOTH FILES EXPLICITLY also excludes docker-compose.override.yml, which
# a bare `docker compose` would load automatically. That file is the local
# development stack (its own MinIO, its own Caddy) and must never reach the VPS.
set -eu

cd "$(dirname "$0")/.."

for f in .env .image-tag.env docker-compose.yml docker-compose.prod.yml; do
  if [ ! -f "$f" ]; then
    echo "stack.sh: missing $f in $(pwd)" >&2
    echo "  .env comes from deploy/env/prod.env.example;" >&2
    echo "  .image-tag.env comes from deploy/bootstrap.sh, then gets" >&2
    echo "  rewritten by CI on every deploy." >&2
    exit 1
  fi
done

exec docker compose \
  --env-file .env \
  --env-file .image-tag.env \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  "$@"
