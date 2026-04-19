# Community-fund verification — 2026-04-19

## Automated checks

Ran from repo root:

- `npm run build`
- `node --check modules/community-fund/src/functions/fund-helpers.js`
- `node --check modules/community-fund/src/commands/fund-contribute/index.js`

Results:

- build: pass
- syntax checks: pass

The repo's full mock-server suite still depends on local Postgres/Redis-backed test services that were not reliably available in this shell session, so I did **not** treat the unavailable full-suite run as verification evidence. The real Paper-server checks below are the authoritative coverage for this turn.

## Real Paper-server verification

Environment:

- Paper game server: `minecraft`
- Takaro gameServerId: `c423b25e-c2af-4ea1-ab0a-a559574d1b65`
- Installed module: `test-community-fund`
- Installed moduleId: `986e05eb-7800-45ae-b2a1-2c3cf5513cf2`
- Installed versionId: `956f418f-c877-4318-b3c8-a3c7689ca36b`
- Command prefix: `+`
- Bot API port: `3103`
- Bots: `cfadmin`, `cfuser`, `cftwo`
- Permissions assigned:
  - `Bot_cfadmin`: `COMMUNITY_FUND_CONTRIBUTE`, `COMMUNITY_FUND_VIEW_HISTORY`
  - `Bot_cftwo`: `COMMUNITY_FUND_CONTRIBUTE`
  - `Bot_cfuser`: no community-fund permissions
- Config used for verification:
  - `fundThreshold: 20`
  - `minimumContribution: 10`
  - `completionMessage: The community fund reached {threshold}!`
  - `completionCommands: []`
  - `broadcastContributions: true`

## Verified scenarios

### Permission denial

#### `+fund 10` by `cfuser`
- success: `false`
- key log:
  - `You do not have permission to contribute to the community fund.`

### Invalid amount handling

#### `+fund 5` by `cfadmin`
- success: `false`
- key log:
  - `Minimum contribution is 10. You tried to contribute 5.`

#### `+fund 0` by `cfadmin`
- success: `false`
- key log:
  - `Usage: /fund <amount> — Amount must be a positive whole number.`

### Happy path contribution and status

#### `+fund 10` by `cfadmin`
- success: `true`
- key logs:
  - `POST /gameserver/.../deduct-currency 200 OK`
  - `Fund contribution: player=Bot_cfadmin, amount=10, previousTotal=0, newTotal=10, threshold=20`
  - `You contributed 10 to the community fund. Current total: 10/20 (50%).`

#### `+fundstatus` after the first contribution
- success: `true`
- key log:
  - `Fund status: total=10, threshold=20, cycle=0, percent=50`

### Threshold completion and reset

#### second `+fund 10` by `cfadmin`
- success: `true`
- key logs:
  - `Fund contribution: player=Bot_cfadmin, amount=10, previousTotal=10, newTotal=20, threshold=20`
  - `You contributed 10 to the community fund. The community fund goal has been met! A new round begins. (Round #1)`

#### `+fundstatus` after completion
- success: `true`
- key log:
  - `Fund status: total=0, threshold=20, cycle=1, percent=0`

#### `+fundhistory` after completion
- success: `true`
- key log:
  - `Fund history: cycleCount=1, hasLastCompletion=true`

### Carryover after overpaying the threshold

#### `+fund 25` by `cfadmin` on a reset fund
- success: `true`
- key logs:
  - `Fund contribution: player=Bot_cfadmin, amount=25, previousTotal=0, newTotal=25, threshold=20`
  - `You contributed 25 to the community fund. The community fund goal has been met! A new round begins. (Round #1) 5 carried over into the new round.`

#### `+fundstatus` after carryover completion
- success: `true`
- key log:
  - `Fund status: total=5, threshold=20, cycle=1, percent=25`

### Deduction-failure handling for same-player double submit

Setup:
- reset fund state
- set `Bot_cfadmin` currency to exactly `10`
- send two `+fund 10` commands concurrently from the same bot

Observed results:
- first command: success `true`
- second command: success `false`
- key failure logs:
  - repeated lock-acquisition retries (`POST /variables` conflict retries)
  - `Fund: currency deduction failed for player Bot_cfadmin (amount=10). Contribution aborted. Error: AxiosError: Request failed with status code 400`
  - `Your contribution could not be processed because your currency could not be deducted. Please try again.`

This confirms the post-lock flow now rejects the second submission cleanly after the first spend succeeds, rather than corrupting shared progress.

### Simultaneous valid deposits from different players

Setup:
- reset fund state
- set `Bot_cfadmin` currency to `10`
- set `Bot_cftwo` currency to `10`
- send `+fund 10` from both bots concurrently

Observed results:
- both commands: success `true`
- first key contribution log:
  - `Fund contribution: player=Bot_cfadmin, amount=10, previousTotal=0, newTotal=10, threshold=20`
- second key contribution log:
  - `Fund contribution: player=Bot_cftwo, amount=10, previousTotal=10, newTotal=20, threshold=20`
- second command completion log:
  - `You contributed 10 to the community fund. The community fund goal has been met! A new round begins. (Round #1)`

#### `+fundstatus` after concurrent valid deposits
- success: `true`
- key log:
  - `Fund status: total=0, threshold=20, cycle=1, percent=0`

This is the critical live-server concurrency check for this turn: both paid deposits were preserved, the second contributor saw the updated `previousTotal=10`, and the shared fund advanced exactly once into completion/reset.

## Notes on the old rollback repro

Earlier verification found a live concurrent-write interleaving where one contributor could hit a state-write conflict after deduction and trigger the rollback path. After this turn's lock-based serialization, I was **not** able to reproduce that concurrency-specific rollback on Paper, because simultaneous contributors no longer race through the shared-state write section. The rollback code remains in place as a safeguard for unexpected post-deduction persistence failures, but the previously observed concurrency-driven rollback path is no longer the normal live behavior.

## Outcome

This turn's Paper verification now covers the branch's high-risk behavior directly on the real Minecraft server:

- permission denial
- invalid amounts
- normal contribution + status
- threshold completion + reset
- carryover into the next round
- same-player double-submit deduction-failure handling
- simultaneous valid deposits from different players without losing either contribution
- history visibility after a completed round

That replaces the earlier narrow happy-path-only verification and provides live evidence for the new concurrency behavior introduced in this branch.
