# Live Paper/Bot Verification

Date: 2026-04-19

## Environment
- Paper game server: `nca-ai-paper`
- Game server ID: `eaf1086a-a81d-41c4-b3f0-afa6a60ddda9`
- Module ID used for verification: `56ea14b1-6d57-43f6-a366-ab5b14e98334`
- Module version ID: `90132121-2665-4a10-a524-1bd22f8571a6`
- Cronjob ID: `24eca799-9a72-41b5-94a4-11837f5115b9`
- Bot name: `srvmsg`

Raw capture: `modules/server-messages/LIVE_VERIFICATION.json`

## Steps run
1. `docker compose up -d paper bot redis`
2. Waited for Paper startup and Takaro plugin identification.
3. Created bot `srvmsg` through the bot HTTP API and verified it connected.
4. Pushed `modules/server-messages` and installed it on the real Paper server with a manual cron schedule override.
5. Triggered the cronjob through the Takaro API and inspected Takaro events.
6. Reinstalled with random weighted config and repeated live cron triggers.

## Sequential verification
Installed config:

```json
{
  "order": "sequential",
  "messages": [
    { "text": "Live Seq 1" },
    { "text": "Live Seq 2" }
  ]
}
```

Observed live broadcasts:
- Trigger 1 -> `Live Seq 1`
- Trigger 2 -> `Live Seq 2`

## No-player skip verification
- Deleted the bot so no players were connected.
- Triggered the cronjob again.
- Observed no `chat-message` events for that interval.
- Recreated the bot and triggered again.
- Observed `Live Seq 1`, confirming the skipped interval did **not** advance sequential state.

Observed results:
- No-player trigger -> `[]`
- Post-skip trigger -> `Live Seq 1`

## Random weighted verification
Installed config:

```json
{
  "order": "random",
  "messages": [
    { "text": "Live Red", "weight": 1 },
    { "text": "Live Green", "weight": 2 },
    { "text": "Live Gold", "weight": 1 }
  ]
}
```

Observed one live bag cycle:
- Trigger 1 -> `Live Green`
- Trigger 2 -> `Live Red`
- Trigger 3 -> `Live Gold`
- Trigger 4 -> `Live Green`

This matches the expected weighted shuffle-bag shape for weights `1/2/1`: one cycle consumed each slot exactly once, with `Live Green` appearing twice across the four draws.

## Notes
- Takaro `chat-message` events confirmed the actual messages delivered to the Paper server.
- The raw verification JSON also includes a captured `cronjob-executed` event with runtime logs from the live server.
