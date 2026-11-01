#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 2 ]; then
  echo "Usage: deploy-nova.sh <nova-client|nova-server|model-console> <release-dir>" >&2
  exit 2
fi

app_name=$1
case "$app_name" in
  nova-client) deploy_name=agent-web-ui ;;
  nova-server) deploy_name=agent-server ;;
  model-console) deploy_name=model-console ;;
  *) echo "Unknown application: $app_name" >&2; exit 2 ;;
esac

release_dir=$(CDPATH= cd -- "$2" && pwd)
app_root=/data/app
app_dir="$app_root/$deploy_name"
backup_dir="$app_root/nova-dsh-backups/$app_name-$(date -u +%Y%m%dT%H%M%SZ)-$$"

if [ "$app_name" = nova-server ]; then
  test -s "$release_dir/.env"
  test -s "$release_dir/dist/src/server.js"
  docker network inspect shared_network >/dev/null
  # Validate and migrate this application before stopping its previous version.
  cd "$release_dir"
  docker compose -p agent-server config --quiet
  docker compose -p agent-server run --rm --no-deps -T agent-server \
    node --env-file=.env scripts/check-deployment.mjs
  docker compose -p agent-server run --rm --no-deps -T agent-server \
    node node_modules/drizzle-kit/bin.cjs migrate --config=database/drizzle.config.ts
else
  test -s "$release_dir/dist/index.html"
fi

mkdir -p "$backup_dir"
if [ "$app_name" = nova-server ]; then
  if docker container inspect nova-agent-server >/dev/null 2>&1; then
    docker stop --time 30 nova-agent-server
    docker rm nova-agent-server
  fi
fi
if [ -e "$app_dir" ]; then
  mv "$app_dir" "$backup_dir/$deploy_name"
fi
mv "$release_dir" "$app_dir"

if [ "$app_name" = nova-server ]; then
  cd "$app_dir"
  docker compose -p agent-server up -d --force-recreate
  attempt=0
  until [ "$(docker inspect --format '{{.State.Health.Status}}' nova-agent-server)" = healthy ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      docker compose -p agent-server logs --no-color --tail=100 agent-server
      echo "Backend readiness failed. Previous files are in $backup_dir." >&2
      exit 1
    fi
    sleep 3
  done

  docker compose -p agent-server ps
else
  chmod 755 "$app_dir"
  chmod -R a+rX "$app_dir/dist"
fi

echo "$app_name deployment complete. Previous files: $backup_dir"
