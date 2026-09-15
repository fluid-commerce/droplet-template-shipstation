#!/usr/bin/env bash
#
# Synthetic smoke test against a deployed Next service.
#
#   scripts/smoke-next.sh https://fluid-droplet-shipstation-next-xxxx.a.run.app
#
# Sends no valid signatures, so it needs no secrets and is safe against
# production. Read the limits below before trusting a pass.
#
# WHY THIS DROPLET'S SMOKE TEST IS SHORTER THAN ITS SIBLINGS'
#
# Every other ported droplet serves synchronous callbacks, which fail OPEN by
# design: a 401 on the checkout path is a broken cart, so they answer 200 with a
# neutral body. That makes an unauthenticated probe unable to tell "verifying
# correctly and refusing me" from "cannot verify anything and refusing
# everyone".
#
# This droplet registers NO callbacks — see src/lib/config/droplet.config.ts,
# and note there is no src/app/api/callbacks route at all. Everything it serves
# is a webhook, and webhooks fail CLOSED. So every assertion here is a real one:
# a 200 anywhere below would be the finding.
#
# WHAT THIS STILL CANNOT SHOW
#
# It proves the service REFUSES what it should. It cannot prove it ACCEPTS what
# it should. Deploy with FLUID_DROPLET_WEBHOOK_SECRET absent or wrong and every
# check below still passes, while every genuine Fluid delivery is also refused.
# The optional signed check at the bottom is the only part that closes that gap.
set -uo pipefail

BASE="${1:-}"
[ -n "$BASE" ] || { echo "usage: $0 <base-url>"; exit 2; }
BASE="${BASE%/}"

fail=0
check () {
  local name="$1" expected="$2" got="$3"
  if [ "$got" = "$expected" ]; then
    printf '  ok    %-52s %s\n' "$name" "$got"
  else
    printf '  FAIL  %-52s got %s, want %s\n' "$name" "$got" "$expected"
    fail=$((fail + 1))
  fi
}

