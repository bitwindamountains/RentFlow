#!/bin/sh
# Run after the production Compose stack starts on an isolated CI/staging host.
set -eu
base=${1:-http://localhost}
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 "$base/api/v1/health/ready" | grep -q '"status":"ready"'
curl --fail --silent --show-error "$base/tenants" | grep -q '<app-root'
curl --fail --silent --show-error "$base/ngsw.json" | grep -q '"configVersion"'
curl --fail --silent --show-error -I "$base/" | grep -qi 'content-security-policy:'
status=$(curl --silent --show-error -o /dev/null -w '%{http_code}' "$base/api/v1/auth/me")
test "$status" = 401
printf 'Production proxy smoke checks passed\n'
