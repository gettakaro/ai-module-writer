---
name: takaro-module-dev
description: "Use this skill for ALL Takaro module development work. This includes: creating new modules, writing commands/hooks/cronjobs/functions, brainstorming game server features, testing modules in-game, debugging module execution, or discussing module architecture. Trigger whenever the user mentions: Takaro modules, game server commands, player events, cronjobs, hooks, module testing, game automation, or wants to add features to a game server. Also trigger when the user wants to brainstorm ideas for game server functionality, even if they haven't mentioned 'module' explicitly."
---

# Takaro Module Development

You are working in a repository designed for autonomous Takaro module development and testing. Your job is to help design, implement, and thoroughly test Takaro modules using the tools in this repo.

Takaro is a game server management platform. Modules are how features get added to game servers. Since Takaro evolves rapidly, you must always fetch the latest documentation at runtime rather than relying on prior knowledge.

## Environment

This repo provides:
- **Minecraft Paper server** — A real game server for testing (`docker compose up -d paper`)
- **Bot service** — HTTP API to create and control Minecraft players (`docker compose up -d bot`). See `references/bot-api.md` for the full API.
- **Auth scripts** — `scripts/takaro-auth.sh` and `scripts/takaro-api.sh` for Takaro API access via curl
- **Module scripts** — `scripts/module-push.sh` and `scripts/module-pull.sh` for syncing modules between local files and Takaro
- **Local modules** — `modules/` directory where module code lives as editable files

### Starting Services

```bash
docker compose up -d paper bot
```

Wait for Paper to finish starting before testing (check `docker compose logs paper`).

### Takaro API Access

All Takaro API calls go through the curl wrapper script:

```bash
# Authenticate (do this first, or the api script does it automatically)
bash scripts/takaro-auth.sh

# Make API calls
bash scripts/takaro-api.sh GET /gameserver/search '{}'
bash scripts/takaro-api.sh POST /module '{...}'
bash scripts/takaro-api.sh GET /openapi.json
```

The script handles auth headers, domain selection, token refresh on 401, and JSON pretty-printing. Always use this script — never construct raw curl commands to Takaro.

## Phase 1: Research

Before writing any module, research the current state of Takaro. The platform evolves fast — never assume you know the API surface or available features.

### What to fetch

1. **Module documentation** — Fetch from docs.takaro.io to understand module architecture, available event types, component structure, and the helpers API (`@takaro/helpers`).

2. **Existing modules** — Browse https://modules.takaro.io to see what already exists. Study modules similar to what you're building for patterns, code structure, and inspiration. This is the most important reference for understanding how real modules are written.

3. **OpenAPI spec** — Fetch via `bash scripts/takaro-api.sh GET /openapi.json` to understand the exact current API surface. This tells you what endpoints exist, what parameters they take, and what they return. This is critical because modules use the Takaro API client internally.

4. **API client docs** — If you need to understand what methods are available on the `takaro` client object (used inside module code), check the API client documentation on docs.takaro.io.

### Research tips

- When studying existing modules, pay attention to how they structure functions for code reuse
- Look at how similar modules handle edge cases and error messages
- Check what events are available for hooks — the module docs list supported event types
- The OpenAPI spec is the source of truth for API endpoints and their parameters

## Phase 2: Design (Human-in-the-Loop)

Before coding, collaborate with the user to design the module. Your role here is to be a thoughtful collaborator who catches gaps and thinks through the player experience.

### Brainstorming checklist

- **Problem definition** — What problem does this module solve? Who benefits?
- **Component planning** — Which components are needed?
  - Commands: What will players type? What arguments do they need?
  - Hooks: What game events should trigger behavior?
  - Cronjobs: What needs to happen on a schedule?
  - Functions: What code is shared across components?
- **Permissions** — Which commands should be permission-gated? Define permissions for each gated command.
- **Player UX** — Think from the player's perspective:
  - Are command names intuitive? Would a player guess them?
  - Are error messages helpful? If a player types wrong arguments, do they get guidance?
  - Is the output clear and concise? Players are in-game, not reading docs.
- **Gap analysis** — Actively look for missing pieces:
  - "You have a /buy command but no way for players to check their balance"
  - "This hook fires on player death but doesn't handle the case where the killer is also dead"
  - "Players might want to configure X — should this be a module setting?"
- **Edge cases** — Think through what could go wrong:
  - What if the player is offline? Dead? In a different world?
  - What if the command is run twice quickly?
  - What if the API call fails?
  - What if there's no data yet (first run)?
