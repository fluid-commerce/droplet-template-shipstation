#!/bin/bash
#
# Connect to ShipStation droplet production database via Cloud SQL Proxy
#
# Usage:
#   ./scripts/db-connect.sh                       # Interactive psql session
#   ./scripts/db-connect.sh -c "SELECT ..."       # Run a single query
#   ./scripts/db-connect.sh --exec -- pnpm cutover status nuvamed.fluid.app
#
# The secret is fetched into a shell variable and never printed, echoed or
# written to a file. That is the whole point of routing through this script
# rather than exporting DATABASE_URL by hand: the value does not appear in
# stdout, in shell history, or in a dotfile someone later commits.
#
# --exec runs an arbitrary command with DATABASE_URL set to the proxied url and
# nothing else changed. It exists so scripts/cutover.ts can be run against
# production the same way — a cutover tool that has never been executed against
# the database it will act on is not a tool anyone should trust at the moment
# they need it.
#
set -e

GCP_PROJECT="fluid-417204"
INSTANCE_CONNECTION="fluid-417204:europe-west1:fluid-studioz"
SECRET_NAME="SHIPSTATION_DATABASE_URL"
PROXY_PORT=9482

cleanup() {
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for cmd in gcloud cloud-sql-proxy psql; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is not installed" >&2
    exit 1
  fi
done

# Fetch DATABASE_URL (value never printed)
DB_URL=$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$GCP_PROJECT" 2>/dev/null)
if [ -z "$DB_URL" ]; then
  echo "Error: Could not fetch secret ${SECRET_NAME}" >&2
  exit 1
fi

LOCAL_DB_URL=$(echo "$DB_URL" | sed -E "s|@[^/]+/|@localhost:${PROXY_PORT}/|" | sed 's|?.*||')

cloud-sql-proxy "$INSTANCE_CONNECTION" --port="$PROXY_PORT" --quiet 2>/dev/null &
PROXY_PID=$!
sleep 5

if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "Error: Cloud SQL Proxy failed to start" >&2
  exit 1
fi

if [ "$1" = "--exec" ]; then
  shift
  # Tolerate the conventional `--` separator so the command reads naturally.
  [ "$1" = "--" ] && shift
  if [ $# -eq 0 ]; then
    echo "Error: --exec needs a command to run" >&2
    exit 2
  fi
  DATABASE_URL="$LOCAL_DB_URL" "$@"
elif [ "$1" = "-c" ] && [ -n "$2" ]; then
  psql "$LOCAL_DB_URL" -c "$2"
else
  psql "$LOCAL_DB_URL"
fi
