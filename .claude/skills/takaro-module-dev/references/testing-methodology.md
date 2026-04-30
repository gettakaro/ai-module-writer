# Testing Methodology

This document describes both automated and manual testing approaches for Takaro modules.

## Automated Tests (Preferred)

Tests run TypeScript test files directly via `ts-node-maintained` (no compilation step needed for tests). The test runner is Node's built-in test runner (`node --test`).

All tests interact with a real Takaro environment using the API credentials in `.env`. Each test suite:
1. Cleans up orphaned test modules and game servers from previous runs
2. Creates a fresh mock game server with a unique `identityToken` (isolated from other test runs)
3. Pushes the module under test to Takaro
4. Installs the module on the mock game server
5. Exercises the module via the Takaro API or mock server console commands
6. Polls for execution events to verify success
7. Cleans up completely (uninstall module, delete module, delete game server, stop mock server)

### Prerequisites

- `.env` file with valid Takaro credentials (see `.env.example`)
- Required env vars: `TAKARO_HOST`, `TAKARO_USERNAME`, `TAKARO_PASSWORD`, `TAKARO_DOMAIN_ID`, `TAKARO_REGISTRATION_TOKEN`, `TAKARO_WS_URL`
- Redis running: `docker compose up -d redis`
- Compiled scripts: `npm run build`

### Running Tests

```bash
# Run all module tests (builds automatically via pretest hook)
npm test

# Run tests for a specific module
node --test-concurrency 1 --import=ts-node-maintained/register/esm --test 'modules/hello-world/test/*.test.ts'

# Run with verbose mock server logging (suppressed by default)
LOGGING_LEVEL=info npm test
```

Tests run with `--test-concurrency 1` to avoid race conditions in the shared Takaro domain. Mock server logs are suppressed via `LOGGING_LEVEL=warn` in the test script — override with `LOGGING_LEVEL=info` or `LOGGING_LEVEL=debug` when debugging.

### Test Helpers

All helpers live in `test/helpers/`.

#### `client.ts` — Authenticated API Client

```typescript
import { createClient } from '../../../test/helpers/client.js';
const client = await createClient();
```

Creates a `Client` from `@takaro/apiclient`, authenticates with username/password from `.env`, and sets the domain header. The client is cached as a singleton for the test process lifetime.

#### `mock-server.ts` — Mock Game Server

```typescript
import { startMockServer, stopMockServer, MockServerContext } from '../../../test/helpers/mock-server.js';

const ctx: MockServerContext = await startMockServer(client);
// ctx.server — the mock GameServer instance
// ctx.gameServer — the GameServerOutputDTO from Takaro API
// ctx.players — PlayerOnGameserverOutputDTO[] (online players)
// ctx.identityToken — unique token (test-<uuid>), also the game server's name in Takaro

// Always pass client + gameServerId to delete the game server record
await stopMockServer(ctx.server, client, ctx.gameServer.id);
```

Each call to `startMockServer` creates a new mock server with a unique `test-<uuid>` identity token. The server connects 3 players and waits for them to appear in the Takaro API before returning.

**Important**: Takaro names the game server after the `identityToken` (e.g., `test-<uuid>`), not the `name` field in the mock server config. This is relevant for cleanup — see the orphan cleanup section below.

#### `events.ts` — Event Polling

```typescript
import { waitForEvent } from '../../../test/helpers/events.js';
import { EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';

const event = await waitForEvent(client, {
  eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
  gameserverId: ctx.gameServer.id,
  after: before,       // only events created after this Date
  timeout: 30000,      // optional, default 30s
  pollInterval: 1000,  // optional, default 1s
});
```

Polls `/event/search` with timestamp filtering. Throws if no matching event arrives within the timeout.

#### `modules.ts` — Module Lifecycle

```typescript
import {
  pushModule,
  installModule,
  uninstallModule,
  deleteModule,
  getCommandPrefix,
  cleanupTestModules,
  cleanupTestGameServers,
} from '../../../test/helpers/modules.js';

// Push module directory to Takaro (search-delete-import pattern)
const mod = await pushModule(client, '/path/to/module/dir');

// Install on a game server
await installModule(client, mod.latestVersion.id, gameServerId);

// Get the command prefix (e.g., '/')
const prefix = await getCommandPrefix(client, gameServerId);

// Cleanup
await uninstallModule(client, moduleId, gameServerId);
await deleteModule(client, moduleId);

// Safety net: delete orphaned modules (matching modules/ directory listing) and game servers
await cleanupTestModules(client);
await cleanupTestGameServers(client);
```

### Orphan Cleanup