- **Acceptance criteria** — Define what "working" means for each component. These become your test cases.

### Output

The design phase should produce a clear plan with:
- Module name and description
- List of components with their purpose
- Command signatures with arguments
- Hook event types and expected behavior
- Acceptance criteria for testing

## Phase 3: Implementation

### Module code structure

Every module component (command, hook, cronjob) must follow this pattern:

```javascript
import { data, takaro } from '@takaro/helpers';

async function main() {
  const { gameServerId, player, module: mod } = data;

  // Your code here
}

await main();
```

The `data` object contents vary by component type:
- **Commands**: `{ gameServerId, player, pog, arguments, module, chatMessage }`
- **Hooks**: `{ gameServerId, eventData, player, module }`
- **Cronjobs**: `{ gameServerId, module }`

### Key patterns

- **Functions for shared code** — If multiple components need the same logic, put it in a function. This is critical for DRY code. The function code is available to all components in the module.
- **Use `TakaroUserError`** for player-facing errors — these show a clean message to the player instead of a stack trace.
- **Use `Promise.all`** for parallel API calls — don't make sequential calls when they're independent.
- **Always `await` API calls** — missing awaits is a common silent failure.

### Permissions

Modules can define permissions that admins assign to roles. Permissions are NOT automatically enforced — you must check them in your command/hook code.

**Defining permissions** — Add a `permissions` array directly in `module.json`:
```json
{
  "name": "my-module",
  "permissions": [
    {
      "permission": "MY_MODULE_DO_THING",
      "friendlyName": "Do the Thing",
      "description": "Allows a player to do the thing",
      "canHaveCount": false
    }
  ]
}
```

**Enforcing permissions in code** — Use `checkPermission` from `@takaro/helpers`:
```javascript
import { data, TakaroUserError, checkPermission } from '@takaro/helpers';

async function main() {
  const { pog } = data;
  if (!checkPermission(pog, 'MY_MODULE_DO_THING')) {
    throw new TakaroUserError('You do not have permission to do this.');
  }
  // ... rest of command
}
```

**Important**: `checkPermission` returns truthy if the player's role has the permission, falsy otherwise. When `canHaveCount: true`, the return value has a `.count` property for numeric permissions (e.g., "max 5 teleports").

### Local module file structure

All module code lives locally in the `modules/` directory. Each module is a folder:

```
modules/
  my-module/
    module.json              # THE ONE FILE — all metadata (name, config, permissions, commands, hooks, cronJobs, functions)
    src/                     # Source code lives under src/
      commands/
        command-name/
          index.js           # Command code (JavaScript, executed server-side by Takaro)
      hooks/
        hook-name/
          index.js           # Hook code
      cronjobs/
        cronjob-name/
          index.js           # Cronjob code
      functions/
        shared-util.js       # Shared function code (filename = function name)
    test/                    # Automated tests (TypeScript)
      my-command.test.ts     # Tests for commands
      my-hook.test.ts        # Tests for hooks
```

All metadata — config schema, permissions, command definitions, hook definitions, cronjob definitions, and function references — lives in a single `module.json` file. There are no more `config.json`, `permissions.json`, `command.json`, `hook.json`, or `cronjob.json` files.

**Example `module.json`:**

```json
{
  "name": "my-module",
  "description": "Does something useful",
  "version": "latest",
  "supportedGames": ["all"],

  "config": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "cooldown": { "type": "number", "default": 60, "description": "Cooldown in seconds" }
    },
    "required": [],
    "additionalProperties": false
  },

  "uiSchema": {},

  "permissions": [
    {
      "permission": "MY_MODULE_ACTION",
      "friendlyName": "Do the Action",
      "description": "Allows a player to do the action",
      "canHaveCount": false
    }
  ],

  "commands": {
    "my-command": {
      "trigger": "mycommand",
      "description": "Do the thing",
      "helpText": "Usage: /mycommand",
      "function": "src/commands/my-command/index.js",
      "arguments": []
    }
  },

  "hooks": {
    "on-event": {
      "eventType": "player-connected",
      "description": "React to player joining",
      "function": "src/hooks/on-event/index.js"
    }
  },

  "cronJobs": {
    "hourly-check": {
      "temporalValue": "0 * * * *",
      "description": "Run every hour",
      "function": "src/cronjobs/hourly-check/index.js"
    }
  },

  "functions": {
    "helpers": {
      "function": "src/functions/helpers.js"
    }
  }
}
```

