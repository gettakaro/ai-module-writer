#!/usr/bin/env bash
# Push a local module to Takaro via the safer replacement helper used by the integration tests.
# Usage: ./module-push.sh <module-dir>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="${1:?Usage: module-push.sh <module-dir>}"
RUNNER="$SCRIPT_DIR/module-push-runner.mjs"

if [[ ! -d "$MODULE_DIR" ]]; then
  echo "ERROR: $MODULE_DIR is not a directory" >&2
  exit 1
fi

if [[ ! -f "$MODULE_DIR/module.json" ]]; then
  echo "ERROR: $MODULE_DIR/module.json does not exist" >&2
  exit 1
fi

if [[ ! -f "$RUNNER" ]]; then
  echo "ERROR: $RUNNER is missing" >&2
  exit 1
fi

MODULE_NAME=$(jq -r '.name // empty' "$MODULE_DIR/module.json")
if [[ -z "$MODULE_NAME" ]]; then
  echo "ERROR: Could not read module name from $MODULE_DIR/module.json" >&2
  exit 1
fi

echo "Pushing module '$MODULE_NAME' to Takaro..." >&2
node --import=ts-node-maintained/register/esm "$RUNNER" "$MODULE_DIR"
