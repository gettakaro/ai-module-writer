#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

MODULE_DIR="modules/server-messages"

echo "[1/4] Start services"
docker compose up -d paper bot redis >/dev/null

echo "[2/4] Build and authenticate"
npm run build >/dev/null
bash scripts/takaro-auth.sh >/dev/null

echo "[3/4] Push module"
bash scripts/module-push.sh "$MODULE_DIR" >/dev/null

echo "[4/4] Run live Paper verification"
node modules/server-messages/test/live-verify.mjs
