#!/usr/bin/env bash
# Migrate couchmail user docs to CouchDB auth-compatible format
# Run BEFORE switching to the new system config
#
# Usage: COUCH_ADMIN=user:pass ./migrate-users.sh [host]
set -euo pipefail

HOST="${1:-localhost}"
BASE="http://${HOST}:5984/mail"
AUTH="${COUCH_ADMIN:?Set COUCH_ADMIN=user:pass}"

echo "=== Couchmail user migration ==="
echo "Target: $BASE"

migrate_user() {
  local email="$1" roles="$2"
  local encoded new_id

  encoded=$(printf '%s' "$email" | sed 's/@/%40/g')
  new_id="org.couchdb.user:${email}"
  local new_encoded
  new_encoded=$(printf '%s' "$new_id" | sed 's/@/%40/g; s/:/%3A/g')

  echo ""
  echo "--- $email → $new_id ---"

  # Check if already migrated
  if curl -sf -u "$AUTH" "$BASE/$new_encoded" >/dev/null 2>&1; then
    echo "  SKIP: already migrated"
    return
  fi

  # Fetch old doc
  local old_doc
  old_doc=$(curl -sf -u "$AUTH" "$BASE/$encoded") || {
    echo "  SKIP: old doc not found"
    return
  }

  # Extract fields using jq-like grep (avoid python dependency)
  local old_rev old_password sieve_json
  old_rev=$(echo "$old_doc" | grep -o '"_rev":"[^"]*"' | head -1 | cut -d'"' -f4)
  old_password=$(echo "$old_doc" | grep -o '"password":"[^"]*"' | head -1 | cut -d'"' -f4)

  # Build roles array
  local roles_arr="[]"
  if [ -n "$roles" ]; then
    roles_arr="[\"$roles\"]"
  fi

  # Check for sieve field
  local sieve_field=""
  if echo "$old_doc" | grep -q '"sieve"'; then
    sieve_field=$(echo "$old_doc" | grep -o '"sieve":{[^}]*}')
    sieve_field=",${sieve_field}"
  fi

  # Create new doc
  local new_doc="{\"_id\":\"${new_id}\",\"name\":\"${email}\",\"type\":\"user\",\"roles\":${roles_arr},\"dovecot_password\":\"${old_password}\",\"password\":\"changeme-on-first-login\"${sieve_field}}"

  echo "  Creating: $new_id"
  curl -sf -u "$AUTH" -X PUT -H "Content-Type: application/json" \
    "$BASE/$new_encoded" -d "$new_doc" && echo "" || { echo "  FAILED to create"; return; }

  echo "  Deleting old: $email (rev: $old_rev)"
  curl -sf -u "$AUTH" -X DELETE "$BASE/$encoded?rev=$old_rev" && echo "" || echo "  FAILED to delete old"
}

# Migrate users
migrate_user "josh@6bit.com" "admin"
migrate_user "ada@6bit.com" ""
migrate_user "jonathan@6bit.com" ""
migrate_user "ghost@curiouslynerdy.com" ""

echo ""
echo "=== Uploading _design/mail ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESIGN_DOC=$(cat "$SCRIPT_DIR/../design/mail-validation.json")

# Check if design doc exists, add _rev if so
existing_rev=$(curl -sf -u "$AUTH" "$BASE/_design/mail" 2>/dev/null | grep -o '"_rev":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
if [ -n "$existing_rev" ]; then
  echo "  Updating existing (rev: $existing_rev)"
  DESIGN_DOC=$(echo "$DESIGN_DOC" | sed "s/\"_id\"/\"_rev\":\"${existing_rev}\",\"_id\"/")
fi

curl -sf -u "$AUTH" -X PUT -H "Content-Type: application/json" \
  "$BASE/_design/mail" -d "$DESIGN_DOC" && echo "" || echo "FAILED"

echo ""
echo "=== Done ==="
echo "Josh's CouchDB web password is 'changeme-on-first-login'"
echo "Change it via the web UI after deployment."
