#!/bin/sh
# Start as root just long enough to make sure the data folder (a Docker volume or a host's mounted disk) belongs to the
# service user, then run as that user: the same pattern as the official Postgres and Redis images.
# Hosts that already start the container as a non-root user go straight to the command.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  find "$DATA_DIR" \! -user node -exec chown node:node '{}' +
  exec su-exec node "$@"
fi
exec "$@"
