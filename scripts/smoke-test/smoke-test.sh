#!/usr/bin/env bash
# moshi.moshi — User-Flow Smoke Test
#
# See scripts/smoke-test/README.md for full narrative, troubleshooting,
# and the manual OAuth-Browser-Flow (Phase 7).
#
# Spec: Plexus entities:ctcv73b5vp78oy6bp3c0
#
# Usage:
#   MESH_ADMIN_TOKEN=... ./smoke-test.sh              # default: existing compose
#   MESH_ADMIN_TOKEN=... ./smoke-test.sh --fresh      # docker compose down -v && up
#   MESH_ADMIN_TOKEN=... ./smoke-test.sh --cleanup-stale  # delete uft-* zombies
#   MESH_ADMIN_TOKEN=... ./smoke-test.sh --skip-live  # skip Phase 6
#
# Env-Vars:
#   MESH_ADMIN_TOKEN  (required)  admin bearer for dashboard CRUD
#   MESH_URL          (default http://localhost:8080 — requires docker-compose.override.yml)
#   LIVE_URL          (default https://moshi.enki.run)
#   MESH_LIVE_TOKEN   (optional)  bearer for Phase 6 live smoke

set -uo pipefail
# NOTE: `set -e` intentionally omitted — the assert_* helpers track fails manually,
# and many curl/grep pipes have expected non-zero exits on empty matches.

# ─── Parse flags (before env-var checks so --help works) ─
FRESH=false
SKIP_LIVE=false
CLEANUP_STALE=false

for arg in "$@"; do
  case "$arg" in
    --fresh)         FRESH=true ;;
    --skip-live)     SKIP_LIVE=true ;;
    --cleanup-stale) CLEANUP_STALE=true ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

# ─── Config ──────────────────────────────────────────────
MESH_URL="${MESH_URL:-http://localhost:8080}"
LIVE_URL="${LIVE_URL:-https://moshi.enki.run}"
ADMIN_TOKEN="${MESH_ADMIN_TOKEN:?must be set (export MESH_ADMIN_TOKEN=...)}"
LIVE_TOKEN="${MESH_LIVE_TOKEN:-}"

# Skip live smoke automatically if no token
[[ -z "$LIVE_TOKEN" ]] && SKIP_LIVE=true

# ─── Run identity ────────────────────────────────────────
RUN_ID="$(openssl rand -hex 2)"
ALPHA="uft-alpha-${RUN_ID}"
BETA="uft-beta-${RUN_ID}"
ALPHA_ID=""
BETA_ID=""
ALPHA_TOKEN=""
BETA_TOKEN=""
CSRF=""
COOKIE_JAR="$(mktemp -t mesh-smoke-cookies.XXXXXX)"
FIRST_MSG_ID=""

# ─── Scoring ─────────────────────────────────────────────
PASS=0
FAIL=0
FAILED_STEPS=()

step() { printf "\n[%02d] %s\n" "$1" "$2"; }

pass() {
  PASS=$((PASS + 1))
  printf "  ok   %s\n" "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  FAILED_STEPS+=("$1")
  printf "  FAIL %s\n" "$1"
  [[ -n "${2:-}" ]] && printf "       %s\n" "$2"
}

assert_eq() {
  # usage: assert_eq "name" "expected" "actual"
  if [[ "$2" == "$3" ]]; then
    pass "$1"
  else
    fail "$1" "expected: $2 | got: $3"
  fi
}

assert_contains() {
  # usage: assert_contains "name" "needle" "haystack"
  # Empty needle is rejected — otherwise every haystack trivially matches.
  if [[ -z "$2" ]]; then
    fail "$1" "needle was empty (upstream extraction failed)"
    return
  fi
  if [[ "$3" == *"$2"* ]]; then
    pass "$1"
  else
    fail "$1" "expected to contain: $2"
  fi
}

assert_redirect() {
  # usage: assert_redirect "name" "http_code"  (2xx or 3xx passes)
  local code="$2"
  if [[ "$code" =~ ^[23] ]]; then
    pass "$1"
  else
    fail "$1" "expected 2xx/3xx, got: $code"
  fi
}

assert_not_empty() {
  # usage: assert_not_empty "name" "value"
  if [[ -n "$2" ]]; then
    pass "$1"
  else
    fail "$1" "value was empty"
  fi
}

