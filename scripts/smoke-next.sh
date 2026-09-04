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
# it should. Deploy with FLUID_WEBHOOK_AUTH_TOKEN absent or wrong and every
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

code () { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

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
#   FLUID_WEBHOOK_AUTH_TOKEN=... scripts/smoke-next.sh https://...
#
# 401 means verification is rejecting real Fluid traffic. Anything else — 200,
# 202, even a 500 from the handler — proves the signature was accepted, which is
# the only thing this check is about.
#
# `droplet.uninstalled`, NOT `droplet.installed`. Both are bootstrap events, so
# either proves the point, but the install handler WRITES: it creates a
# companies row from the probe payload. The uninstall handler resolves the
# company first and returns when it finds none, so a made-up
# droplet_installation_uuid cannot touch any row. This must stay safe to point
# at production.
if [ -n "${FLUID_WEBHOOK_AUTH_TOKEN:-}" ]; then
  BODY='{"resource":"droplet","event":"uninstalled","company":{"droplet_installation_uuid":"smoke-not-a-real-installation"}}'
  TS=$(date +%s)
  SIG=$(printf '%s.%s' "$TS" "$BODY" \
    | openssl dgst -sha256 -hmac "$FLUID_WEBHOOK_AUTH_TOKEN" \
    | sed 's/^.*= //')
  SIGNED=$(code -X POST "$BASE/api/webhooks" \
    -H 'content-type: application/json' \
    -H "X-Fluid-Timestamp: $TS" \
    -H "X-Fluid-Signature: $SIG" \
    -d "$BODY")
  if [ "$SIGNED" = "401" ]; then
    printf '  FAIL  %-52s %s\n' "signed lifecycle webhook is accepted" "$SIGNED"
    fail=$((fail + 1))
  else
    printf '  ok    %-52s %s\n' "signed lifecycle webhook is accepted" "$SIGNED"
  fi
else
  printf '  SKIP  %-52s %s\n' "signed lifecycle webhook is accepted" \
    "set FLUID_WEBHOOK_AUTH_TOKEN to check"
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "$fail check(s) failed — do not repoint any installation at this service."
  exit 1
fi
if [ -n "${FLUID_WEBHOOK_AUTH_TOKEN:-}" ]; then
  echo "Passed. The service refuses unsigned webhooks AND accepts a signed one."
else
  echo "Passed, but only the refusal half was checked — nothing here proves a"
  echo "genuine signed webhook would be accepted. Re-run with"
  echo "FLUID_WEBHOOK_AUTH_TOKEN set before repointing anything."
fi
echo
echo "A signed BOOTSTRAP event says nothing about order.created/order.updated:"
echo "those verify against the company's own webhook_verification_token, per"
echo "company. Run 'pnpm cutover status <fluid_shop>' for that — it is the check"
echo "that predicts whether a repointed company's orders keep flowing."
