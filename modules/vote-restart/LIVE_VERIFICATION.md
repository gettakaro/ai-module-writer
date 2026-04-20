# Live Paper/Bot Verification

Date: 2026-04-20

## Environment
- Paper game server: `nca-ai-paper`
- Game server ID: `eaf1086a-a81d-41c4-b3f0-afa6a60ddda9`
- Module ID used for verification: `e84fbc4f-6cbc-4c4b-ad6e-e5c78f85647f`
- Module version ID: `39dcc4bc-94bf-49a2-a669-1b481c854a1c`
- Cronjob ID: `c96c5b47-59b8-45b0-86ed-4028ba61ef3f`
- Bot name: `votebot`
- Command prefix: `+`

Raw capture: `modules/vote-restart/LIVE_VERIFICATION.json`

## Steps run
1. `docker compose up -d paper bot redis`
2. Waited for Paper startup and Takaro plugin identification.
3. Pushed `modules/vote-restart` and installed it on the real Paper server with:
   - `passThreshold=100`
   - `minimumPlayers=1`
   - `restartDelay=300`
   - a disabled automatic cron schedule (`0 0 1 1 *`) so the cron path could be triggered manually.
4. Created bot `votebot` through the bot HTTP API.
5. Assigned the module's `VOTE_RESTART_INITIATE` permission to the bot player.
6. Ran `+votestatus`, `+voterestart`, manually triggered the `check-vote` cronjob, then ran `+votestatus` again.
7. Inspected Takaro `command-executed`, `cronjob-executed`, and `chat-message` events.

## Observed results

### 1. No-active-vote status
- Command event: `09d8445f-a2ed-4b38-9922-ed36d00c5f62`
- Result: success
- Whisper received by bot: `[Vote Restart] No active restart vote.`

### 2. Start vote on the live Paper server
- Command event: `16ac5e77-18c1-476f-b3ea-602f4c7698bd`
- Result: success
- Broadcast observed in chat:
  - `[Vote Restart] Bot_votebot started a restart vote! /voteyes to agree. (1/1, 120s remaining)`
- Runtime logs confirmed the changed helper path executed against the live server:
  - `POST /gameserver/player/search`
  - `vote-restart: vote started by Bot_votebot, eligible=1, threshold=1, initiatorImmune=false`

### 3. Manual cron verification of vote evaluation
- Cron event: `cf0c952c-4c57-48cb-91fc-a6845b2244ff`
- Result: success
- Broadcast observed in chat:
  - `[Vote Restart] Vote passed! (1/1) Server will restart in 300s.`
- Runtime logs confirmed the live cronjob also exercised the player-counting helper:
  - `POST /gameserver/player/search`
  - `check-vote: Vote passed! effectiveVotes=1, threshold=1, status changed to passed`

### 4. Passed-vote status after cron execution
- Command event: `839fa1ec-bfd8-4ee5-98d8-9105ce7c21dc`
- Result: success
- Whisper received by bot:
  - `[Vote Restart] Vote passed! Server restarting in 295s.`

## Notes
- This live run verifies the changed `vote-restart` runtime path end-to-end on the real Paper server with a real bot.
- The pagination-specific `>100` online-player path is still validated by the automated integration test; the Paper verification here confirms the same helper continues to work in live command and cronjob execution.
