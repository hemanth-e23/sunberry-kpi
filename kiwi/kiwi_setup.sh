#!/usr/bin/env bash
# KIWI step 3: set Supabase secrets and deploy the functions.
# Run from anywhere:   bash ~/Desktop/kpi/kiwi/kiwi_setup.sh
#
# Secrets are typed at hidden prompts: never shown, never saved in shell
# history, never written to disk -- except the sync token, which goes straight
# into kiwi/importer/kiwi_sync.conf (git-ignored, readable only by you) for the
# SharePoint sync PC.
set -euo pipefail
cd "$(dirname "$0")/.."            # the kpi folder

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31mStopped: %s\033[0m\n" "$*"; exit 1; }

# Use an installed Supabase CLI, or run it through npx (comes with Node) - nothing to install.
# Pinned version: the commands below were checked against exactly this one.
command -v npx >/dev/null || fail "npx (Node.js) not found"
say "Using Supabase CLI 3.2.0 through npx (first run downloads it, ~30 s). It asks you to confirm each change: type y."
SB() { npx --yes supabase@3.2.0 "$@"; }
command -v openssl  >/dev/null || fail "openssl not found"
command -v python3  >/dev/null || fail "python3 not found (needed to encode the passwords safely)"

# --- project (not secret) ----------------------------------------------------
REF=$(grep -Eo 'https://[a-z0-9]+\.supabase\.co' .env.local 2>/dev/null | head -1 | sed -E 's#https://([a-z0-9]+)\.supabase\.co#\1#')
[ -n "$REF" ] || read -r -p "Supabase project ref: " REF
say "Project: $REF"

if ! SB projects list >/dev/null 2>&1; then
  say "Logging in to Supabase (a browser window opens)..."
  SB login
fi
SB projects list 2>/dev/null | grep -q "$REF" || fail "Your Supabase login can't see project $REF"

echo
echo "Supabase dashboard -> Connect -> Transaction pooler: copy the HOST part,"
echo "e.g. aws-0-us-east-2.pooler.supabase.com"
read -r -p "Pooler host: " HOST
[[ "$HOST" =~ ^[a-z0-9.-]+\.pooler\.supabase\.com$ ]] || fail "That doesn't look like a pooler host"

# --- secrets (hidden) --------------------------------------------------------
say "Paste each secret and press Enter. Nothing shows while you paste - that's normal."
read -r -s -p "Anthropic API key: " AKEY; echo
[[ "$AKEY" == sk-ant-* ]] || fail "That doesn't look like an Anthropic key (should start with sk-ant-)"
read -r -s -p "kiwi_reader password (Part B, password 1): " PW1; echo
read -r -s -p "kiwi_manager_reader password (Part B, password 2): " PW2; echo
[ -n "$PW1" ] && [ -n "$PW2" ] || fail "Both passwords are needed"
[ "$PW1" != "$PW2" ] || fail "The two passwords should be different"

enc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))' <<<"$1" | sed 's/%0A$//'; }
URL1="postgresql://kiwi_reader.$REF:$(enc "$PW1")@$HOST:6543/postgres"
URL2="postgresql://kiwi_manager_reader.$REF:$(enc "$PW2")@$HOST:6543/postgres"

# Optional: check the logins work before saving them (only if psql is installed).
if command -v psql >/dev/null; then
  say "Checking the two database logins..."
  psql "$URL1" -tAc "select 'reader ok, sees ' || count(*) || ' downtime comments' from downtime_log" || fail "kiwi_reader login failed - check password 1 and the host"
  psql "$URL2" -tAc "select 'manager ok'" || fail "kiwi_manager_reader login failed - check password 2"
fi

# --- sync token -> kiwi_sync.conf (never printed) ----------------------------
CONF=kiwi/importer/kiwi_sync.conf
if [ -f "$CONF" ] && grep -q '^token *= *[0-9a-f]\{64\}' "$CONF"; then
  T=$(sed -nE 's/^token *= *([0-9a-f]{64}).*/\1/p' "$CONF")
  say "Reusing the sync token already in $CONF"
else
  T=$(openssl rand -hex 32)
  umask 077
  cat > "$CONF" <<EOF
# KIWI SharePoint sync settings. Holds a secret token: don't share or commit.
url    = https://$REF.supabase.co/functions/v1/kiwi-ingest
token  = $T
# On the sync PC, set this to the OneDrive-synced SharePoint folder:
folder = C:\\Users\\<you>\\<Company>\\<Shift report folder>
pattern = *.xlsx
EOF
  chmod 600 "$CONF"
  say "Sync token saved in $CONF (readable only by you)"
fi

# --- set secrets and deploy --------------------------------------------------
say "Saving secrets in Supabase..."
SB secrets set --remote="$REF" \
  ANTHROPIC_API_KEY="$AKEY" KIWI_DB_URL="$URL1" KIWI_MANAGER_DB_URL="$URL2" KIWI_SYNC_TOKEN="$T"
unset AKEY PW1 PW2 URL1 URL2 T

say "Deploying kiwi..."
SB functions deploy kiwi --use-api --remote="$REF"
say "Deploying kiwi-ingest (token-protected, like plc-ingest)..."
SB functions deploy kiwi-ingest --no-verify-jwt --use-api --remote="$REF"

# production-detail was deployed from the dashboard. Only replace it if the live
# version is the same as the one in this repo (plus our sign-in check); otherwise
# keep the live one and save it for review, so nobody's dashboard edits are lost.
say "Checking the live production-detail before updating it..."
TMP=$(mktemp -d); mkdir -p "$TMP/supabase/functions"
LIVE_OK=no
if (cd "$TMP" && SB functions download production-detail --use-api --remote="$REF" >/dev/null 2>&1) \
   && [ -f "$TMP/supabase/functions/production-detail/index.ts" ]; then
  if git show HEAD:supabase/functions/production-detail/index.ts 2>/dev/null \
     | diff -q - "$TMP/supabase/functions/production-detail/index.ts" >/dev/null; then
    LIVE_OK=yes
  else
    mkdir -p kiwi/_review && cp "$TMP/supabase/functions/production-detail/index.ts" kiwi/_review/production-detail.live.ts
  fi
fi
rm -rf "$TMP"
if [ "$LIVE_OK" = yes ]; then
  say "Live copy matches the repo - deploying production-detail with the sign-in check..."
  SB functions deploy production-detail --use-api --remote="$REF"
else
  say "NOT redeploying production-detail: the live version differs from the repo (or couldn't be downloaded)."
  echo "Saved live copy (if downloaded): kiwi/_review/production-detail.live.ts - tell Claude and we'll merge."
fi

say "Secrets now in Supabase (values hidden):"
SB secrets list --remote="$REF" || true

say "Step 3 done."
