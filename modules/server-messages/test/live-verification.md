# Server Messages live verification

This module requires real Paper/bot verification in addition to the automated API-backed tests.

## Runnable artifact

Use the helper script in this directory:

```bash
bash modules/server-messages/test/live-verify.sh
```

The script:
- starts `paper`, `bot`, and `redis`
- builds and authenticates
- pushes `modules/server-messages`
- installs it on the non-`test-*` Paper game server
- creates a real bot
- triggers the cronjob multiple times
- prints recent `ChatMessage` and `cronjob-executed` events as evidence

## What to verify in the output

1. **Sequential delivery works live**
   - first trigger sends `Seq A (... )`
   - second trigger sends `Seq B`
2. **Placeholders render live**
   - `{playerCount}` resolves to the connected bot count
   - `{serverName}` resolves to the Paper server name from Takaro metadata
3. **Skipped tick does not consume rotation**
   - after deleting the bot, the next trigger should log the `no players online` skip path instead of emitting a chat message
4. **Module remains reinstallable**
   - the script always attempts a delete/reinstall before installing the latest config

## Suggested evidence capture

Save the printed `/event/search` JSON from the script into your review notes or CI artifacts. That gives a durable record of the mandatory in-game verification step for this module.
