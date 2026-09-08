#!/bin/bash
#
# Connect to ShipStation droplet production database via Cloud SQL Proxy
#
# Usage:
#   ./scripts/db-connect.sh                       # Interactive psql session
#   ./scripts/db-connect.sh -c "SELECT ..."       # Run a single query
#   ./scripts/db-connect.sh --exec -- pnpm cutover status nuvamed.fluid.app
#
# --exec also supplies FLUID_WEBHOOK_AUTH_TOKEN from Secret Manager, because
# cutover signs a preflight webhook with it before writing anything. An
# already-set value in the environment wins, so a caller can override it.
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
WEBHOOK_TOKEN_SECRET="SHIPSTATION_FLUID_WEBHOOK_AUTH_TOKEN"
CRON_SECRET_NAME="SHIPSTATION_CRON_SECRET"
PROXY_PORT=9482

cleanup() {
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# psql is only needed by the interactive and -c paths. --exec never calls it,
# and refusing to run there on a machine without psql would be a check failing
# for something the command does not use.
REQUIRED=(gcloud cloud-sql-proxy)
[ "${1:-}" = "--exec" ] || REQUIRED+=(psql)
for cmd in "${REQUIRED[@]}"; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is not installed" >&2
    exit 1
  fi
done

# The url splitter, defined here rather than inline below.
#
# A quoted heredoc nested inside `eval "$( ... )"` does not PARSE under bash
# 3.2 — which is /bin/bash on macOS, and this script's shebang. It failed with
# "unexpected EOF while looking for matching `''" before running a single line,
# in every mode. It looked fine only because the shell that checked it was a
# Homebrew bash 5.x on PATH, not the one named at the top of this file.
#
# `read -d ''` at top level is fine in 3.2, so the program lives in a variable
# and the command substitution stays a plain one-liner.
read -r -d '' SPLIT_DB_URL_JS <<'NODE' || true
const u = new URL(process.env.DB_URL_FOR_PARSE);
const password = decodeURIComponent(u.password);
const user = decodeURIComponent(u.username);
u.password = "";
u.username = "";
// Shell-quote: wrap in single quotes, escape any single quote within.
const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
process.stdout.write(
  `PGPASSWORD=${q(password)}\nPGUSER=${q(user)}\nSAFE_URL=${q(u.href)}\n`,
);
NODE

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

if [ "${1:-}" = "--exec" ]; then
  shift
  # Tolerate the conventional `--` separator so the command reads naturally.
  [ "${1:-}" = "--" ] && shift
  if [ $# -eq 0 ]; then
    echo "Error: --exec needs a command to run" >&2
    exit 2
  fi
  # The webhook token too, for scripts that need it.
  #
  # scripts/cutover.ts signs a preflight webhook with FLUID_WEBHOOK_AUTH_TOKEN
  # before it writes anything, so it cannot run without the real value. Fetching
  # it here keeps that value on the same footing as the database url: it is read
  # straight into a variable and handed to the child as an environment
  # variable, never printed, never written to a file, never placed in argv.
  #
  # Not fatal if it is missing — plenty of --exec commands do not need it, and
  # the ones that do fail with their own clear message.
  WEBHOOK_TOKEN=$(gcloud secrets versions access latest \
    --secret="$WEBHOOK_TOKEN_SECRET" --project="$GCP_PROJECT" 2>/dev/null || true)

  # CRON_SECRET too: cutover's deep-health preflight calls /api/health/deep on
  # the destination, which is authenticated with the same bearer the job routes
  # use. Same handling — into a variable, out through the environment, never
  # printed and never in argv.
  CRON_SECRET_VALUE=$(gcloud secrets versions access latest \
    --secret="$CRON_SECRET_NAME" --project="$GCP_PROJECT" 2>/dev/null || true)

  # An env var, not argv. Child processes inherit it; `ps` does not show it.
  DATABASE_URL="$LOCAL_DB_URL" \
  FLUID_WEBHOOK_AUTH_TOKEN="${FLUID_WEBHOOK_AUTH_TOKEN:-$WEBHOOK_TOKEN}" \
  CRON_SECRET="${CRON_SECRET:-$CRON_SECRET_VALUE}" \
    "$@"
else
  # Split the password out of the url before psql sees it.
  #
  # `psql "$LOCAL_DB_URL"` put the production password in psql's COMMAND LINE,
  # where any local user's `ps` reads it for as long as the session lasts. The
  # whole reason this script exists is that the value never reaches a terminal
  # or a file; leaving it in argv undoes that for the two interactive paths.
  #
  # PGPASSWORD is libpq's env channel, so the secret stays out of argv. The
  # url passed on is the same one minus its credentials.
  eval "$(DB_URL_FOR_PARSE="$LOCAL_DB_URL" node -e "$SPLIT_DB_URL_JS")"
  export PGPASSWORD PGUSER

  if [ "${1:-}" = "-c" ] && [ -n "${2:-}" ]; then
    psql "$SAFE_URL" -c "$2"
  else
    psql "$SAFE_URL"
  fi
fi
