#!/usr/bin/env bash
# Push a local module to Takaro via the import API.
# Usage: ./module-push.sh <module-dir>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${1:?Usage: module-push.sh <module-dir>}"

if [[ ! -d "$MODULE_DIR" ]]; then
  echo "ERROR: $MODULE_DIR is not a directory" >&2
  exit 1
fi

MODULE_NAME=$(jq -r .name "${MODULE_DIR}/module.json")
echo "Pushing module '$MODULE_NAME' to Takaro..." >&2

# Convert to JSON file (avoids shell interpolation issues with template literals)
TEMP_FILE=$(mktemp /tmp/takaro-push-XXXXXX.json)
trap 'rm -f "$TEMP_FILE"' EXIT
node "$SCRIPT_DIR/../dist/scripts/module-to-json.js" "$MODULE_DIR" "$TEMP_FILE"

# Check if modules with this exact name already exist. Some hosted/built-in modules cannot be
# deleted (HTTP 400), so treat those as protected and leave them in place instead of aborting.
SEARCH_RESULT=$(bash "$SCRIPT_DIR/takaro-api.sh" POST /module/search "$(jq -n --arg name "$MODULE_NAME" '{"filters":{"name":[$name]}}')")
mapfile -t EXISTING_IDS < <(echo "$SEARCH_RESULT" | jq -r --arg name "$MODULE_NAME" '.data[] | select(.name == $name) | .id')
REPLACED_ID=""

for EXISTING_ID in "${EXISTING_IDS[@]}"; do
  [[ -z "$EXISTING_ID" ]] && continue
  echo "Module '$MODULE_NAME' already exists (id: $EXISTING_ID), deleting before re-import if allowed..." >&2
  if bash "$SCRIPT_DIR/takaro-api.sh" DELETE "/module/$EXISTING_ID" '{}' >/dev/null 2>/tmp/takaro-module-delete.stderr; then
    echo "Deleted existing module $EXISTING_ID" >&2
    if [[ -n "$REPLACED_ID" ]]; then
      echo "ERROR: Found multiple replaceable modules named '$MODULE_NAME'. Refusing to continue blindly." >&2
      exit 1
    fi
    REPLACED_ID="$EXISTING_ID"
    continue
  fi

  if grep -q '400' /tmp/takaro-module-delete.stderr; then
    echo "Skipping protected module $EXISTING_ID; Takaro rejected deletion with HTTP 400." >&2
    continue
  fi

  cat /tmp/takaro-module-delete.stderr >&2
  exit 1
done
rm -f /tmp/takaro-module-delete.stderr

# Import the module
IMPORT_RESULT=$(bash "$SCRIPT_DIR/takaro-api.sh" POST /module/import "@$TEMP_FILE") || {
  if [[ -n "$REPLACED_ID" ]]; then
    echo "WARNING: Module '$MODULE_NAME' was deleted (id: $REPLACED_ID) but re-import failed. Module may need manual re-push." >&2
  else
    echo "ERROR: Import of '$MODULE_NAME' failed." >&2
  fi
  exit 1
}

IMPORTED_NAME=$(echo "$IMPORT_RESULT" | jq -r '.data.name // empty')
IMPORTED_ID=$(echo "$IMPORT_RESULT" | jq -r '.data.id // empty')
if [[ -n "$IMPORTED_ID" ]]; then
  echo "Successfully imported module '$IMPORTED_NAME' (id: $IMPORTED_ID)" >&2
else
  echo "Import completed (could not parse module id from response)" >&2
fi
echo "$IMPORT_RESULT"
