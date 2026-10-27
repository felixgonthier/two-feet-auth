#!/bin/sh
# Admin commands inside the container, run as the service user so what they write stays readable by the service:
#   piggyback add-client --name "Your app" --redirect-uri https://your.app/mfa/callback
#   piggyback list-clients · piggyback delete-user --client pb_… --user alice@example.com
cd /app
if [ "$(id -u)" = "0" ]; then exec su-exec node node server/cli.js "$@"; fi
exec node server/cli.js "$@"
