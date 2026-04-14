#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

MODULE_DIR="modules/server-messages"
BOT_PORT="${BOT_PORT:-3101}"

wait_for_paper() {
  echo "Waiting for Paper to become ready..."
  for _ in $(seq 1 90); do
    if docker compose exec -T paper rcon-cli list >/dev/null 2>&1; then
      return 0
    fi
    if docker compose logs paper 2>&1 | grep -q "Done ("; then
      return 0
    fi
    sleep 2
  done

  echo "Paper did not become ready in time. Recent logs:" >&2
  docker compose logs paper --tail=120 >&2 || true
  return 1
}

wait_for_bot_api() {
  echo "Waiting for bot API on port ${BOT_PORT}..."
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:${BOT_PORT}/status" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "Bot API did not become ready in time. Recent logs:" >&2
  docker compose logs bot --tail=120 >&2 || true
  return 1
}

echo "[1/5] Start services"
docker compose up -d paper bot redis
wait_for_paper
wait_for_bot_api

echo "[2/5] Build TypeScript"
npm run build

echo "[3/5] Authenticate with Takaro"
bash scripts/takaro-auth.sh

echo "[4/5] Push module"
bash scripts/module-push.sh "$MODULE_DIR"

echo "[5/5] Run live Paper verification"
node modules/server-messages/test/live-verify.mjs
