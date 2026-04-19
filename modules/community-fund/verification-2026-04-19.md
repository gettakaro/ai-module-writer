# Community-fund verification — 2026-04-19

## Automated checks

Ran from repo root:

- `npm run typecheck`
- `node --check modules/community-fund/src/commands/fund-contribute/index.js`

Results:

- typecheck: pass
- syntax check: pass

Note: the full mock-server integration suite was not rerun in this turn because the local test infrastructure was unavailable (`ECONNREFUSED` to the repo's test Redis/Postgres/Takaro stack).

## Real Paper-server verification

Environment:

- Paper game server: `minecraft`
- Takaro gameServerId: `c423b25e-c2af-4ea1-ab0a-a559574d1b65`
- Installed module: `test-community-fund`
- Command prefix: `+`
- Bot: `adminbot`
- Admin permissions assigned to `Bot_adminbot`: `COMMUNITY_FUND_CONTRIBUTE`
- Module config:
  - `fundThreshold: 50`
  - `minimumContribution: 10`
  - `completionMessage: The community fund reached {threshold}!`
  - `broadcastContributions: true`

### `+fund 10` by `adminbot`
- success: `true`
- key logs:
  - `POST /gameserver/.../deduct-currency 200 OK`
  - `Fund contribution: player=Bot_adminbot, amount=10, previousTotal=10, newTotal=20, threshold=50`
  - `PUT /variables/... 200 OK`

## Outcome

Real Paper verification confirmed that the command deducts currency before advancing community-fund progress and still succeeds normally on the happy path against the live Paper server integration.