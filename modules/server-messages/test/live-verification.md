# Server Messages live verification

This module requires real Paper/bot verification in addition to the automated API-backed tests.

## Runnable artifact

Use the helper script in this directory:

```bash
bash modules/server-messages/test/live-verify.sh
```

The script:
- starts `paper`, `bot`, and `redis`
- waits for Paper startup completion and the bot API before exercising the module
- builds and authenticates
- pushes `modules/server-messages`
- installs it on the explicitly selected live Paper test game server
- disables the cronjob's automatic schedule during the run so only the explicit trigger steps are measured
- creates a real bot with a Minecraft-safe username
- verifies sequential delivery, placeholder rendering, zero-player skip-without-advance, and weighted random shuffle-bag behavior using a unique run id embedded in the broadcast text
- writes labeled evidence summaries to temp JSON files, writes a durable summary to `modules/server-messages/test/live-verification.latest.json`, and prints explicit PASS/FAIL lines

You must set one of these env vars before running the script. The verifier refuses to auto-select a server, and it also refuses to touch a non-test server unless you explicitly opt in with `SERVER_MESSAGES_ALLOW_NON_TEST_SERVER=1`:

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
   - the script always uninstalls then reinstalls the latest config before each phase on the explicitly selected test server

## Suggested evidence capture

The verifier writes the latest durable summary to:

```text
modules/server-messages/test/live-verification.latest.json
```

It also prints temp evidence file paths for the detailed sequential and random event captures. Attach those JSON files to review notes or CI artifacts when needed.

## Latest recorded run

Do not commit per-run timestamps, server ids, run ids, or other environment-specific details here. Instead, run the verifier when needed and inspect the generated temp evidence plus the stable summary file.

See `modules/server-messages/test/live-verification.latest.json` for the latest durable pass/fail summary without environment-specific metadata.
