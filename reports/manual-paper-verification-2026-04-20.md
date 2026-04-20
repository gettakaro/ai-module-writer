# Manual Paper + bot verification — 2026-04-20

Environment:
- Game server: `95473107-f960-4cd0-a15f-ede2e089e64a` (`minecraft`)
- Bot service: `http://localhost:3104`
- Command prefix: `+`
- Bots: `Bot_BotAdmin`, `Bot_BotPlayer`

Modules installed on the real Paper server:
- `casino`
- `test-vote-restart`

Real-server checks executed:

## Casino
- `+casino` as `Bot_BotAdmin`
  - Success: yes
  - Verified aliases appear in live help output: `roulette (/bet)`, `blackjack (/bj)`
- `+roulette 5 red` as `Bot_BotPlayer`
  - Success: yes
  - Verified live result wording included `Spun ...`
- `+blackjack 5` as `Bot_BotPlayer`
  - Success: yes
  - Verified alias command dealt a hand and showed dealer up-card
- `+blackjack stand` as `Bot_BotPlayer`
  - Success: yes
  - Verified dealer reveal output included `Dealer:` on Paper
- `+race 5` as `Bot_BotPlayer`
  - Success: yes
  - Verified user-facing timing text included `Draw in about ...`
- `+casinoban Bot_BotPlayer 1` as `Bot_BotAdmin`
  - Success: yes
  - Verified cleanup note on Paper: `1 race entry was removed and 5 coin refunded`
- `+casinounban Bot_BotPlayer` as `Bot_BotAdmin`
  - Success: yes
  - Verified unban confirmation message on Paper
- `+flip 1 heads` as `Bot_BotPlayer` after unban
  - Success: yes
  - Confirms effective casino access is restored on the real server after `/casinounban`

## Vote restart
- `+voterestart` as `Bot_BotAdmin`
  - Success: yes
  - Verified start log on real server: `vote started by Bot_BotAdmin, eligible=2, threshold=2`
- `+voteyes` as `Bot_BotPlayer`
  - Success: yes
  - Verified pass log on real server: `Vote passed! effectiveVotes=2, threshold=2`
- Triggered real cronjob `check-vote`
  - Success: yes
  - Verified real-server restart path log: `check-vote: restart command executed successfully`

Evidence:
- Raw captured event/log output: `.tmp/manual-verify-results.json`