# ─── CSRF helper ─────────────────────────────────────────
# CSRF tokens are HMAC-signed with cookie secret, so reusable across requests.
# Extract once from GET /login, reuse everywhere.
fetch_csrf() {
  local html
  html=$(curl -sS -c "$COOKIE_JAR" "$MESH_URL/login")
  # CSRF token format: name="csrf" value="nonce:timestamp.hmac"
  # Extract the value attribute of the hidden csrf input.
  echo "$html" | grep -oE 'name="csrf"[^>]*value="[^"]*"' | \
    sed -E 's/.*value="([^"]*)".*/\1/' | head -1
}

# ─── MCP helper ──────────────────────────────────────────
# Usage: mcp_call <token> <tool_name> <json_args> [url]
# Prints the inner tool-result JSON (double-unwrapped) to stdout.
mcp_call() {
  local token="$1" tool="$2" args="$3" url="${4:-$MESH_URL}"
  local body
  body=$(jq -nc \
    --arg tool "$tool" \
    --argjson args "$args" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$tool,arguments:$args}}')

  curl -sS -X POST "$url/mcp" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$body" \
  | jq -r '.result.content[0].text // empty'
}

# Extract plaintext token from /agents HTML (shown in flash after create/reset).
# The AgentsPage renders it as a visible block when flash.newToken is set.
extract_token_from_agents_page() {
  local flash_key="$1"
  local html
  html=$(curl -sS -b "$COOKIE_JAR" "$MESH_URL/agents?flash=$flash_key")
  # Token format: bt_ followed by hex chars (64+)
  echo "$html" | grep -oE 'bt_[a-z0-9]{20,}' | head -1
}

# Extract agent id from /agents HTML using Python3.
# The rename form has this structure (all on one line):
#   <form action="/agents/rename">
#     <input name="csrf" value="...">
#     <input name="id" value="<ULID>">        <-- we want this ULID
#     <input name="name" value="<AGENT_NAME>">
# We walk the HTML, tracking the most recent id= input, and return it
# when we hit the matching name= input.
extract_agent_id() {
  local name="$1"
  curl -sS -b "$COOKIE_JAR" "$MESH_URL/agents" | python3 -c '
import sys, re
html = sys.stdin.read()
name = sys.argv[1]
# Find every id + subsequent name pair in the HTML.
pattern = re.compile(
  r"name=\"id\"[^>]*value=\"([^\"]+)\"[^>]*/?>"
  r"\s*<input[^>]*name=\"name\"[^>]*value=\"([^\"]+)\""
)
for m in pattern.finditer(html):
  if m.group(2) == name:
    print(m.group(1))
    sys.exit(0)
' "$name"
}

# ─── Cleanup (runs on every exit) ────────────────────────
cleanup() {
  local rc=$?
  # Only try cleanup if we have CSRF and IDs
  if [[ -n "$CSRF" ]]; then
    if [[ -n "$ALPHA_ID" ]]; then
      curl -sS -X POST -b "$COOKIE_JAR" "$MESH_URL/agents/delete" \
        -d "id=$ALPHA_ID&csrf=$CSRF" >/dev/null 2>&1 || true
    fi
    if [[ -n "$BETA_ID" ]]; then
      curl -sS -X POST -b "$COOKIE_JAR" "$MESH_URL/agents/delete" \
        -d "id=$BETA_ID&csrf=$CSRF" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$COOKIE_JAR"
  exit $rc
}
trap cleanup EXIT

# ─── Summary ─────────────────────────────────────────────
print_summary() {
  printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  printf " PASS: %d   FAIL: %d\n" "$PASS" "$FAIL"
  if (( FAIL > 0 )); then
    printf " Failed steps:\n"
    printf "   - %s\n" "${FAILED_STEPS[@]}"
  fi
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
}

# ═══════════════════════════════════════════════
# Phase 0: Preflight
# ═══════════════════════════════════════════════

if $FRESH; then
  printf "\n[--fresh] Resetting docker compose stack...\n"
  (cd "$(dirname "$0")/../.." && docker compose down -v && docker compose up -d) >/dev/null 2>&1
  printf "Waiting for /health...\n"
  for i in {1..30}; do
    if curl -sS "$MESH_URL/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

step 0 "Preflight"

HEALTH_CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$MESH_URL/health" || echo "000")
assert_eq "health endpoint returns 200" "200" "$HEALTH_CODE"

if [[ "$HEALTH_CODE" != "200" ]]; then
  printf "\nPreflight failed — is docker compose running at %s?\n" "$MESH_URL"
  print_summary
  exit 2
