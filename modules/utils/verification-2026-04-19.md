# Server-utils verification — 2026-04-19

## Automated checks

Ran from repo root:

- `npm run typecheck`
- `node --check modules/utils/src/functions/utils-helpers.js`
- `node --check modules/utils/src/commands/givecurrency/index.js`
- `node --check modules/utils/src/commands/kick/index.js`
- `node --check modules/utils/src/commands/ban/index.js`

Results:

- typecheck: pass
- syntax checks: pass

Note: the full mock-server integration suites were not rerun in this turn because the local test infrastructure was unavailable (`ECONNREFUSED` to the repo's test Redis/Postgres/Takaro stack).

## Real Paper-server verification

Environment:

- Paper game server: `minecraft`
- Takaro gameServerId: `c423b25e-c2af-4ea1-ab0a-a559574d1b65`
- Installed module: `server-utils`
- Command prefix: `+`
- Bots: `adminbot`, `targetbot`
- Admin permissions assigned to `Bot_adminbot`: `UTILS_KICK`, `UTILS_BAN`, `UTILS_GIVE_CURRENCY`

### `+givecurrency Bot_adminbot 3` by `adminbot`
- success: `true`
- key logs:
  - `utils:givecurrency admin=Bot_adminbot target=Bot_adminbot amount=3`
  - `Gave 3 currency to Bot_adminbot.`
  - `Bot_adminbot gave you 3 currency.`
  - `Bot_adminbot received 3 currency from Bot_adminbot.`

### `+givecurrency Bot_adminbot 0` by `adminbot`
- success: `false`
- key log:
  - `Usage: /givecurrency <player> <amount> — Amount must be a positive whole number.`

### `+kick Bot_targetbot repeated base griefing` by `adminbot`
- success: `true`
- key logs:
  - `utils:kick admin=Bot_adminbot target=Bot_targetbot reason=repeated base griefing`
  - `Kicked Bot_targetbot. Reason: repeated base griefing`
  - `Bot_targetbot was kicked by Bot_adminbot. Reason: repeated base griefing`

### `+ban Bot_targetbot 10m spawn camping again` by `adminbot`
- success: `true`
- key logs:
  - `utils:ban payload={"reason":"spawn camping again","expiresAt":"2026-04-19T15:19:09.978Z"}`
  - `utils:ban admin=Bot_adminbot target=Bot_targetbot duration=10 minutes reason=spawn camping again`
  - `Banned Bot_targetbot for 10 minutes. Reason: spawn camping again`
  - `Bot_targetbot was banned by Bot_adminbot for 10 minutes. Reason: spawn camping again`

## Outcome

Real Paper verification confirmed that the shipped module name is `server-utils`, Takaro-native player targeting works for `/kick`, `/ban`, and `/givecurrency`, and the admin-command reason text is rendered correctly for multi-word reasons.