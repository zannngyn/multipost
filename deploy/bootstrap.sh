#!/usr/bin/env bash
# One-time VPS setup. Run it ON THE SERVER, as the deploy user, once — after
# that CI owns the box and this script is only useful as a runbook.
#
#   curl -fsSL <raw url>/deploy/bootstrap.sh | bash     # or scp it over
#   sudo bash deploy/bootstrap.sh                        # if /srv needs root
#
# What it does NOT do: fill in secrets. It leaves .env templates in place and
# stops, because a bootstrap that invents a SESSION_SECRET is a bootstrap that
# ships the same secret to everyone who ran it.
#
# ---------------------------------------------------------------------------
# LAYOUT it creates
#
#   /srv/mysp/edge/   one Caddy, binds 80/443, routes both hostnames
#   /srv/mysp/stg/    staging stack   (COMPOSE_PROJECT_NAME=mysp-stg)
#   /srv/mysp/prod/   production stack (COMPOSE_PROJECT_NAME=mysp-prod)
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
NETWORK=mysp-edge

say() { printf '\n=== %s\n' "$*"; }

say "checking prerequisites"
command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker compose version >/dev/null || { echo "the docker compose plugin is missing" >&2; exit 1; }
docker info >/dev/null 2>&1 || {
  echo "cannot talk to the docker daemon as $(id -un) — add the user to the 'docker' group" >&2
  exit 1
}

say "shared edge network"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "  $NETWORK already exists"
else
  docker network create "$NETWORK"
  echo "  created $NETWORK"
fi

say "directories"
for dir in edge stg prod; do
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
place_env "$ROOT/edge/.env" "$here/env/edge.env.example"

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

say "edge stack files"
for f in docker-compose.yml Caddyfile; do
  if [ -f "$ROOT/edge/$f" ]; then
    echo "  $ROOT/edge/$f already exists, left untouched"
  else
    cp "$here/edge/$f" "$ROOT/edge/$f"
    echo "  $ROOT/edge/$f created"
  fi
done

cat <<EOF

=== done. Remaining steps, in order:

  1. Fill in the secrets:
       $ROOT/prod/.env   $ROOT/stg/.env   $ROOT/edge/.env
     Generate the random ones with:
       openssl rand -base64 32      # SESSION_SECRET, MEDIA_SIGNING_SECRET,
                                    # TENANT_SECRETS_ENC_KEY
       openssl rand -hex 24         # POSTGRES_PASSWORD — hex, not base64:
                                    # it goes inside DATABASE_URL, where a
                                    # base64 "/" makes the URL invalid

  2. Point DNS at this server — two type-A records at Cloudflare, both
     "DNS only" (grey cloud), both to this box's public IP:
       mysp       -> production
       mysp-stg   -> staging
     Open inbound 80 and 443. Port 80 is not optional: ACME uses it.

  3. Start the edge proxy (it is fine that no stack exists yet):
       cd $ROOT/edge && docker compose up -d

  4. Add these to the GitHub repository (Settings -> Secrets and variables):
       secret  DEPLOY_SSH_HOST         this server's public IP
       secret  DEPLOY_SSH_USER         $(id -un)
       secret  DEPLOY_SSH_KEY          private key whose public half is in
                                       ~/.ssh/authorized_keys here
       secret  DEPLOY_SSH_KNOWN_HOSTS  output of: ssh-keyscan -H <public-ip>
       variable DEPLOY_SSH_PORT        22, unless sshd moved

     Then, per GitHub Environment:
       environment "staging"     variable DEPLOY_PATH = $ROOT/stg
       environment "production"  variable DEPLOY_PATH = $ROOT/prod
     Put a required reviewer on "production" if a deploy should need a human.

  5. Push to the stg branch. CI builds, pushes to GHCR and deploys here.
EOF