fi

# Fetch CSRF token (reusable — HMAC-signed, not session-bound)
CSRF=$(fetch_csrf)
if [[ -z "$CSRF" ]]; then
  fail "CSRF token extracted from /login"
  print_summary
  exit 2
fi
pass "CSRF token fetched from /login"

# ═══════════════════════════════════════════════
# Phase 1: Admin-CRUD
# ═══════════════════════════════════════════════

step 1 "POST /login with admin token"

LOGIN_CODE=$(curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -o /dev/null -w '%{http_code}' \
  -X POST "$MESH_URL/login" \
  --data-urlencode "token=$ADMIN_TOKEN" \
  --data-urlencode "csrf=$CSRF")
assert_redirect "login accepts admin token" "$LOGIN_CODE"

# After login, CSRF might have changed — refetch
# (Actually: CSRF is HMAC'd with cookie secret, independent of session, so reuse is fine.
#  But we need an authenticated session cookie, so the subsequent /agents GETs work.)

step 2 "Create agent $ALPHA"

# POST /agents/create → redirects to /agents?flash=<key>
# We follow the redirect manually to get the flash key, then extract the token.
CREATE_ALPHA=$(curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -o /dev/null -w '%{http_code} %{redirect_url}' \
  -X POST "$MESH_URL/agents/create" \
  --data-urlencode "name=$ALPHA" \
  --data-urlencode "avatar=avatar-04" \
  --data-urlencode "csrf=$CSRF")
CREATE_CODE="${CREATE_ALPHA%% *}"
CREATE_REDIRECT="${CREATE_ALPHA#* }"
assert_redirect "create alpha returns redirect" "$CREATE_CODE"

# Extract flash key from redirect URL (e.g. /agents?flash=abc-123)
ALPHA_FLASH=$(echo "$CREATE_REDIRECT" | grep -oE 'flash=[a-f0-9-]+' | cut -d= -f2)
ALPHA_TOKEN=$(extract_token_from_agents_page "$ALPHA_FLASH")
assert_contains "alpha token starts with bt_" "bt_" "$ALPHA_TOKEN"

ALPHA_ID=$(extract_agent_id "$ALPHA")
assert_not_empty "alpha id extracted" "$ALPHA_ID"

step 3 "Create agent $BETA"

CREATE_BETA=$(curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -o /dev/null -w '%{http_code} %{redirect_url}' \
  -X POST "$MESH_URL/agents/create" \
  --data-urlencode "name=$BETA" \
  --data-urlencode "avatar=avatar-05" \
  --data-urlencode "csrf=$CSRF")
CREATE_BETA_CODE="${CREATE_BETA%% *}"
CREATE_BETA_REDIRECT="${CREATE_BETA#* }"
assert_redirect "create beta returns redirect" "$CREATE_BETA_CODE"

BETA_FLASH=$(echo "$CREATE_BETA_REDIRECT" | grep -oE 'flash=[a-f0-9-]+' | cut -d= -f2)
BETA_TOKEN=$(extract_token_from_agents_page "$BETA_FLASH")
assert_contains "beta token starts with bt_" "bt_" "$BETA_TOKEN"

BETA_ID=$(extract_agent_id "$BETA")
assert_not_empty "beta id extracted" "$BETA_ID"

step 4 "GET /agents lists both test agents"

AGENTS_HTML=$(curl -sS -b "$COOKIE_JAR" "$MESH_URL/agents")
assert_contains "agents page shows alpha" "$ALPHA" "$AGENTS_HTML"
assert_contains "agents page shows beta" "$BETA" "$AGENTS_HTML"

# ═══════════════════════════════════════════════
# Phase 2: MCP Bearer-Flow
# ═══════════════════════════════════════════════

step 5 "mesh_register (alpha)"

REG_RESP=$(mcp_call "$ALPHA_TOKEN" "mesh_register" \
  '{"role":"tester","capabilities":["smoke"],"working_on":"user-flow-smoke"}')
REG_OK=$(echo "$REG_RESP" | jq -r '.registered // empty' 2>/dev/null || echo "")
assert_eq "mesh_register returns registered=true" "true" "$REG_OK"

step 6 "mesh_status (alpha) shows both test agents"

STATUS_RESP=$(mcp_call "$ALPHA_TOKEN" "mesh_status" '{}')
STATUS_NAMES=$(echo "$STATUS_RESP" | jq -r '.agents[].name' 2>/dev/null | tr '\n' ' ')
assert_contains "status includes alpha" "$ALPHA" "$STATUS_NAMES"
assert_contains "status includes beta" "$BETA" "$STATUS_NAMES"