Module source code (`index.js` files inside `src/`) stays JavaScript because Takaro executes it server-side. All test helpers and test files are TypeScript.

### Development workflow

Write code locally, push to Takaro, install, test. This is the core loop:

1. **Write code** — Edit files in `modules/<name>/` using normal file editing
2. **Push to Takaro** — `bash scripts/module-push.sh modules/<name>`
3. **Install on game server** — Use the Takaro API to install the module
4. **Test in-game** — Use bots to trigger and verify behavior
5. **Debug & iterate** — Fix code locally, push again, re-test

To pull an existing module from Takaro for local editing:
```bash
bash scripts/module-pull.sh "module-name"       # By name
bash scripts/module-pull.sh <module-uuid>        # By ID
```

### Versioning

Takaro modules support semantic versioning. During development, work on the "latest" version (set `"version": "latest"` in module.json). Tag a version when the module is stable and tested.

## Phase 4: Testing

Testing is the most important phase. A module is not done until every acceptance criterion passes in a real game environment. Read `references/testing-methodology.md` for the complete testing playbook.

### Automated tests (preferred)

The repo has a TypeScript test infrastructure that exercises modules against a real Takaro environment using the mock game server. This is the preferred testing approach for reliability and repeatability.

```bash
# Ensure Redis is running (required by mock game server)
docker compose up -d redis

# Build TypeScript (required before running tests)
npm run build

# Run all module tests
npm test
```

Each module has a `test/` directory with `.test.ts` files. Tests:
1. Clean up orphaned test modules and game servers from previous runs
2. Create an authenticated API client and start a mock game server
3. Push the module to Takaro and install it
4. Trigger commands/hooks via the API or console commands
5. Poll for `command-executed` / `hook-executed` events
6. Assert success, then clean up (uninstall module, delete module, delete game server, stop mock server)

Test helpers live in `test/helpers/`:
- `client.ts` — Authenticated Takaro API client (singleton)
- `mock-server.ts` — Start/stop mock game server with connected players
- `events.ts` — Poll event search API with timeout
- `modules.ts` — Push/install/uninstall/delete modules, cleanup orphans (`cleanupTestModules`, `cleanupTestGameServers`)

### Manual test loop (for debugging or ad-hoc verification)

1. **Ensure services are running**: `docker compose up -d paper bot`
2. **Create a test bot**: `curl -X POST http://localhost:${BOT_PORT:-3101}/bots -H 'Content-Type: application/json' -d '{"name":"tester"}'`
3. **Wait for connection**: `sleep 5 && curl http://localhost:${BOT_PORT:-3101}/status`
4. **Trigger the module** (varies by component type):
   - Command: Send via bot chat
   - Hook: Trigger the game event (via bot action or RCON)
   - Cronjob: Trigger via API
5. **Wait for execution**: `sleep 3`
6. **Check execution event**: Fetch from Takaro event API
7. **Verify side effects**: Check for expected outcomes (messages, variable changes, etc.)
8. **Clean up**: Destroy test bots when done

### What to test

- **Happy path** for every component
- **Wrong/missing arguments** — do players get helpful errors?
- **Edge cases** specific to the module
- **Multi-player scenarios** where relevant
- **UX check** — are messages clear and useful to a player?

### Permission testing

Module permissions are registered when the module is imported via `pushModule`. However, test players only have the default "Player" role which does NOT include custom module permissions. You MUST set up permissions in your tests:

1. **Create a role with the required permissions** — after pushModule + installModule
2. **Assign the role to a specific test player** — only that player can use gated commands
3. **Test BOTH paths** — permitted player succeeds, unpermitted player is denied
4. **Clean up the role** — in after() hook

Use the `assignPermissions` and `cleanupRole` helpers from `test/helpers/modules.ts`:

```typescript
// In before():
roleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['MY_PERMISSION']);

// Test: permitted player (ctx.players[0]) succeeds
// Test: unpermitted player (ctx.players[1]) gets denied

// In after():
await cleanupRole(client, roleId);
```

**Common mistake**: Forgetting that test players don't have custom permissions. If your command uses `checkPermission` and tests fail with "do not have permission", you need to set up the role/permission in your test setup.

### Correctness over speed

Take as long as needed. A thoroughly tested module that takes hours is far more valuable than a quick module with untested edge cases. When in doubt, add another test case.

## Phase 5: In-Game Verification (Mandatory)

