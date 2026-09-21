#!/bin/sh
# Starts an image the way production starts it and asks it what it is: /livez
# must answer, /health must name the version from package.json and the commit
# the image was built from, and the service must not run as a surprise.
# No broker is started; /health answers 503 "degraded" then, which is fine.
#
#   sh scripts/image-smoke.sh <image> <expected commit>
#
# Bounded by the clock: an image that accepts connections and never answers
# used to keep this script (and the CI job) waiting for ever.
set -eu

IMAGE="${1:?image}"
COMMIT="${2:?expected commit}"
NAME="moshi-image-smoke-$$"
VERSION="$(node -p "require('./package.json').version")"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Production mode, as on Coolify: three different secrets, or the config
# refuses to start. That path was never exercised in development mode.
docker run -d --name "$NAME" -p 127.0.0.1:0:3000 \
  -e NODE_ENV=production -e PORT=3000 -e DATABASE_PATH=/tmp/smoke.db -e NATS_URL=nats://127.0.0.1:1 \
  -e MESH_ADMIN_TOKEN=smoke-admin-token-0123456789abcdef0123456789 \
  -e MESH_COOKIE_SECRET=smoke-cookie-secret-0123456789abcdef01234567 \
  -e OAUTH_SECRET=smoke-oauth-secret-0123456789abcdef0123456789 \
  "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 3000/tcp | grep -E '^(0\.0\.0\.0|127\.0\.0\.1):' | head -n1 | sed 's/.*://')"
[ -n "$PORT" ] || { echo "image-smoke: no published port" >&2; docker logs "$NAME" >&2 || true; exit 1; }

DEADLINE=$(( $(date +%s) + 30 ))
until curl -fsS --max-time 2 "http://127.0.0.1:$PORT/livez" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "image-smoke: /livez did not answer within 30 s" >&2
    docker logs "$NAME" >&2 || true
    exit 1
  fi
  sleep 0.5
done

BODY="$(curl -sS --max-time 10 "http://127.0.0.1:$PORT/health")"
echo "image-smoke: $BODY"
node -e '
  const [body, version, commit] = process.argv.slice(1);
  const h = JSON.parse(body);
  const wrong = [];
  if (h.version !== version) wrong.push(`version ${h.version}, expected ${version}`);
  if (h.commit !== commit.toLowerCase()) wrong.push(`commit ${h.commit}, expected ${commit}`);
  if (wrong.length) { console.error("image-smoke: " + wrong.join("; ")); process.exit(1); }
' "$BODY" "$VERSION" "$COMMIT"

# Who the SERVICE runs as: the owner of PID 1. `docker exec id` would report
# the user exec starts as, which says nothing about the service.
RUNS_AS="$(docker exec "$NAME" stat -c '%U' /proc/1)"
echo "image-smoke: the service (PID 1) runs as $RUNS_AS"
[ "$RUNS_AS" = "node" ] || { echo "image-smoke: the service must not run as $RUNS_AS" >&2; exit 1; }
echo "image-smoke: ok"