step 7 "mesh_send alpha -> beta (direct)"

SEND_RESP=$(mcp_call "$ALPHA_TOKEN" "mesh_send" \
  "$(jq -nc --arg to "$BETA" \
    '{to:$to,type:"question",payload:"ping",context:"user-flow-test"}')")
FIRST_MSG_ID=$(echo "$SEND_RESP" | jq -r '.id // empty' 2>/dev/null || echo "")
assert_contains "mesh_send returns msg_ id" "msg_" "$FIRST_MSG_ID"

# Give NATS a moment to deliver
sleep 1

step 8 "mesh_receive (beta) gets the message"

RECV_RESP=$(mcp_call "$BETA_TOKEN" "mesh_receive" '{"limit":10}')
RECV_IDS=$(echo "$RECV_RESP" | jq -r '.messages[].id' 2>/dev/null | tr '\n' ' ')
assert_contains "beta inbox contains first msg" "$FIRST_MSG_ID" "$RECV_IDS"

step 9 "mesh_reply (beta -> alpha)"

REPLY_RESP=$(mcp_call "$BETA_TOKEN" "mesh_reply" \
  "$(jq -nc --arg id "$FIRST_MSG_ID" \
    '{message_id:$id,payload:"pong",context:"user-flow-test"}')")
REPLY_ID=$(echo "$REPLY_RESP" | jq -r '.id // empty' 2>/dev/null || echo "")
REPLY_CORR=$(echo "$REPLY_RESP" | jq -r '.correlation_id // empty' 2>/dev/null || echo "")
assert_contains "reply returns msg_ id" "msg_" "$REPLY_ID"
assert_eq "reply correlation_id = first msg id" "$FIRST_MSG_ID" "$REPLY_CORR"

sleep 1

step 10 "mesh_receive (alpha) gets the reply"

ALPHA_RECV=$(mcp_call "$ALPHA_TOKEN" "mesh_receive" '{"limit":10}')
ALPHA_RECV_IDS=$(echo "$ALPHA_RECV" | jq -r '.messages[].id' 2>/dev/null | tr '\n' ' ')
assert_contains "alpha inbox contains reply" "$REPLY_ID" "$ALPHA_RECV_IDS"

step 11 "mesh_history shows full 2-msg thread"

HIST_RESP=$(mcp_call "$ALPHA_TOKEN" "mesh_history" \
  "$(jq -nc --arg id "$FIRST_MSG_ID" '{correlation_id:$id,limit:10}')")
HIST_COUNT=$(echo "$HIST_RESP" | jq -r '.count // 0' 2>/dev/null || echo "0")
assert_eq "history has 2 messages" "2" "$HIST_COUNT"

step 12 "mesh_send alpha -> broadcast"

BCAST_RESP=$(mcp_call "$ALPHA_TOKEN" "mesh_send" \
  '{"to":"broadcast","type":"info","payload":"hello everyone","context":"user-flow-test"}')
BCAST_ID=$(echo "$BCAST_RESP" | jq -r '.id // empty' 2>/dev/null || echo "")
assert_contains "broadcast returns msg_ id" "msg_" "$BCAST_ID"

sleep 1

step 13 "mesh_receive (beta) gets broadcast"

BETA_RECV2=$(mcp_call "$BETA_TOKEN" "mesh_receive" '{"limit":10}')
BETA_RECV2_IDS=$(echo "$BETA_RECV2" | jq -r '.messages[].id' 2>/dev/null | tr '\n' ' ')
assert_contains "beta inbox contains broadcast" "$BCAST_ID" "$BETA_RECV2_IDS"

# ═══════════════════════════════════════════════
# Phase 3: moshi Go-Binary
# ═══════════════════════════════════════════════

UNAME_S=$(uname -s)
UNAME_M=$(uname -m)
case "$UNAME_S-$UNAME_M" in
  Darwin-arm64)  CLI_BIN="cli/moshi-darwin-arm64" ;;
  Linux-x86_64)  CLI_BIN="cli/moshi-linux-amd64" ;;
  Linux-aarch64) CLI_BIN="cli/moshi-linux-arm64" ;;
  *) CLI_BIN="cli/moshi" ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_PATH="$REPO_ROOT/$CLI_BIN"

