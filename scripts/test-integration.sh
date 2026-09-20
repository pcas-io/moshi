#!/usr/bin/env sh
# Runs tests/integration against a throwaway NATS server with JetStream.
#
# The tests delete the stream and the presence bucket before every case, so
# they get a broker of their own: started here on a free loopback port,
# removed again on exit. Needs Docker. Extra arguments go to vitest.
#
#   npm run test:integration
#   MOSHI_TEST_NATS_IMAGE=nats:2-alpine npm run test:integration   # another version
set -eu

# A pin, not a mirror: docker-compose.yml still uses the floating nats:2-alpine
# (2.14.6 on 2026-09-19). Bump this together with the compose file.
IMAGE="${MOSHI_TEST_NATS_IMAGE:-nats:2.14.6-alpine}"
NAME="moshi-it-nats-$$"

# No --rm and a fixed port: the reconnect test stops and starts this very
# container, which has to survive the stop and come back on the same port.
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")

# Say so before the one step that can take long: the first run pulls the image.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "test-integration: starting $IMAGE"
else
  echo "test-integration: pulling $IMAGE (first run only) ..."
fi
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:4222" "$IMAGE" -js >/dev/null

UP=""
i=0
while [ "$i" -lt 100 ]; do
  # Wait for the broker's INFO banner, not for a TCP connect: Docker's port
  # forwarder accepts the connection before anything listens in the container.
  if node -e "
    const s = require('net').connect($PORT, '127.0.0.1');
    s.on('data', (d) => process.exit(String(d).startsWith('INFO ') ? 0 : 1));
    s.on('error', () => process.exit(1));
    s.on('close', () => process.exit(1));
    setTimeout(() => process.exit(1), 1000);
  " 2>/dev/null; then
    UP=1
    break
  fi
  i=$((i + 1))
  sleep 0.2
done
if [ -z "$UP" ]; then
  echo "test-integration: the NATS container did not come up" >&2
  docker logs "$NAME" >&2 || true
  exit 1
fi

echo "test-integration: $IMAGE on 127.0.0.1:$PORT"
# The container name lets the outage tests freeze and thaw the broker.
# REQUIRED turns a missing value from a skip into a failure inside the test files.
MOSHI_TEST_NATS_REQUIRED=1 MOSHI_TEST_NATS_URL="nats://127.0.0.1:$PORT" MOSHI_TEST_NATS_CONTAINER="$NAME" \
  npx vitest run tests/integration --no-file-parallelism "$@"
