# Takaro AI Module Writer

This repository is a development environment for creating and testing Takaro modules using AI.

**Takaro Docs**: https://docs.takaro.io

## Quick Start

```bash
# Copy .env.example to .env and fill in your credentials
cp .env.example .env

# Install dependencies
npm install --legacy-peer-deps

# Build TypeScript (required before shell scripts work)
npm run build

# Start services (Minecraft server, bot, and Redis for mock game server)
docker compose up -d paper bot redis

# Authenticate with the Takaro API
bash scripts/takaro-auth.sh
```

## Running Tests

```bash
# Run all automated module tests
npm test
```

Tests use the mock game server to exercise modules in a real Takaro environment. Requires `.env` with valid credentials and `TAKARO_REGISTRATION_TOKEN`.

## In-Game Verification (Mandatory)

Automated tests alone are not sufficient. Every module must also be verified with real bots on the Minecraft Paper server before it is considered done. This is a mandatory verification step — never skip it.

```bash
docker compose up -d paper bot redis
# Create a bot, trigger commands, verify execution events
# See the takaro-module-dev skill for detailed steps
```

**For verification agents**: This repo's "app" is the Minecraft server + Takaro. Use the bot service at `http://localhost:${BOT_PORT:-3101}` to exercise modules. See `references/bot-api.md` for the API. Check `.env` for the actual `BOT_PORT` value.

## Module Development

All module development work is handled by the `takaro-module-dev` skill. This skill covers research, design, implementation, testing, and debugging of Takaro modules.

Module code lives locally in `modules/` as editable files, then gets pushed to Takaro for testing via `scripts/module-push.sh`. Use `scripts/module-pull.sh` to pull existing modules down for editing.

**Note**: `scripts/module-push.sh` and `scripts/module-pull.sh` call compiled JS from `dist/`. Always run `npm run build` before using these scripts after any changes to `src/`.

### Testing Philosophy

**All module tests MUST go through the real Takaro API.** Do not introduce mock-based unit tests, source-code string replacement, or `globalThis.__mocks` patterns. Tests should:

1. Push the module to Takaro, install it on a game server, trigger cronjobs/commands/hooks via the API, and assert on real event metadata/logs.
2. For negative assertions (e.g. "no message was sent"), check logs/events from the real execution rather than mocking internals.
3. Accept that some edge cases (empty config, send failures) may only be testable via log inspection — that's fine. A real integration test that checks logs is worth more than a mocked unit test that proves nothing about the actual system.
4. Follow the pattern in `modules/afk-kick/test/afk-kick.test.ts` — real client, real mock server, real API calls.

**Why**: Mocked tests pass while the real system fails. The whole point of this test infrastructure is to catch integration issues (wrong API shapes, missing permissions, runtime errors in the Takaro function sandbox). Unit tests with mocked helpers bypass all of that.


## Module Conventions

### Versioning

**Every change to a module requires a version bump in `module.json`.** Versions must be valid semver (e.g. `1.0.0`, `1.0.1`, `2.1.0`). The value `"latest"` is not accepted by the registry.

### Module naming

Module names must match their directory name under `modules/`. Names may only contain `[a-zA-Z0-9_-]` (no spaces, no dots, no slashes). Maximum 100 characters.

For example: the module in `modules/afk-kick/` must have `"name": "afk-kick"` in its `module.json`.

> **Known limitation**: The `name` field appears literally in the Takaro UI as the module identifier (there is no separate `displayName` field today). Choose names that are readable as-is — kebab-case slugs like `afk-kick` or `mini-games` display acceptably. This is a Takaro platform constraint that may be relaxed in a future version.

### Adding a new module

1. Create `modules/<name>/module.json` with `"name": "<name>"` and `"version": "1.0.0"`.
2. Run `npm run build && npm run build:registry` to verify the registry builds cleanly.
3. Commit and push — the publish workflow updates the `registry` branch automatically.

`cleanupTestModules` discovers module names from the `modules/` directory at runtime — no manual list to update when adding a new module.

See `src/scripts/build-registry.ts` for the registry build logic.

### Safety guard for test helpers

`pushModule` and `cleanupTestModules` refuse to touch a Takaro instance whose `TAKARO_HOST` doesn't look like a test/dev environment. This prevents accidentally wiping production modules when running tests.

**If you see this error:**
```
pushModule/cleanupTestModules refused: TAKARO_HOST='<HOST>' does not match any known test/dev host pattern. ...
```

**Common fixes (try in this order):**
1. Check `TAKARO_HOST` in `.env` is correct — pointing at production (`api.takaro.io`) is the most common cause.
2. If your dev/staging host has a non-standard hostname, add a substring to `TAKARO_TEST_HOST_ALLOWLIST` (comma-separated) in `.env`.
3. Last resort, for a single throwaway run: `TAKARO_TEST_ALLOW_ANY_HOST=1 npm test`. Use only when you're certain the target is not shared production state.

**Auto-accepted hosts:** `localhost`, `127.0.0.1`, `host.docker.internal`, single-label Docker hostnames (e.g. `takaro_api`), `*.takaro.dev`, `.staging.`/`.dev.`/`.test.`/`.ci.` substrings, `.test`/`.localhost` TLDs.

**CI:** uses `localhost:13000` and passes the guard automatically.

### Test pretest blocking

`npm test` runs `build:registry` as a `pretest` step. If any module fails registry validation (bad semver, invalid name, description too long), the entire test run is blocked — including unrelated modules. To unblock: fix the validation error in the offending module, or temporarily move the module directory out of `modules/` while debugging other tests.

Workaround: bypass the pretest gate with `node --test --import=ts-node-maintained/register/esm 'modules/<name>/test/*.test.ts'`.

## Available Tools

- **`scripts/takaro-auth.sh`** — Authenticate with the Takaro API
- **`scripts/takaro-api.sh`** — Curl wrapper for Takaro API calls with auto-auth (supports `@file` for large bodies)
- **`scripts/module-push.sh`** — Push a local module to Takaro (`module-push.sh modules/<name>`)
- **`scripts/module-pull.sh`** — Pull a module from Takaro to local files (`module-pull.sh <name-or-id>`)
- **`npm run module:to-json`** — Convert local module dir to Takaro import JSON (calls compiled `dist/scripts/module-to-json.js`)
- **`npm run module:from-json`** — Convert Takaro export JSON to local module dir (calls compiled `dist/scripts/json-to-module.js`)
- **`scripts/download-plugin.sh`** — Download the Takaro Minecraft plugin
- **Bot service** (port `BOT_PORT`, default 3101) — Create and control Minecraft bots for testing
- **RCON** — `docker compose exec paper rcon-cli <command>`