When tests crash before `after()` runs, mock game servers and test modules are left behind in Takaro. Both cleanup functions should be called in `before()` hooks:

- `cleanupTestModules(client)` — deletes modules whose names match a directory under `modules/`
- `cleanupTestGameServers(client)` — deletes game servers with names starting with `test-`

Module names must match their directory name (e.g., for `modules/hello-world/`, set `"name": "hello-world"` in module.json — this is enforced by both the test cleanup helper and the registry build).

### Writing Tests for a New Module

1. Create `modules/<name>/test/<component>.test.ts`
2. Follow the `before`/`after` pattern:

```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '../../../test/helpers/client.js';
import { startMockServer, stopMockServer } from '../../../test/helpers/mock-server.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import {
  pushModule, installModule, uninstallModule, deleteModule,
  cleanupTestModules, cleanupTestGameServers,
} from '../../../test/helpers/modules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.resolve(__dirname, '..');

describe('my-module: my-command', () => {
  let client, ctx, moduleId, versionId;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);
    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    await installModule(client, versionId, ctx.gameServer.id);
  });

  after(async () => {
    try { await uninstallModule(client, moduleId, ctx.gameServer.id); } catch (err) {
      console.error('Cleanup: failed to uninstall module:', err);
    }
    try { await deleteModule(client, moduleId); } catch (err) {
      console.error('Cleanup: failed to delete module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('should do the thing', async () => {
    const before = new Date();
    // ... trigger the module ...
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
    });
    assert.equal((event.meta as any)?.result?.success, true);
  });
});
```

### Isolation Strategy

Each test suite gets its own mock game server with a unique `identityToken`. This means:
- Events are naturally scoped to the specific game server ID
- Multiple test suites can run sequentially without interfering
- The `after` timestamp filter (`greaterThan.createdAt`) further isolates events within a test case

## Manual Testing (for debugging or ad-hoc verification)

### Pre-Test Checklist

1. **Services running**: `docker compose up -d paper bot`
2. **Paper server ready**: Check `docker compose logs --tail=5 paper` — look for "Done" message
3. **Bot service healthy**: `curl http://localhost:${BOT_PORT:-3101}/status`
4. **Module installed**: Verify via Takaro API
5. **Command prefix known**: Fetch from settings API — never assume

### Testing Commands

```bash
# 1. Create a bot
curl -X POST http://localhost:${BOT_PORT:-3101}/bots \
  -H 'Content-Type: application/json' \
  -d '{"name":"tester"}'

# 2. Wait for connection
sleep 5
curl http://localhost:${BOT_PORT:-3101}/status

# 3. Send the command (use the correct prefix!)
curl -X POST http://localhost:${BOT_PORT:-3101}/bot/tester/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"+commandname arg1 arg2"}'

# 4. Wait for execution
sleep 3

# 5. Check execution event
bash scripts/takaro-api.sh POST /event/search '{
  "filters": { "eventName": ["command-executed"] },
  "sortBy": "createdAt",
  "sortDirection": "desc",
  "limit": 5
}'

# 6. Clean up
curl -X DELETE http://localhost:${BOT_PORT:-3101}/bots/tester
```

### Testing Hooks

| Event | How to trigger |
|-------|---------------|
| player-connected | Create a new bot |
| player-disconnected | Destroy a bot |
| chat-message | Send chat via bot |
| entity-killed (player death) | `docker compose exec paper rcon-cli kill Bot_tester` |

### Testing Cronjobs

Trigger manually via the Takaro API:

```bash
bash scripts/takaro-api.sh POST /cronjob/{cronjobId}/trigger '{
  "gameServerId": "your-game-server-id"
}'
```

### RCON Recipes

```bash
docker compose exec paper rcon-cli list                       # List online players
docker compose exec paper rcon-cli kill Bot_tester            # Kill a bot (triggers death event)
docker compose exec paper rcon-cli op Bot_tester              # Give operator permissions
docker compose exec paper rcon-cli gamemode creative Bot_tester  # Change gamemode
docker compose exec paper rcon-cli give Bot_tester diamond 5  # Give items
```

## Thoroughness Requirements

A module is not done until ALL of these are tested:

### For every component
- Happy path works correctly
- Output/messages are clear and useful to a player

### For commands
- Missing required arguments produce helpful error message
- Wrong argument types produce helpful error message
- Running the command twice quickly causes no corruption

### For hooks
- The correct event triggers the hook
- The hook handles missing/null fields in eventData
- Multiple rapid events don't cause issues

### For the module overall
- Multi-player scenarios work (create 2+ bots if needed)
- First-run scenario (no existing data/variables) works
- Module can be uninstalled and reinstalled cleanly
