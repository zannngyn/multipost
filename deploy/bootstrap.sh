#!/usr/bin/env bash
# One-time VPS setup. Run it ON THE SERVER as root, once — after that CI owns
# the box and this script is only useful as a runbook.
#
#   bash deploy/bootstrap.sh
#
# What it does NOT do: fill in secrets. It leaves .env templates in place and
# stops, because a bootstrap that invents a SESSION_SECRET is a bootstrap that
# ships the same secret to everyone who ran it.
#
# ---------------------------------------------------------------------------
# LAYOUT it creates
#
#   /srv/mysp/stg/    staging stack    (COMPOSE_PROJECT_NAME=mysp-stg,  :3110)
#   /srv/mysp/prod/   production stack (COMPOSE_PROJECT_NAME=mysp-prod, :3100)
#
# HTTPS comes from the Caddy already installed on this host under systemd — the
# one serving the other sites. MYSP does not run its own proxy: two processes
# cannot share :443. This script drops a site file into /etc/caddy/conf.d/ and
# makes sure the main Caddyfile imports that directory, so the existing site
# blocks are never edited.
#
# ---------------------------------------------------------------------------
# ROLLBACK runbook (there is no button; this is the procedure)
#
#   cd /srv/mysp/prod
#   docker image ls 'ghcr.io/zannngyn/mysp/web'      # find the previous sha
#   sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<previous-sha>/' .image-tag.env
#   ./deploy/stack.sh up -d --no-build --scale caddy=0
#
#   A rollback does NOT undo a database migration. If the bad release migrated
#   the schema, restore from deploy/backup/backup.sh's latest dump first.
set -euo pipefail

ROOT="${MYSP_ROOT:-/srv/mysp}"
CADDY_CONF_D=/etc/caddy/conf.d
CADDY_FILE=/etc/caddy/Caddyfile

say() { printf '\n=== %s\n' "$*"; }

say "checking prerequisites"
command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker compose version >/dev/null || { echo "the docker compose plugin is missing" >&2; exit 1; }
docker info >/dev/null 2>&1 || {
  echo "cannot talk to the docker daemon as $(id -un)" >&2
  exit 1
}
command -v caddy >/dev/null || { echo "caddy is not installed on this host" >&2; exit 1; }
test -f "$CADDY_FILE" || { echo "$CADDY_FILE not found" >&2; exit 1; }

say "directories"
for dir in stg prod; do
  mkdir -p "$ROOT/$dir"
  echo "  $ROOT/$dir"
done

say "env templates"
# Never clobber a filled-in .env: this script is re-runnable, and the whole
# point of keeping secrets out of git is that they only exist here.
here="$(cd "$(dirname "$0")" && pwd)"
place_env() {
  local target="$1" template="$2"
  if [ -f "$target" ]; then
    echo "  $target already exists, left untouched"
  elif [ -f "$template" ]; then
    cp "$template" "$target"
    chmod 600 "$target"
    echo "  $target created from $(basename "$template") — FILL IT IN"
  else
    echo "  $template not found; copy it from the repo by hand" >&2
  fi
}
place_env "$ROOT/prod/.env" "$here/env/prod.env.example"
place_env "$ROOT/stg/.env"  "$here/env/stg.env.example"

say "image-tag placeholders"
# CI overwrites these on the first deploy. They exist now only so that
# deploy/stack.sh gives a useful error instead of a compose interpolation crash
# if someone runs it before the first pipeline.
for stack in prod stg; do
  file="$ROOT/$stack/.image-tag.env"
  if [ -f "$file" ]; then
    echo "  $file already exists, left untouched"
  else
    cat > "$file" <<'EOF'
# Written by CI on every deploy. Placeholder until the first pipeline runs.
IMAGE_PREFIX=ghcr.io/zannngyn/mysp
IMAGE_TAG=bootstrap
EOF
    echo "  $file created"
  fi
done

say "caddy site blocks"
mkdir -p "$CADDY_CONF_D"
cp "$here/edge/mysp.caddy" "$CADDY_CONF_D/mysp.caddy"
echo "  installed $CADDY_CONF_D/mysp.caddy"

# Add the import exactly once, and only if it is not already there — this file
# belongs to whoever set the box up, and it has other sites in it.
if grep -qF "$CADDY_CONF_D" "$CADDY_FILE"; then
  echo "  $CADDY_FILE already imports $CADDY_CONF_D"
else
  cp "$CADDY_FILE" "$CADDY_FILE.bak.$(date +%Y%m%d%H%M%S)"
  printf '\n# Added by MYSP deploy/bootstrap.sh — site files live in their own directory.\nimport %s/*.caddy\n' "$CADDY_CONF_D" >> "$CADDY_FILE"
  echo "  appended the import (previous file backed up next to it)"
fi

say "validating caddy config"
# Validate BEFORE reloading: a reload with a broken config would take the other
# sites on this host down, and they have nothing to do with MYSP.
if caddy validate --config "$CADDY_FILE" --adapter caddyfile >/dev/null 2>&1; then
  echo "  config is valid"
  systemctl reload caddy
  echo "  caddy reloaded"
else
  echo "  CONFIG IS INVALID — not reloading. Details:" >&2
  caddy validate --config "$CADDY_FILE" --adapter caddyfile >&2 || true
  exit 1
fi

cat <<EOF

=== done. Remaining steps, in order:

  1. Fill in the secrets:
       $ROOT/prod/.env   $ROOT/stg/.env
     Generate the random ones with:
       openssl rand -base64 32      # SESSION_SECRET, MEDIA_SIGNING_SECRET,
                                    # TENANT_SECRETS_ENC_KEY
       openssl rand -hex 24         # POSTGRES_PASSWORD — hex, not base64:
                                    # it goes inside DATABASE_URL, where a
                                    # base64 "/" makes the URL invalid

  2. Check DNS resolves here — two type-A records, both "DNS only" on
     Cloudflare (grey cloud), both to this box's public IP:
       mysp.vannt.asia       -> production
       mysp-stg.vannt.asia   -> staging
     Caddy fetches a certificate on the first request to each hostname.

  3. Push to the stg branch. CI builds, pushes to GHCR and deploys here.
EOF
