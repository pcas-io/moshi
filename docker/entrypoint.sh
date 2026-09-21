#!/bin/sh
# Starts the service as the unprivileged user `node`.
#
# The container starts as root for one reason: the data volume predates the
# non-root image and belongs to root. Ownership is corrected here, once (the
# check is cheap, the recursive chown only runs when something is off), and
# then root is given up for good: `su-exec` replaces this shell, so the
# service is PID 1 and gets SIGTERM itself. `docker exec` still starts as
# root, because the image names no USER; the service does not.
#
# Started as another user already (`docker run --user …`)? Then there is
# nothing to fix and nothing to drop.
set -eu

# A directory this script may hand over: absolute, no "..", at least one
# component of its own, and not the application. `dirname` of 'moshi.db' is
# '.', which is /app; of '/moshi.db' it is '/'.
may_hand_over() {
  case "$1" in
    /|/app|/app/*|*..*) return 1 ;;
    /?*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$(id -u)" = "0" ]; then
  DATABASE="${DATABASE_PATH:-/data/moshi.db}"
  [ -n "$DATABASE" ] || DATABASE=/data/moshi.db
  if [ "$DATABASE" != ":memory:" ]; then
    DATA_DIR="$(dirname "$DATABASE")"
    if may_hand_over "$DATA_DIR"; then
      mkdir -p "$DATA_DIR"
      if [ -n "$(find "$DATA_DIR" ! -user node -print -quit 2>/dev/null)" ]; then
        echo "entrypoint: handing $DATA_DIR over to the service user"
        chown -R node:node "$DATA_DIR"
      fi
    else
      echo "entrypoint: not handing '$DATA_DIR' over (from DATABASE_PATH=$DATABASE): use an absolute path outside /app, such as /data/moshi.db" >&2
    fi
  fi

  # A backup directory on a volume of its own: the directory itself, never
  # what somebody else may keep in it.
  BACKUPS="${BACKUP_DIR:-}"
  if [ -n "$BACKUPS" ]; then
    case "$BACKUPS" in
      "${DATA_DIR:-/nonexistent}"|"${DATA_DIR:-/nonexistent}"/*) ;;
      *)
        if may_hand_over "$BACKUPS"; then
          mkdir -p "$BACKUPS"
          chown node:node "$BACKUPS"
        else
          echo "entrypoint: not handing '$BACKUPS' over (BACKUP_DIR): use an absolute path outside /app" >&2
        fi
        ;;
    esac
  fi

  # Port 80 as an unprivileged user works because Docker sets this floor to 0
  # in the container (20.10 and later). Where it does not, `node` on port 80
  # is EACCES and a restart loop, which is worse than what ran until now. So
  # there, and only there, the service keeps running as root, and says so.
  FLOOR="$(cat "${MOSHI_PORT_FLOOR_FILE:-/proc/sys/net/ipv4/ip_unprivileged_port_start}" 2>/dev/null || echo 0)"
  if [ "${PORT:-3000}" -lt "$FLOOR" ] 2>/dev/null; then
    echo "entrypoint: WARNING: PORT=${PORT} is below this container's unprivileged port floor ($FLOOR). Running as root, as before. Set PORT to $FLOOR or higher, or run with --sysctl net.ipv4.ip_unprivileged_port_start=0, to run as node." >&2
    exec "$@"
  fi

  exec su-exec node "$@"
fi

exec "$@"
