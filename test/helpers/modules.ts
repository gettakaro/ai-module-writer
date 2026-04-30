import { execFileSync, SpawnSyncReturns } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { Client, ModuleOutputDTO, SettingsControllerGetKeysEnum } from '@takaro/apiclient';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the repo root */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Path to the compiled module-to-json script */
const MODULE_TO_JSON_SCRIPT = path.join(REPO_ROOT, 'dist', 'scripts', 'module-to-json.js');

export interface InstallModuleConfig {
  userConfig?: Record<string, unknown>;
  systemConfig?: Record<string, unknown>;
}

/**
 * Safety guard: refuse to run pushModule/cleanupTestModules against hosts that look
 * like production. Accepts TAKARO_HOST values that contain a test/dev/local/staging
 * indicator, or that are explicitly allowlisted via TAKARO_TEST_HOST_ALLOWLIST
 * (comma-separated substring list).
 *
 * Override: set TAKARO_TEST_ALLOW_ANY_HOST=1 to skip this check entirely (CI only).
 */
export function assertTestSafeHost(): void {
  if (process.env.TAKARO_TEST_ALLOW_ANY_HOST === '1') return;

  const host = process.env.TAKARO_HOST ?? '';
  if (!host) return; // no host configured — let downstream calls fail naturally

  // Explicit allowlist wins
  const allowlist = (process.env.TAKARO_TEST_HOST_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.some((pattern) => host.includes(pattern))) return;

  // Safe-by-default patterns: local, dev subdomains under takaro.dev, staging, test, ci, mock
  const safePatterns = [
    'localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal',
    '.takaro.dev',  // matches api.next.takaro.dev, staging.takaro.dev, etc. — but NOT prod.dev
    '.dev.', '.test.', '.ci.', '.staging.', '.local',
    '-dev-', '-test-', '-ci-', '-staging-',
  ];
  if (safePatterns.some((p) => host.includes(p))) return;

  // Also allow single-label hostnames (no dots) — typical for internal Docker service names
  // like `takaro_api` or `api` which are dev-only internal aliases.
  // Single-label hostnames pass because they typically only resolve in Docker/internal networks.
  // If your dev environment routes bare hostnames to public IPs, set TAKARO_TEST_HOST_ALLOWLIST
  // or TAKARO_TEST_ALLOW_ANY_HOST=1 deliberately.
  try {
    const hostname = new URL(host).hostname;
    // Only allow RFC 6761 reserved TLDs (.test, .localhost) that never resolve publicly.
    // .dev is intentionally excluded — it's a real gTLD and google-prod.dev would be accepted otherwise.
    const safeTLDs = ['.test', '.localhost'];
    if (!hostname.includes('.') || safeTLDs.some((tld) => hostname.endsWith(tld))) return;
  } catch {
    // host is not a valid URL (e.g. bare hostname) — fall through to the error below
  }

  throw new Error(
    `pushModule/cleanupTestModules refused: TAKARO_HOST='${host}' does not match any known test/dev host pattern. ` +
    `This is a safety guard to prevent wiping modules on a production domain. ` +
    `To override: set TAKARO_TEST_ALLOW_ANY_HOST=1 (CI only) or add a substring to TAKARO_TEST_HOST_ALLOWLIST.`
  );
}

/**
 * Push a local module to Takaro via the import API.
 * If a module with the same name already exists, deletes it first (idempotent).
 * Returns the imported module (found by name from module.json).
 */
