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
IMPORT_NAME="${TAKARO_IMPORT_MODULE_NAME:-$MODULE_NAME}"
echo "Pushing module '$IMPORT_NAME' to Takaro..." >&2

# Convert to JSON file (avoids shell interpolation issues with template literals)
TEMP_FILE=$(mktemp /tmp/takaro-push-XXXXXX.json)
trap 'rm -f "$TEMP_FILE"' EXIT
node "$SCRIPT_DIR/../dist/scripts/module-to-json.js" "$MODULE_DIR" "$TEMP_FILE"
VALIDATION_NAME="${IMPORT_NAME}-validate-$(date +%s)"

# Prove the payload is importable under a temporary validation name before we
# touch any existing module with the real target name.
jq --arg name "$VALIDATION_NAME" '.name = $name' "$TEMP_FILE" > "${TEMP_FILE}.tmp"
mv "${TEMP_FILE}.tmp" "$TEMP_FILE"
VALIDATION_RESULT=$(bash "$SCRIPT_DIR/takaro-api.sh" POST /module/import "@$TEMP_FILE") || {
  echo "ERROR: Validation import of '$IMPORT_NAME' failed. Existing module copies were left untouched." >&2
  exit 1
}
VALIDATION_ID=$(echo "$VALIDATION_RESULT" | jq -r '.data.id // empty')
if [[ -z "$VALIDATION_ID" ]]; then
  VALIDATION_SEARCH=$(bash "$SCRIPT_DIR/takaro-api.sh" POST /module/search "$(jq -n --arg name "$VALIDATION_NAME" '{"filters":{"name":[$name]}}')")
  VALIDATION_ID=$(echo "$VALIDATION_SEARCH" | jq -r --arg name "$VALIDATION_NAME" '[.data[] | select(.name == $name)][0].id // empty')
fi
if [[ -n "$VALIDATION_ID" ]]; then
  bash "$SCRIPT_DIR/takaro-api.sh" DELETE "/module/$VALIDATION_ID" '{}' >/dev/null
fi

SEARCH_RESULT=$(bash "$SCRIPT_DIR/takaro-api.sh" POST /module/search "$(jq -n --arg name "$IMPORT_NAME" '{"filters":{"name":[$name]}}')")
EXISTING_ID=$(echo "$SEARCH_RESULT" | jq -r --arg name "$IMPORT_NAME" '[.data[] | select(.name == $name)][0].id // empty')
if [[ -n "$EXISTING_ID" ]]; then
  echo "Validation succeeded. Replacing existing module '$IMPORT_NAME' (id: $EXISTING_ID)..." >&2
  bash "$SCRIPT_DIR/takaro-api.sh" DELETE "/module/$EXISTING_ID" '{}' >/dev/null
fi

jq --arg name "$IMPORT_NAME" '.name = $name' "$TEMP_FILE" > "${TEMP_FILE}.tmp"
mv "${TEMP_FILE}.tmp" "$TEMP_FILE"
IMPORT_RESULT=$(bash "$SCRIPT_DIR/takaro-api.sh" POST /module/import "@$TEMP_FILE") || {
  echo "ERROR: Final import of '$IMPORT_NAME' failed after successful validation import." >&2
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
