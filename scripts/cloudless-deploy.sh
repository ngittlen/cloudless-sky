#!/usr/bin/env bash
#
# Updates Cloudless Sky on the cloudless-sky VM to the latest main and
# restarts its containers. See "Updating to a new version" in
# docs/cloudless-sky.md.
#
#   scripts/cloudless-deploy.sh             pull main, rebuild, restart
#   scripts/cloudless-deploy.sh --no-pull   rebuild and restart the current checkout
#   scripts/cloudless-deploy.sh --rollback  go back to the previous images
#
# The running containers keep serving while the new images build, so a failed
# build changes nothing. If the new containers don't answer their health
# checks, the script puts the previous images back.

set -euo pipefail

# The braces make bash read the whole script before running it, because the
# git pull below can replace this file while it runs.
{

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f compose.cloudless.yaml)
IMAGES=(cloudless-sky cloudless-sync)
HEALTH_URLS=(
  http://127.0.0.1:8100/robots.txt
  http://127.0.0.1:8101/sync/health
)
HEALTH_TIMEOUT_SECONDS=${CLOUDLESS_HEALTH_TIMEOUT:-90}

pull=true
rollback=false
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=false ;;
    --rollback) rollback=true ;;
    -h | --help)
      sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

log() {
  printf '\n==> %s\n' "$*"
}

image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

# Waits until every health URL answers, or the timeout passes.
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local url
  while ((SECONDS < deadline)); do
    local ok=true
    for url in "${HEALTH_URLS[@]}"; do
      if ! curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
        ok=false
        break
      fi
    done
    if $ok; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Points each image's latest tag back at its previous tag and recreates the
# containers from them without building.
restore_previous() {
  local image restored=false
  for image in "${IMAGES[@]}"; do
    if image_exists "$image:previous"; then
      docker tag "$image:previous" "$image:latest"
      restored=true
    else
      echo "No $image:previous image; leaving $image:latest as it is."
    fi
  done
  if ! $restored; then
    echo "Nothing to roll back to." >&2
    return 1
  fi
  "${COMPOSE[@]}" up -d
}

if $rollback; then
  log "Rolling back to the previous images"
  restore_previous
  if wait_healthy; then
    log "Rolled back; both servers answer"
    "${COMPOSE[@]}" ps
    exit 0
  fi
  echo "The previous images don't answer either. Logs:" >&2
  "${COMPOSE[@]}" logs --tail 50 >&2
  exit 1
fi

if $pull; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "The checkout has uncommitted changes; commit or discard them first." >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi
  log "Pulling main"
  git checkout main
  git pull --ff-only
fi

commit=$(git rev-parse --short HEAD)
log "Deploying $commit: $(git log -1 --format=%s)"

"${COMPOSE[@]}" config --quiet

# The previous tag keeps the image that is running now, for rolling back.
for image in "${IMAGES[@]}"; do
  if image_exists "$image:latest"; then
    docker tag "$image:latest" "$image:previous"
  fi
done

log "Building images (the current containers keep running)"
CLOUDLESS_COMMIT="$commit" "${COMPOSE[@]}" build

log "Restarting containers"
CLOUDLESS_COMMIT="$commit" "${COMPOSE[@]}" up -d

log "Waiting for both servers to answer"
if ! wait_healthy; then
  echo "The new containers didn't answer within ${HEALTH_TIMEOUT_SECONDS}s. Logs:" >&2
  "${COMPOSE[@]}" logs --tail 50 >&2
  log "Rolling back to the previous images"
  if restore_previous && wait_healthy; then
    echo "Rolled back. $commit is not deployed." >&2
  else
    echo "Rollback failed too; check the logs above." >&2
  fi
  exit 1
fi

# Removes only untagged images, so latest and previous stay.
docker image prune -f >/dev/null

log "Deployed $commit"
"${COMPOSE[@]}" ps
exit 0
}