export async function pushModule(
  client: Client,
  moduleDir: string,
): Promise<ModuleOutputDTO> {
  assertTestSafeHost();
  const absoluteModuleDir = path.resolve(moduleDir);

  // Convert the module dir to JSON using the compiled script
  const tempFile = path.join(os.tmpdir(), `takaro-push-${Date.now()}.json`);
  try {
    try {
      execFileSync(process.execPath, [MODULE_TO_JSON_SCRIPT, absoluteModuleDir, tempFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const spawnErr = err as SpawnSyncReturns<Buffer>;
      const stderr = spawnErr.stderr?.toString().trim() ?? '';
      throw new Error(
        `module-to-json failed for '${absoluteModuleDir}'${stderr ? `:\n${stderr}` : ' (no stderr output — is dist/ built?)'}`
      );
    }

    let moduleJson: { name: string };
    try {
      moduleJson = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse module-to-json output from '${tempFile}': ${err}`);
    }
    const { name } = moduleJson;

    // Delete any existing module with this name before importing (idempotent push)
    const existing = await client.module.moduleControllerSearch({
      filters: { name: [name] },
    });
    const existingModule = existing.data.data.find((m) => m.name === name);
    if (existingModule) {
      await client.module.moduleControllerRemove(existingModule.id);
    }

    // Import via API (returns void — second search below retrieves the module data)
    // On 409 Conflict (module with same name exists from a concurrent cleanup), retry once with delete.
    try {
      await client.module.moduleControllerImport(moduleJson);
    } catch (err: any) {
      if (err?.response?.status === 409) {
        // Race: another suite's cleanup left a module with this name. Delete and retry.
        const conflict = await client.module.moduleControllerSearch({ filters: { name: [name] } });
        const conflictMod = conflict.data.data.find((m) => m.name === name);
        if (conflictMod) {
          await client.module.moduleControllerRemove(conflictMod.id);
        }
        await client.module.moduleControllerImport(moduleJson);
      } else if (existingModule) {
        throw new Error(
          `Import of '${name}' failed. Previous module version was deleted before this import failure. Cause: ${err}`,
        );
      } else {
        throw err;
      }
    }

    // Find the module by name after import (import API returns void, no module data in response)
    const searchResult = await client.module.moduleControllerSearch({
      filters: { name: [name] },
    });

    const found = searchResult.data.data.find((m) => m.name === name);
    if (!found) throw new Error(`Module '${name}' not found after import`);

    return found;
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

/**
 * Install a module version on a game server.
 */
export async function installModule(
  client: Client,
  versionId: string,
  gameServerId: string,
  config?: InstallModuleConfig,
): Promise<void> {
  await client.module.moduleInstallationsControllerInstallModule({
    versionId,
    gameServerId,
    userConfig: config?.userConfig ? JSON.stringify(config.userConfig) : undefined,
    systemConfig: config?.systemConfig ? JSON.stringify(config.systemConfig) : undefined,
  });
}

/**
 * Uninstall a module from a game server.
 */
export async function uninstallModule(
  client: Client,
  moduleId: string,
  gameServerId: string,
): Promise<void> {
  await client.module.moduleInstallationsControllerUninstallModule(moduleId, gameServerId);
}

/**
 * Delete a module entirely from Takaro.
 */
export async function deleteModule(client: Client, moduleId: string): Promise<void> {
  await client.module.moduleControllerRemove(moduleId);
}

/**
 * Get the command prefix configured for a game server.
 */
export async function getCommandPrefix(client: Client, gameServerId: string): Promise<string> {
  const result = await client.settings.settingsControllerGet(
    [SettingsControllerGetKeysEnum.CommandPrefix],
    gameServerId,
  );
  const setting = result.data.data[0];
  return setting?.value ?? '/';
}

/**
 * Discover module names from the modules/ directory at runtime.
 * This avoids maintaining a hand-maintained list — any directory added to modules/
 * is automatically included in cleanup without requiring a code change.
 */
function getKnownModuleNames(): string[] {
  const modulesDir = path.join(REPO_ROOT, 'modules');
  return fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * Delete all orphaned modules matching the known module names (safety net cleanup).
 * Module names are discovered from the modules/ directory — no manual list to maintain.
 * Always re-fetches page 0 until no results remain, to avoid pagination
 * shift bugs when items are deleted from the current page.
 * If the search fails (e.g. due to server-side errors on corrupt data), the
 * cleanup is skipped — this is non-fatal since module names are unique and
 * each test's before() also deletes specific modules by name before importing.
 */
export async function cleanupTestModules(client: Client): Promise<void> {
  assertTestSafeHost();
  const knownModuleNames = getKnownModuleNames();
  const MAX_ITERATIONS = 50;
  let iterations = 0;
  while (true) {
    if (++iterations > MAX_ITERATIONS) {
      throw new Error(`cleanupTestModules exceeded ${MAX_ITERATIONS} iterations — possible infinite loop`);
    }
    let result;
    try {
      result = await client.module.moduleControllerSearch({
        limit: 100,
        page: 0,
        filters: { name: knownModuleNames },
      });
    } catch (err) {
      // Non-fatal: cleanup search failed (e.g. server-side error on corrupt module data).
      // The test's pushModule will handle idempotent cleanup for the specific module being tested.
      console.error('cleanupTestModules: search failed (non-fatal, skipping cleanup):', err);
      return;
    }
    const mods = result.data.data.filter((m) => knownModuleNames.includes(m.name));
    if (mods.length === 0) break;
    for (const mod of mods) {
      await client.module.moduleControllerRemove(mod.id);
    }
  }
}

export interface PermissionInput {
  code: string;
  count?: number;
}

/**
 * Create a role with specific module permissions and assign it to a player.
 * Returns the role ID for cleanup.
 * Accepts either string[] (no count) or PermissionInput[] (with optional count).
 */
export async function assignPermissions(
  client: Client,
  playerId: string,
  gameServerId: string,
  permissionCodes: string[] | PermissionInput[],
): Promise<string> {
  if (permissionCodes.length === 0) throw new Error('assignPermissions: permissionCodes must not be empty');

  // Normalize to PermissionInput[] format
  const normalized: PermissionInput[] = permissionCodes.map((p) =>
    typeof p === 'string' ? { code: p } : p,
  );

  const allPerms = await client.role.roleControllerGetPermissions();
  const permInputs = normalized.map((input) => {
    const found = allPerms.data.data.find((p) => p.permission === input.code);
    if (!found) throw new Error(`Permission '${input.code}' not found`);
    const result: { permissionId: string; count?: number } = { permissionId: found.id };
    if (input.count !== undefined) result.count = input.count;
    return result;
  });
  // Role name max length is 20 chars. Include randomness to avoid collisions when tests run in parallel.
  // Format: "tr-" (3) + 5 base-36 timestamp chars + 4 base-36 random chars = 12 chars total. Well under 20.
  const role = await client.role.roleControllerCreate({
    name: `tr-${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(-4)}`,
    permissions: permInputs,
  });
  try {
    await client.player.playerControllerAssignRole(playerId, role.data.data.id, { gameServerId });
  } catch (err) {
    // Clean up the created role to avoid orphans before rethrowing
    try {
      await client.role.roleControllerRemove(role.data.data.id);
    } catch (cleanupErr) {
      console.error(`assignPermissions: failed to clean up orphaned role '${role.data.data.id}' after assignment failure:`, cleanupErr);
    }
    throw err;
  }
  return role.data.data.id;
}

/**
 * Delete a role by ID. Non-fatal — errors are logged but not thrown.
 * Accepts undefined to handle cases where before() failed before a role was created.
 */
export async function cleanupRole(client: Client, roleId: string | undefined): Promise<void> {
  if (!roleId) return;
  try {
    await client.role.roleControllerRemove(roleId);
  } catch (err) {
    console.error(`cleanupRole: failed to delete role '${roleId}':`, err);
  }
}

/**
 * Delete all game servers whose names start with 'test-' (orphan cleanup).
 * Mock servers register with identityToken as the name (e.g. 'test-<uuid>').
 * These are left behind when tests crash before after() runs.
 */
export async function cleanupTestGameServers(client: Client): Promise<void> {
  const limit = 100;
  const MAX_ITERATIONS = 50;
  let iterations = 0;
  while (true) {
    if (++iterations > MAX_ITERATIONS) {
      throw new Error(`cleanupTestGameServers exceeded ${MAX_ITERATIONS} iterations — possible infinite loop`);
    }
    const result = await client.gameserver.gameServerControllerSearch({
      limit,
      page: 0,
    });
    const servers = result.data.data.filter((gs) => gs.name.startsWith('test-'));
    if (servers.length === 0) break;
    for (const gs of servers) {
      await client.gameserver.gameServerControllerRemove(gs.id);
    }
  }
}
