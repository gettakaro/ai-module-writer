#!/usr/bin/env bash
# Push a local module to Takaro via the import API.
# Usage: ./module-push.sh <module-dir>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${1:?Usage: module-push.sh <module-dir>}"
MODULE_JSON="$MODULE_DIR/module.json"
TOKEN_FILE="/tmp/takaro-token"

if [[ ! -d "$MODULE_DIR" ]]; then
  echo "ERROR: $MODULE_DIR is not a directory" >&2
  exit 1
fi

if [[ ! -f "$MODULE_JSON" ]]; then
  echo "ERROR: Missing module metadata file: $MODULE_JSON" >&2
  echo "Expected a valid module.json in the module directory before pushing." >&2
  exit 1
fi

if ! MODULE_NAME=$(jq -er '.name | strings | select(length > 0)' "$MODULE_JSON" 2>/tmp/takaro-module-push-jq.err); then
  JQ_ERROR=$(tr '\n' ' ' < /tmp/takaro-module-push-jq.err | sed 's/  */ /g; s/^ //; s/ $//')
  rm -f /tmp/takaro-module-push-jq.err
  echo "ERROR: Invalid module metadata in $MODULE_JSON" >&2
  echo "module.json must be valid JSON and include a non-empty string 'name' field." >&2
  if [[ -n "$JQ_ERROR" ]]; then
    echo "jq: $JQ_ERROR" >&2
  fi
  exit 1
fi
rm -f /tmp/takaro-module-push-jq.err

echo "Pushing module '$MODULE_NAME' to Takaro..." >&2

ensure_token() {
  if [[ -n "${TAKARO_TOKEN:-}" ]]; then
    return
  fi

  if [[ -s "$TOKEN_FILE" ]]; then
    return
  fi

  "$SCRIPT_DIR/takaro-auth.sh" >&2
}

retry_after_auth() {
  if "$SCRIPT_DIR/takaro-auth.sh" >&2; then
    return 0
  fi

  echo "ERROR: Takaro authentication expired and automatic refresh failed." >&2
  echo "Check your .env / exported Takaro credentials, or set TAKARO_TOKEN before retrying module-push.sh." >&2
  return 1
}

# Convert to JSON file (avoids shell interpolation issues with template literals)
TEMP_FILE=$(mktemp /tmp/takaro-push-XXXXXX.json)
IMPORT_STDERR=$(mktemp /tmp/takaro-import-stderr-XXXXXX.log)
trap 'rm -f "$TEMP_FILE" "$IMPORT_STDERR"' EXIT
node "$SCRIPT_DIR/../dist/scripts/module-to-json.js" "$MODULE_DIR" "$TEMP_FILE"

ensure_token

# Import the module using the API client. Raw curl imports can silently drop nested
# version payloads (cronjobs/functions/config schema), resulting in an empty module.
if IMPORT_RESULT=$(node "$SCRIPT_DIR/../dist/scripts/module-import.js" "$TEMP_FILE" 2>"$IMPORT_STDERR"); then
  echo "$IMPORT_RESULT"
  exit 0
fi

if grep -q "401" "$IMPORT_STDERR" || grep -qi "unauthorized" "$IMPORT_STDERR"; then
  retry_after_auth
  IMPORT_RESULT=$(node "$SCRIPT_DIR/../dist/scripts/module-import.js" "$TEMP_FILE" 2>"$IMPORT_STDERR")
  echo "$IMPORT_RESULT"
  exit 0
fi

cat "$IMPORT_STDERR" >&2
exit 1
