#!/bin/sh
# Compose wrapper for a deployed stack. Run it from the stack directory
# (/srv/mysp/prod or /srv/mysp/stg), which is where its .env lives:
#
#   ./deploy/stack.sh ps
#   ./deploy/stack.sh logs -f web
#   ./deploy/stack.sh exec -T web node -v
#
# It exists so nobody has to remember the flag soup — and so a hand-typed
# command is the SAME command CI runs. Three env files on purpose:
#   .env             operator-owned secrets and settings, never touched by CI
#   .ci-secrets.env  secrets held in GitHub Secrets, written by CI every deploy
#   .image-tag.env   which image version is deployed, written by CI every run
#
# ORDER IS LOAD-BEARING, twice over. Later --env-file wins, so:
#   - .image-tag.env last means it can only ever override IMAGE_TAG;
#   - .ci-secrets.env AFTER .env because the shipped templates carry
#     `MINIO_ACCESS_KEY=` as an EMPTY line, and an empty value in a later file
#     still overrides. Put it first and every deploy would hand MinIO the empty
#     string that docker-compose.yml's `:?` exists to refuse.
#
# WHY A FILE AND NOT `export` IN CI'S SHELL: compose interpolates the whole file
# for every subcommand, so a credential that lives only in the deploy shell
# would make `stack.sh ps` / `logs` / `exec` fail on the box — breaking the one
# guarantee in the line above, that a hand-typed command is CI's command.
set -eu

cd "$(dirname "$0")/.."

for f in .env .ci-secrets.env .image-tag.env docker-compose.yml docker-compose.prod.yml; do
  if [ ! -f "$f" ]; then
    echo "stack.sh: missing $f in $(pwd)" >&2
    echo "  .env comes from deploy/env/{prod,stg}.env.example;" >&2
    echo "  .ci-secrets.env and .image-tag.env come from deploy/bootstrap.sh," >&2
    echo "  then get rewritten by CI on every deploy." >&2
    exit 1
  fi
done

exec docker compose \
  --env-file .env \
  --env-file .ci-secrets.env \
  --env-file .image-tag.env \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  "$@"
