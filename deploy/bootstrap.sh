#!/usr/bin/env bash
# One-time VPS setup. Run it ON THE SERVER, once — after that CI owns the box
# and this script is only useful as a runbook.
#
#   bash deploy/bootstrap.sh
#
# What it does NOT do: fill in secrets. It leaves the .env template in place and
# stops, because a bootstrap that invents a SESSION_SECRET is a bootstrap that
# ships the same secret to everyone who ran it.
#
# ---------------------------------------------------------------------------
# LAYOUT it creates
#
#   /srv/multipost/    the one production stack (COMPOSE_PROJECT_NAME=multipost)
#
# The directory name IS the compose project name, which names every volume.
# Renaming it later orphans the database.
#
# HTTPS and routing are NOT this stack's job. The box is fronted by
# Cloudflare Tunnel -> Traefik (a shared stack in /srv/_infra); Traefik finds
# the app through the labels in docker-compose.prod.yml, over the external
# `edge` network. Nothing here listens on :80 or :443.
#
# Object storage is the shared MinIO in /srv/minio. Provision this app's own
# buckets and service account BEFORE the first deploy:
#
#   /srv/_infra/new-app-s3.sh multipost
#
# ---------------------------------------------------------------------------
# ROLLBACK runbook (there is no button; this is the procedure)
#
#   cd /srv/multipost
#   docker image ls 'ghcr.io/zannngyn/multipost/web'   # find the previous sha
#   sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<previous-sha>/' .image-tag.env
#   ./deploy/stack.sh up -d --no-build
#
#   A rollback does NOT undo a database migration. If the bad release migrated
#   the schema, restore from deploy/backup/backup.sh's latest dump first.
set -euo pipefail

ROOT="${MULTIPOST_ROOT:-/srv/multipost}"

say() { printf '\n=== %s\n' "$*"; }

say "checking prerequisites"
command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker compose version >/dev/null || { echo "the docker compose plugin is missing" >&2; exit 1; }
docker info >/dev/null 2>&1 || {
  echo "cannot talk to the docker daemon as $(id -un)" >&2
  exit 1
}
# Both are created by /srv/_infra. Without them `up` fails on an external
# network that does not exist — better to say so now, by name.
for net in edge data; do
  docker network inspect "$net" >/dev/null 2>&1 || {
    echo "the external docker network '$net' does not exist — is /srv/_infra up?" >&2
    exit 1
  }
done

say "directories"
mkdir -p "$ROOT"
echo "  $ROOT"

say "env template"
# Never clobber a filled-in .env: this script is re-runnable, and the whole
# point of keeping secrets out of git is that they only exist here.
here="$(cd "$(dirname "$0")" && pwd)"
target="$ROOT/.env"
template="$here/env/prod.env.example"
if [ -f "$target" ]; then
  echo "  $target already exists, left untouched"
elif [ -f "$template" ]; then
  cp "$template" "$target"
  chmod 600 "$target"
  echo "  $target created from $(basename "$template") — FILL IT IN"
else
  echo "  $template not found; copy it from the repo by hand" >&2
fi

say "image-tag placeholder"
# CI overwrites this on the first deploy. It exists now only so that
# deploy/stack.sh gives a useful error instead of a compose interpolation crash
# if someone runs it before the first pipeline.
file="$ROOT/.image-tag.env"
if [ -f "$file" ]; then
  echo "  $file already exists, left untouched"
else
  cat > "$file" <<'EOF'
# Written by CI on every deploy. Placeholder until the first pipeline runs.
IMAGE_PREFIX=ghcr.io/zannngyn/multipost
IMAGE_TAG=bootstrap
EOF
  echo "  $file created"
fi

cat <<EOF

=== done. Remaining steps, in order:

  1. Provision object storage (creates the buckets and a service account that
     can only touch them):
       /srv/_infra/new-app-s3.sh multipost
     Copy the printed access key / secret key into MINIO_ACCESS_KEY and
     MINIO_SECRET_KEY in $ROOT/.env. Do NOT use MinIO's root credential.

  2. Fill in the rest of the secrets in $ROOT/.env.
     Generate the random ones with:
       openssl rand -base64 32      # SESSION_SECRET, MEDIA_SIGNING_SECRET,
                                    # TENANT_SECRETS_ENC_KEY
       openssl rand -hex 24         # POSTGRES_PASSWORD — hex, not base64:
                                    # it goes inside DATABASE_URL, where a
                                    # base64 "/" makes the URL invalid

  3. Route the hostname through the tunnel (as root), then check it in
     Cloudflare: a CNAME to <tunnel-id>.cfargotunnel.com, Proxied.
       cloudflared tunnel route dns <tunnel-id> multipost.vannt.asia

  4. OPTIONAL. Every deploy logs this host into GHCR itself (remote-deploy.sh
     does it with the workflow's own GITHUB_TOKEN, then logs back out), so
     nothing is needed here for CI to work. Only a MANUAL \`compose pull\`
     before the first pipeline needs a credential of your own:
       echo <PAT-with-read:packages> | docker login ghcr.io -u zannngyn --password-stdin

  5. Push to the main branch. CI builds, pushes to GHCR and deploys here.
EOF
