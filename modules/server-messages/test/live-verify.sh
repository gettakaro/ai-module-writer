#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

MODULE_DIR="modules/server-messages"
BOT_PORT="${BOT_PORT:-3101}"
BOT_NAME="server-messages-tester"
CONFIG_FILE="$(mktemp)"
trap 'rm -f "$CONFIG_FILE"; curl -fsS -X DELETE "http://localhost:${BOT_PORT}/bots/${BOT_NAME}" >/dev/null 2>&1 || true' EXIT

cat > "$CONFIG_FILE" <<'JSON'
{
  "messages": [
    { "text": "Seq A ({playerCount} online @ {serverName})" },
    { "text": "Seq B" }
  ],
  "order": "sequential",
  "interval": "* * * * *"
}
JSON

echo "[1/8] Start services"
docker compose up -d paper bot redis >/dev/null

echo "[2/8] Build and auth"
npm run build >/dev/null
bash scripts/takaro-auth.sh >/dev/null

echo "[3/8] Push module"
bash scripts/module-push.sh "$MODULE_DIR" >/dev/null

echo "[4/8] Discover Paper game server and module ids"
GAME_SERVER_JSON="$(bash scripts/takaro-api.sh POST /gameserver/search '{"limit":100,"page":0}')"
GAME_SERVER_ID="$(printf '%s' "$GAME_SERVER_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const row=j.data.find((gs)=>!gs.name.startsWith("test-")) ?? j.data[0];if(!row) process.exit(1);process.stdout.write(row.id);});')"
MODULE_JSON="$(bash scripts/takaro-api.sh POST /module/search '{"filters":{"name":["server-messages"]},"limit":10,"page":0}')"
MODULE_ID="$(printf '%s' "$MODULE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const row=j.data.find((m)=>m.name==="server-messages") ?? j.data[0];if(!row) process.exit(1);process.stdout.write(row.id);});')"
VERSION_ID="$(printf '%s' "$MODULE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const row=j.data.find((m)=>m.name==="server-messages") ?? j.data[0];if(!row?.latestVersion?.id) process.exit(1);process.stdout.write(row.latestVersion.id);});')"

echo "Paper gameServerId=$GAME_SERVER_ID"
echo "Module moduleId=$MODULE_ID versionId=$VERSION_ID"

echo "[5/8] Reinstall module on Paper with sequential config"
bash scripts/takaro-api.sh DELETE "/module/${MODULE_ID}/gameserver/${GAME_SERVER_ID}" '{}' >/dev/null 2>&1 || true
bash scripts/takaro-api.sh POST /module/install "$(node -e 'const fs=require("fs"); const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify({versionId:process.argv[2], gameServerId:process.argv[3], userConfig: JSON.stringify(cfg)}));' "$CONFIG_FILE" "$VERSION_ID" "$GAME_SERVER_ID")" >/dev/null

echo "[6/8] Create bot and wait for join"
curl -fsS -X POST "http://localhost:${BOT_PORT}/bots" -H 'Content-Type: application/json' -d "{\"name\":\"${BOT_NAME}\"}" >/dev/null || true
sleep 8

echo "[7/8] Trigger cron twice, then disconnect bot and trigger once more"
TRIGGER_BODY="$(node -e 'process.stdout.write(JSON.stringify({gameServerId:process.argv[1], cronjobId:"broadcast-messages", moduleId:process.argv[2]}));' "$GAME_SERVER_ID" "$MODULE_ID")"
bash scripts/takaro-api.sh POST /cronJob/trigger "$TRIGGER_BODY" >/dev/null
sleep 4
bash scripts/takaro-api.sh POST /cronJob/trigger "$TRIGGER_BODY" >/dev/null
sleep 4
curl -fsS -X DELETE "http://localhost:${BOT_PORT}/bots/${BOT_NAME}" >/dev/null || true
sleep 5
bash scripts/takaro-api.sh POST /cronJob/trigger "$TRIGGER_BODY" >/dev/null
sleep 4

echo "[8/8] Fetch recent chat/cron evidence"
bash scripts/takaro-api.sh POST /event/search "$(node -e 'process.stdout.write(JSON.stringify({filters:{gameserverId:[process.argv[1]], eventName:["ChatMessage","cronjob-executed"]}, sortBy:"createdAt", sortDirection:"desc", limit:20, page:0}));' "$GAME_SERVER_ID")"

echo "Done. Review the event output for:"
echo "- sequential broadcasts received by the bot"
echo "- placeholder rendering with playerCount/serverName"
echo "- skip-without-advance behavior after the bot disconnects"