# curl already prints 000 for -w when it cannot connect; `|| echo 000` would
# append a second one and make the 000) branches below unreachable.
code () { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" 2>/dev/null || true; }

echo "Smoke testing $BASE"

check "health" 200 "$(code "$BASE/api/health")"

# The Fluid webhook endpoint. Fails closed, so these carry weight.
check "webhook without a signature is refused" 401 \
  "$(code -X POST "$BASE/api/webhooks" \
      -H 'content-type: application/json' \
      -d '{"resource":"order","event":"created","company":{"fluid_shop":"smoke"}}')"

# 400, NOT 401. The SDK wrapper reads and JSON.parses the body BEFORE it looks
# at the signature, so a malformed body is rejected as a bad request and never
# reaches auth.
check "webhook with a malformed body is a bad request" 400 \
  "$(code -X POST "$BASE/api/webhooks" \
      -H 'content-type: application/json' -d 'not json')"

# A bootstrap-eligible event with no signature must also be refused. The shared
# secret is a candidate for these events, not a bypass of verification. This is
# the assertion that matters most on this droplet: the Rails controller it
# replaces authenticated installs by comparing a caller-supplied droplet uuid,
# so anyone who knew the marketplace uuid could forge an install and hand the
# app a companies row carrying credentials of their choosing.
check "unsigned install event is refused" 401 \
  "$(code -X POST "$BASE/api/webhooks" \
      -H 'content-type: application/json' \
      -d '{"resource":"droplet","event":"installed","company":{"fluid_shop":"smoke"}}')"

# /api/webhooks/shipped is NOT a Fluid webhook — nothing HMAC-signs it, so it
# keeps a shared-token scheme and is checked separately.
#
# Note for anyone planning a cutover: as of this writing nothing calls it.
# app/jobs/sync_tracking_job.rb records that ShipStation has no webhook
# registered against this droplet and tracking is obtained by polling instead.
# It is asserted anyway, because an endpoint that accepts a resource_url and
# then sends a company's ShipStation credentials to it must refuse strangers
# whether or not anyone is currently calling it.
check "shipped without a token is refused" 401 \
  "$(code -X POST "$BASE/api/webhooks/shipped" \
      -H 'content-type: application/json' \
      -d '{"resource_url":"https://ssapi.shipstation.com/shipments?batchId=smoke","company_id":"980191006"}')"

# 400 before any lookup: a resource_url pointing somewhere other than
# ShipStation is refused on its host, not on its token. Ordering matters — this
# is the SSRF guard, and it has to run before the database is touched.
check "shipped with a foreign resource_url is refused" 400 \
  "$(code -X POST "$BASE/api/webhooks/shipped" \
      -H 'content-type: application/json' \
      -d '{"resource_url":"https://evil.example/x","company_id":"980191006"}')"

# There is no callback surface. Asserted rather than assumed, because the
# template this droplet was forked from ships one, and a merge that reintroduced
# it would add a fail-open route nobody registered — reachable, unverifiable and
# invisible.
check "no callback route is exposed" 404 \
  "$(code -X POST "$BASE/api/callbacks/update-cart-shipping" \
      -H 'content-type: application/json' -d '{}')"

# Closes the acceptance gap, if the secret is available.
#
#   FLUID_DROPLET_WEBHOOK_SECRET=... scripts/smoke-next.sh https://...
#
# Lifecycle events are signed with the droplet record's own webhook_secret
# (see LIFECYCLE_SECRET in src/app/api/webhooks/route.ts), so ONLY that key is
# used for the positive probe. The route falls back to FLUID_WEBHOOK_AUTH_TOKEN
# when the variable is unset, so probing with the fallback would pass against a
# service that is missing the droplet secret — the one misconfiguration this
# check exists to catch.
#
# When FLUID_WEBHOOK_AUTH_TOKEN is also available, a NEGATIVE probe signed with
# it must be refused: that is what proves the service holds the droplet secret
# rather than running on the fallback.
#
# `droplet.uninstalled`, NOT `droplet.installed`. Both are lifecycle events, so
# either proves the point, but the install handler WRITES: it creates a
# companies row from the probe payload. The uninstall handler resolves the
# company first and returns when it finds none, so a made-up
# droplet_installation_uuid cannot touch any row. This must stay safe to point
# at production.
LIFECYCLE_BODY='{"resource":"droplet","event":"uninstalled","company":{"droplet_installation_uuid":"smoke-not-a-real-installation"}}'

# Signs LIFECYCLE_BODY with the key in $1 and prints the HTTP status.
#
# node, not `openssl -hmac "$KEY"`: openssl takes the key as a COMMAND LINE
# argument, so for the life of that process any local user's `ps` shows the
# secret in full. node reads it from the environment, where argv cannot leak it.
signed_lifecycle_status() {
  local ts sig
  ts=$(date +%s)
  sig=$(SMOKE_KEY="$1" SMOKE_TS="$ts" SMOKE_BODY="$LIFECYCLE_BODY" node -e '
    const crypto = require("node:crypto");
    process.stdout.write(
      crypto
        .createHmac("sha256", process.env.SMOKE_KEY)
        .update(`${process.env.SMOKE_TS}.${process.env.SMOKE_BODY}`)
        .digest("hex"),
    );
  ')
  code -X POST "$BASE/api/webhooks" \
    -H 'content-type: application/json' \
    -H "X-Fluid-Timestamp: $ts" \
    -H "X-Fluid-Signature: $sig" \
    -d "$LIFECYCLE_BODY"
}

if [ -n "${FLUID_DROPLET_WEBHOOK_SECRET:-}" ]; then
  SIGNED=$(signed_lifecycle_status "$FLUID_DROPLET_WEBHOOK_SECRET")
  # An explicit allow-list, not "anything but 401".
  #
  # `code()` returns 000 when curl cannot reach the host at all, and a 500 is a
  # broken route — both would have counted as "the signature was accepted"
  # under a not-401 test, which is the same failure shape as a check that only
  # looks for good news.
  #
  # 202 means the handler ran; 204 means it ran and found no company matching
  # the made-up installation uuid, which is the expected outcome here
  # (src/app/api/webhooks/route.ts returns `handled ? 202 : 204`). Either proves
  # the signature verified.
  case "$SIGNED" in
    200|202|204)
      printf '  ok    %-52s %s\n' "lifecycle webhook signed with droplet secret" "$SIGNED" ;;
    401)
      printf '  FAIL  %-52s %s\n' "lifecycle webhook signed with droplet secret" \
        "$SIGNED — the service does not accept FLUID_DROPLET_WEBHOOK_SECRET"
      fail=$((fail + 1)) ;;
    000)
      printf '  FAIL  %-52s %s\n' "lifecycle webhook signed with droplet secret" \
        "no response — could not reach the service"
      fail=$((fail + 1)) ;;
    *)
      printf '  FAIL  %-52s %s\n' "lifecycle webhook signed with droplet secret" \
        "$SIGNED — expected 202 or 204"
      fail=$((fail + 1)) ;;
  esac

  # Only meaningful once the positive probe got through: against an unreachable
  # or broken service the negative probe would fail too and blame the fallback.
  if ! case "$SIGNED" in 200|202|204) true ;; *) false ;; esac; then
    printf '  SKIP  %-52s %s\n' "shared token refused for lifecycle events" \
      "positive probe did not pass"
  elif [ -n "${FLUID_WEBHOOK_AUTH_TOKEN:-}" ]; then
    NEGATIVE=$(signed_lifecycle_status "$FLUID_WEBHOOK_AUTH_TOKEN")
    if [ "$NEGATIVE" = "401" ]; then
      printf '  ok    %-52s %s\n' "shared token refused for lifecycle events" "$NEGATIVE"
    else
      printf '  FAIL  %-52s %s\n' "shared token refused for lifecycle events" \
        "$NEGATIVE — expected 401; the service is likely on the FLUID_WEBHOOK_AUTH_TOKEN fallback"
      fail=$((fail + 1))
    fi
  else
    printf '  SKIP  %-52s %s\n' "shared token refused for lifecycle events" \
      "set FLUID_WEBHOOK_AUTH_TOKEN to check"
  fi
else
  printf '  SKIP  %-52s %s\n' "lifecycle webhook signed with droplet secret" \
    "set FLUID_DROPLET_WEBHOOK_SECRET to check"
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "$fail check(s) failed — do not repoint any installation at this service."
  exit 1
fi
if [ -n "${FLUID_DROPLET_WEBHOOK_SECRET:-}" ]; then
  echo "Passed. The service refuses unsigned webhooks AND accepts a lifecycle"
  echo "webhook signed with the droplet secret."
else
  echo "Passed, but only the refusal half was checked — nothing here proves a"
  echo "genuine signed webhook would be accepted. Re-run with"
  echo "FLUID_DROPLET_WEBHOOK_SECRET set before repointing anything."
fi
echo
echo "A signed LIFECYCLE event says nothing about order.created/order.updated:"
echo "those verify against the company's own webhook_verification_token, per"
echo "company. Run 'pnpm cutover status <fluid_shop>' for that — it is the check"
echo "that predicts whether a repointed company's orders keep flowing."
