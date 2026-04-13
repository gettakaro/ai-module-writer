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
- installs it on the selected live Paper game server
- creates a real bot with a Minecraft-safe username
- verifies sequential delivery, placeholder rendering, zero-player skip-without-advance, and weighted random shuffle-bag behavior
- writes labeled evidence summaries to temp JSON files and prints explicit PASS/FAIL lines

If Takaro has more than one non-test game server, set one of these env vars before running the script so it cannot target the wrong server:

```bash
export SERVER_MESSAGES_GAMESERVER_ID=<uuid>
# or
export SERVER_MESSAGES_GAMESERVER_NAME=<exact-name>
```

## What to verify in the output

1. **Sequential delivery works live**
   - first trigger sends `Seq A (... )`
   - second trigger sends `Seq B`
2. **Placeholders render live**
   - `{playerCount}` resolves to the connected bot count
   - `{serverName}` resolves to the Paper server name from Takaro metadata
3. **Skipped tick does not consume rotation**
   - after deleting the bot, the next trigger logs the `no players online` skip path and emits no chat message
   - after reconnecting the bot, the following trigger sends `Seq A` again, proving the skipped tick did not advance state
4. **Weighted random mode works live**
   - across three triggers with weights `Red=1` and `Gold=2`, the evidence shows exactly one `Red` and two `Gold` broadcasts before reshuffle
5. **Module remains reinstallable**
   - the script always uninstalls then reinstalls the latest config before each phase

## Suggested evidence capture

Save the printed evidence file paths and, if needed, attach the generated JSON files from the temp evidence directory to your review notes or CI artifacts. That gives a durable record of the mandatory in-game verification step for this module.