Automated tests use a mock game server — they validate logic but don't prove the module works in a real game. In-game verification uses the actual Minecraft Paper server with bot players and is **required before a module is considered done**. This is the whole point of having the Minecraft setup in this repo.

This phase applies during `/verify`, manual review, or any final check. Never skip it with "N/A — no app to exercise." The app IS the Minecraft server + Takaro, and the bot service IS how you exercise it.

### Steps

1. **Start services** (if not already running):
   ```bash
   docker compose up -d paper bot redis
   # Wait for Paper to be ready
   docker compose logs --tail=5 paper  # look for "Done" message
   ```

2. **Push and install the module on the real game server**:
   ```bash
   npm run build
   bash scripts/module-push.sh modules/<name>
   ```
   Then install the module on the Paper game server via the Takaro API. The Paper server must be registered in Takaro — check with `bash scripts/takaro-api.sh POST /gameserver/search '{}'`.

3. **Create a bot and run every command**:
   ```bash
   # Create bot
   curl -X POST http://localhost:${BOT_PORT:-3101}/bots -H 'Content-Type: application/json' -d '{"name":"tester"}'
   sleep 5

   # Get the command prefix for this game server
   bash scripts/takaro-api.sh GET /settings?keys=commandPrefix&gameServerId=<id>

   # Run each command via bot chat
   curl -X POST http://localhost:${BOT_PORT:-3101}/bot/tester/chat -H 'Content-Type: application/json' \
     -d '{"message":"/fund 50"}'
   sleep 3

   # Check the execution event
   bash scripts/takaro-api.sh POST /event/search '{"filters":{"eventName":["command-executed"]},"sortBy":"createdAt","sortDirection":"desc","limit":3}'
   ```

4. **Verify every command works**: Check each execution event for `success: true` and review the logs for expected output. Test error paths too (wrong arguments, missing permissions).

5. **Clean up**:
   ```bash
   curl -X DELETE http://localhost:${BOT_PORT:-3101}/bots/tester
   ```

### What counts as verified

- Every command in the module was triggered by a bot in the real Minecraft server
- Every command's execution event shows `success: true`
- Error paths were tested (wrong args, denied permissions) and show proper error messages
- The module can be uninstalled and reinstalled cleanly

### When exerciser/verify agents encounter this repo

If you are a verification agent (cata-exerciser or similar): this repo's "app" is the Minecraft Paper server + Takaro platform. To exercise a module, use the bot service at `http://localhost:${BOT_PORT:-3101}` (check `.env` for `BOT_PORT`) to create bots and trigger commands. Check `references/bot-api.md` for the full bot HTTP API. Do NOT skip with "no app to exercise."

## Phase 6: Debugging

When something doesn't work, check `references/debugging-patterns.md` for the debugging playbook.

### Quick reference

| Symptom | Likely Cause |
|---------|-------------|
| Empty logs + success:true | Missing `import { data, takaro } from '@takaro/helpers'` or wrong API method names |
| Empty logs + success:false | Syntax error or runtime crash |
| Populated logs + error | API call failed — check the error message |
| No execution event at all | Module not installed, wrong command prefix, or wrong game server |

### Debugging strategy

1. Add `console.log` statements throughout the code
2. Re-trigger the module
3. Fetch the execution event and read the logs
4. Fix the issue, update the code, re-test
5. Repeat until all tests pass

Always check the command prefix — it's configured per game server and might not be what you expect. Fetch it via the settings API.

## Phase 7: Screenshot and Description Handoff

When the module is intended for publication, sharing with the community, or a PR into the community module viewer, completion includes a screenshot-description handoff after automated and in-game verification pass.

Use `takaro-module-screenshots` for this follow-up. It captures Takaro dashboard screenshots only and drafts or updates the Markdown module description.

### Handoff contents

Include enough concrete context that the screenshot pass can reproduce the verified dashboard evidence without rediscovering the module:

- Module path, module name, and current `modules/<name>/module.json` status
- Whether the description should be edited in `module.json` or only drafted in the final answer
- Game server ID/name used during verification and the dashboard URL when known
- Installed module ID/version ID when known
- Exact config values used during verification
- Command prefix, bot names, and command/chat messages that were run
- Hook, cronjob, or event filters that produced verified evidence
- Verification commands/tests already run and their result
- Suggested screenshot purposes, such as `config`, command trigger names, `chat`, or `events`

Do not require this handoff for throwaway test modules unless the user asks for publishable documentation.
