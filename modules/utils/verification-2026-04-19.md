# Utils module verification — 2026-04-19

## Automated checks

Ran from repo root:

- `npm run typecheck`
- `T_WS_CONTINUOUS_RECONNECT=false LOGGING_LEVEL=warn node --test-force-exit --test-concurrency 1 --import=ts-node-maintained/register/esm modules/utils/test/public-commands.test.ts`
- `T_WS_CONTINUOUS_RECONNECT=false LOGGING_LEVEL=warn node --test-force-exit --test-concurrency 1 --import=ts-node-maintained/register/esm modules/utils/test/admin-commands.test.ts`
- `T_WS_CONTINUOUS_RECONNECT=false LOGGING_LEVEL=warn node --test-force-exit --test-concurrency 1 --import=ts-node-maintained/register/esm modules/community-fund/test/fund-contribute.test.ts`

Results:

- typecheck: pass
- utils public commands: 6/6 pass
- utils admin commands: 15/15 pass
- community-fund contribute regression suite: 7/7 pass

## Real Paper-server verification

Environment:

- Paper game server: `minecraft`
- Takaro gameServerId: `c423b25e-c2af-4ea1-ab0a-a559574d1b65`
- Installed module: `test-utils`
- Installed with broadcast toggles enabled for givecurrency/kick/ban
- Command prefix: `+`
- Bots: `adminbot` / `userbot`
- Admin permissions assigned to `Bot_adminbot`: `UTILS_KICK`, `UTILS_BAN`, `UTILS_GIVE_CURRENCY`

### Public commands

#### `+serverinfo` by `userbot`
- success: `true`
- key log:
  - `Server: minecraft`
  - `Players online: 2`
  - `Info: Read /rules and join /discord`

#### `+online` by `userbot`
- success: `true`
- key log:
  - `2 players online: Bot_adminbot, Bot_userbot`

#### `+discord` by `userbot`
- success: `true`
- key log:
  - `Join our Discord: https://discord.gg/takaro`

#### `+rules` by `userbot`
- success: `true`
- key log:
  - `Server rules:`
  - `1. No griefing`
  - `2. Be respectful`
  - `3. No cheating`

### Permission-denied path

#### `+kick adminbot` by `userbot`
- success: `false`
- key log:
  - `You do not have permission to use this command.`

### Invalid-input path

#### `+givecurrency userbot 0` by `adminbot`
- success: `false`
- key log:
  - `Usage: /givecurrency <player> <amount> — Amount must be a positive whole number.`

### Admin commands

> In the Paper environment, player-targeting used the displayed Takaro player names: `Bot_adminbot` and `Bot_userbot`.

#### `+givecurrency Bot_userbot 5` by `adminbot`
- success: `true`
- key logs:
  - `utils:givecurrency admin=Bot_adminbot target=Bot_userbot amount=5`
  - `Gave 5 currency to Bot_userbot.`
  - `Bot_adminbot gave you 5 currency.`
  - `Bot_userbot received 5 currency from Bot_adminbot.`

#### `+kick Bot_userbot repeated base griefing` by `adminbot`
- success: `true`
- key logs:
  - `utils:kick admin=Bot_adminbot target=Bot_userbot reason=repeated base griefing`
  - `Kicked Bot_userbot. Reason: repeated base griefing`
  - `Bot_userbot was kicked by Bot_adminbot. Reason: repeated base griefing`

#### `+ban Bot_userbot 10m spawn camping again` by `adminbot`
- success: `true`
- key logs:
  - `utils:ban payload={"reason":"spawn camping again","expiresAt":"2026-04-19T14:22:09.287Z"}`
  - `utils:ban admin=Bot_adminbot target=Bot_userbot duration=10 minutes reason=spawn camping again`
  - `Banned Bot_userbot for 10 minutes. Reason: spawn camping again`
  - `Bot_userbot was banned by Bot_adminbot for 10 minutes. Reason: spawn camping again`

## Outcome

Required real-server verification was completed for:

- every public command
- every admin command
- one invalid-input path
- one permission-denied path
- broadcast-enabled behavior

Observed result: all exercised Paper-server commands returned the expected success/failure state and emitted the expected user-facing log messages.