if [[ -x "$CLI_PATH" ]]; then
  step 14 "moshi status (as alpha)"

  CLI_STATUS=$(MESH_URL="$MESH_URL/mcp" MESH_TOKEN="$ALPHA_TOKEN" \
    "$CLI_PATH" status 2>&1 || true)
  assert_contains "cli status shows alpha" "$ALPHA" "$CLI_STATUS"
  assert_contains "cli status shows beta" "$BETA" "$CLI_STATUS"

  step 15 "moshi send (pipe mode, alpha -> beta)"

  CLI_SEND=$(echo "cli test $RUN_ID" | \
    MESH_URL="$MESH_URL/mcp" MESH_TOKEN="$ALPHA_TOKEN" \
    "$CLI_PATH" send "$BETA" 2>&1 || true)
  assert_contains "cli send succeeds" "Gesendet" "$CLI_SEND"

  sleep 1

  step 16 "moshi receive (as beta)"

  CLI_RECV=$(MESH_URL="$MESH_URL/mcp" MESH_TOKEN="$BETA_TOKEN" \
    "$CLI_PATH" receive 2>&1 || true)
  assert_contains "cli receive shows test payload" "cli test $RUN_ID" "$CLI_RECV"

  step 17 "moshi history (as alpha)"

  CLI_HIST=$(MESH_URL="$MESH_URL/mcp" MESH_TOKEN="$ALPHA_TOKEN" \
    "$CLI_PATH" history "$FIRST_MSG_ID" 2>&1 || true)
  assert_contains "cli history shows ping" "ping" "$CLI_HIST"
else
  printf "\n[14-17] moshi binary not found at %s — skipping Phase 3\n" "$CLI_PATH"
fi

# ═══════════════════════════════════════════════
# Phase 4: Dashboard-Visual-Check
# ═══════════════════════════════════════════════

step 18 "GET / (home) lists both test agents"

HOME_HTML=$(curl -sS -b "$COOKIE_JAR" "$MESH_URL/")
assert_contains "home shows alpha" "$ALPHA" "$HOME_HTML"
assert_contains "home shows beta" "$BETA" "$HOME_HTML"

step 19 "GET /messages renders"

MSGS_HTML=$(curl -sS -b "$COOKIE_JAR" "$MESH_URL/messages")
MSGS_LOWER=$(echo "$MSGS_HTML" | tr '[:upper:]' '[:lower:]')
assert_contains "messages page loads" "messages" "$MSGS_LOWER"

step 20 "GET /conversations contains test context"

CONV_HTML=$(curl -sS -b "$COOKIE_JAR" "$MESH_URL/conversations")
assert_contains "conversations contains user-flow-test context" "user-flow-test" "$CONV_HTML"

step 21 "GET /activity shows our test messages"

# Activity log shows `summary` if present (agents.ts sets summary for all events),
# so we search for the alpha agent name — it appears in the message_sent summaries.
ACT_HTML=$(curl -sS -b "$COOKIE_JAR" "$MESH_URL/activity")
assert_contains "activity log references alpha" "$ALPHA" "$ACT_HTML"

# ═══════════════════════════════════════════════
# Phase 5: Lifecycle
# ═══════════════════════════════════════════════

step 22 "POST /agents/revoke (deactivate alpha)"

REVOKE_CODE=$(curl -sS -b "$COOKIE_JAR" \
  -o /dev/null -w '%{http_code}' \
  -X POST "$MESH_URL/agents/revoke" \
  --data-urlencode "id=$ALPHA_ID" \
  --data-urlencode "csrf=$CSRF")
assert_redirect "revoke alpha returns redirect" "$REVOKE_CODE"

step 23 "MCP call with revoked alpha token fails auth"

# After revoke, the token hash is no longer active. authMiddleware should reject.
REVOKED_CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST "$MESH_URL/mcp" \
  -H "Authorization: Bearer $ALPHA_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mesh_status","arguments":{}}}')
if [[ "$REVOKED_CODE" != "200" ]]; then
  pass "revoked alpha cannot call MCP (got $REVOKED_CODE)"
else
  fail "revoked alpha still has MCP access" "expected non-200, got 200"
fi

step 24 "POST /agents/reactivate alpha (generates new token)"

REACT_RAW=$(curl -sS -b "$COOKIE_JAR" \
  -o /dev/null -w '%{http_code} %{redirect_url}' \
  -X POST "$MESH_URL/agents/reactivate" \
  --data-urlencode "id=$ALPHA_ID" \
  --data-urlencode "csrf=$CSRF")
