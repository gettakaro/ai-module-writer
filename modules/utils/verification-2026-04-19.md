# Server-utils verification — 2026-04-19

## Automated checks

Ran from repo root:

- `npm run build`
- `node --check modules/utils/src/functions/utils-helpers.js`
- `node --check modules/utils/src/commands/givecurrency/index.js`
- `node --check modules/utils/src/commands/kick/index.js`
- `node --check modules/utils/src/commands/ban/index.js`
- `node --input-type=module -e "import('./modules/utils/src/functions/utils-formatters.js').then(m=>console.log(m.formatOnlinePlayersLine([{playerName:'Zed'},{playerName:'Amy'}])))"`

Results:

- build: pass
- syntax checks: pass
- direct formatter import: pass (`2 players online: Amy, Zed`)

Attempted to rerun the mock-server integration suites, but the local Takaro test stack is still unavailable in this environment (`ECONNREFUSED` on the repo's configured Postgres/Redis-backed test services). I did **not** treat that as verification coverage; the real Paper-server checks below are the authoritative evidence for this turn.

## Real Paper-server verification

Environment:

- Paper game server: `minecraft`
- Takaro gameServerId: `c423b25e-c2af-4ea1-ab0a-a559574d1b65`
- Installed module: `server-utils`
- Installed versionId: `6327679e-9e81-4cbc-99fc-dfe4a12d7520`
- Command prefix: `+`
- Bot API port: `3103`
- Bots: `adminbot`, `targetbot`
- Admin permissions assigned to `Bot_adminbot`: `UTILS_KICK`, `UTILS_BAN`, `UTILS_GIVE_CURRENCY`
- Config used for verification:
  - `discordLink=https://discord.gg/takaro`
  - `rules=["No griefing","Be respectful","No cheating"]`
  - `serverInfoMessage="No griefing outside claim areas. Join Discord with /discord"`
  - all three broadcast toggles enabled with default templates

### Public commands

#### `+serverinfo` by `adminbot`
- success: `true`
- key logs:
  - `Server: minecraft`
  - `Players online: 2`
  - `Info: No griefing outside claim areas. Join Discord with /discord`

#### `+online` by `adminbot`
- success: `true`
- key logs:
  - `2 players online: Bot_adminbot, Bot_targetbot`

#### `+discord` by `adminbot`
- success: `true`
- key logs:
  - `Join our Discord: https://discord.gg/takaro`

#### `+rules` by `adminbot`
- success: `true`
- key logs:
  - `Server rules:`
  - `1. No griefing`
  - `2. Be respectful`
  - `3. No cheating`

### Permission-denied path

#### `+kick Bot_adminbot griefing` by `targetbot`
- success: `false`
- key log:
  - `You do not have permission to use this command.`

### Admin commands — happy paths

#### `+givecurrency Bot_targetbot 2` by `adminbot`
- success: `true`
- key logs:
  - `Gave 2 currency to Bot_targetbot.`
  - `Bot_adminbot gave you 2 currency.`
  - `Bot_targetbot received 2 currency from Bot_adminbot.`

This confirms the admin confirmation, recipient notification, and broadcast are only logged after successful delivery in the current implementation.

#### `+kick Bot_targetbot repeated base griefing` by `adminbot`
- success: `true`
- key logs:
  - `utils:kick admin=Bot_adminbot target=Bot_targetbot reason=repeated base griefing`
  - `Kicked Bot_targetbot. Reason: repeated base griefing`
  - `Bot_targetbot was kicked by Bot_adminbot. Reason: repeated base griefing`

#### `+ban Bot_targetbot 10m spawn camping again` by `adminbot`
- success: `true`
- key logs:
  - `utils:ban admin=Bot_adminbot target=Bot_targetbot duration=10 minutes reason=spawn camping again`
  - `Banned Bot_targetbot for 10 minutes. Reason: spawn camping again`
  - `Bot_targetbot was banned by Bot_adminbot for 10 minutes. Reason: spawn camping again`

### Invalid-input and offline-target paths

#### `+ban Bot_targetbot nonsense` by `adminbot`
- success: `false`
- key log:
  - `Invalid duration. Use perm/permanent or a value like 10m, 12h, 7d, or 2w.`

#### `+kick Bot_exadmin offline-check` by `adminbot`
- success: `false`
- target resolution context: `Bot_exadmin` exists in Takaro but was not online on the current Paper server
- key logs:
  - `➡️ POST /player/search`
  - `➡️ POST /gameserver/player/search`
  - `That player is not currently online.`

#### `+givecurrency Bot_exadmin 1` by `adminbot`
- success: `false`
- target resolution context: `Bot_exadmin` exists in Takaro but was not online on the current Paper server
- key logs:
  - `➡️ POST /gameserver/player/search`
  - `That player is not currently online.`

These two checks specifically cover the resolved-but-offline target handling that previously hung or produced misleading success logs.

## Outcome

This turn's real Paper verification now covers:

- every public command (`/serverinfo`, `/online`, `/discord`, `/rules`)
- every admin command (`/givecurrency`, `/kick`, `/ban`)
- a real permission-denied path
- a real invalid-input path (`/ban` invalid duration)
- broadcast-enabled happy paths
- resolved-but-offline rejection for both `/kick` and `/givecurrency`

The new verification evidence matches the intended plan behavior and replaces the earlier incomplete admin-only spot checks.