REACT_CODE="${REACT_RAW%% *}"
REACT_REDIRECT="${REACT_RAW#* }"
assert_redirect "reactivate alpha returns redirect" "$REACT_CODE"

step 25 "POST /agents/reset-token (on alpha)"

RESET_RAW=$(curl -sS -b "$COOKIE_JAR" \
  -o /dev/null -w '%{http_code} %{redirect_url}' \
  -X POST "$MESH_URL/agents/reset-token" \
  --data-urlencode "id=$ALPHA_ID" \
  --data-urlencode "csrf=$CSRF")
RESET_CODE="${RESET_RAW%% *}"
assert_redirect "reset-token alpha returns redirect" "$RESET_CODE"

step 26 "POST /agents/delete alpha"

DEL_ALPHA=$(curl -sS -b "$COOKIE_JAR" \
  -o /dev/null -w '%{http_code}' \
  -X POST "$MESH_URL/agents/delete" \
  --data-urlencode "id=$ALPHA_ID" \
  --data-urlencode "csrf=$CSRF")
assert_redirect "delete alpha returns redirect" "$DEL_ALPHA"

step 27 "POST /agents/delete beta"

DEL_BETA=$(curl -sS -b "$COOKIE_JAR" \
  -o /dev/null -w '%{http_code}' \
  -X POST "$MESH_URL/agents/delete" \
  --data-urlencode "id=$BETA_ID" \
  --data-urlencode "csrf=$CSRF")
assert_redirect "delete beta returns redirect" "$DEL_BETA"

# Clear IDs so cleanup trap doesn't try delete again
ALPHA_ID=""
BETA_ID=""

step 28 "GET /agents no longer lists test agents"

FINAL_HTML=$(curl -sS -b "$COOKIE_JAR" "$MESH_URL/agents")
if echo "$FINAL_HTML" | grep -q ">$ALPHA<\|>$BETA<"; then
  fail "test agents removed from page" "still visible in HTML"
else
  pass "test agents removed from page"
fi

# ═══════════════════════════════════════════════
# Phase 6: Live-Smoke (read-only)
# ═══════════════════════════════════════════════

if $SKIP_LIVE; then
  printf "\n[29-31] --skip-live (set MESH_LIVE_TOKEN to enable Phase 6)\n"
else
  step 29 "GET $LIVE_URL/health"
  LIVE_HEALTH=$(curl -sS -o /dev/null -w '%{http_code}' "$LIVE_URL/health" || echo "000")
  assert_eq "live health returns 200" "200" "$LIVE_HEALTH"

  step 30 "GET $LIVE_URL/.well-known/oauth-authorization-server"
  LIVE_META=$(curl -sS "$LIVE_URL/.well-known/oauth-authorization-server")
  LIVE_ISSUER=$(echo "$LIVE_META" | jq -r '.issuer // empty' 2>/dev/null || echo "")
  LIVE_AUTH=$(echo "$LIVE_META" | jq -r '.authorization_endpoint // empty' 2>/dev/null || echo "")
  LIVE_TOKEN_EP=$(echo "$LIVE_META" | jq -r '.token_endpoint // empty' 2>/dev/null || echo "")
  LIVE_METHODS=$(echo "$LIVE_META" | jq -r '.code_challenge_methods_supported[]?' 2>/dev/null | tr '\n' ' ')
  assert_contains "oauth metadata has https issuer" "https" "$LIVE_ISSUER"
  assert_contains "oauth metadata has authorization_endpoint" "authorize" "$LIVE_AUTH"
  assert_contains "oauth metadata has token_endpoint" "token" "$LIVE_TOKEN_EP"
  assert_contains "oauth metadata supports S256" "S256" "$LIVE_METHODS"

  step 31 "mesh_status against live $LIVE_URL (read-only)"
  LIVE_STATUS=$(mcp_call "$LIVE_TOKEN" "mesh_status" '{}' "$LIVE_URL")
  LIVE_COUNT=$(echo "$LIVE_STATUS" | jq -r '.count // 0' 2>/dev/null || echo "0")
  if [[ "$LIVE_COUNT" =~ ^[0-9]+$ ]] && (( LIVE_COUNT > 0 )); then
    pass "live mesh_status returns $LIVE_COUNT agents"
  else
    fail "live mesh_status returns agents" "got count=$LIVE_COUNT"
  fi
fi

print_summary
(( FAIL == 0 )) || exit 1
