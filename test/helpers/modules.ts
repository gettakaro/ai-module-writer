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
 * Push a local module to Takaro via the import API.
 * If a module with the same name already exists, backs it up, replaces it, and restores it on import failure.
 * Returns the imported module (found by name from module.json).
 */
export async function pushModule(
  client: Client,
  moduleDir: string,
): Promise<ModuleOutputDTO> {
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

    // Keep a backup of the current module so a failed replacement import can be rolled back.
    const existing = await client.module.moduleControllerSearch({
      filters: { name: [name] },
    });
    const existingModule = existing.data.data.find((m) => m.name === name);
    const existingBackup = existingModule
      ? (await client.module.moduleControllerExport(existingModule.id, {})).data.data
      : null;

    if (existingModule) {
      await client.module.moduleControllerRemove(existingModule.id);
    }

    // Import via API (returns void — second search below retrieves the module data)
    try {
      await client.module.moduleControllerImport(moduleJson);
    } catch (err) {
      if (existingBackup) {
        try {
          await client.module.moduleControllerImport(existingBackup);
        } catch (restoreErr) {
          throw new Error(
            `Import of '${name}' failed and restoring the previous module also failed. Import error: ${err}. Restore error: ${restoreErr}`,
          );
        }

        throw new Error(
          `Import of '${name}' failed, but the previous module was restored. Cause: ${err}`,
        );
      }
      throw err;
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
 * Delete all modules whose names start with 'test-' (safety net cleanup).
 * Always re-fetches page 0 until no results remain, to avoid pagination
 * shift bugs when items are deleted from the current page.
 * Uses search: { name: ['test-'] } for a partial-match search.
 * If the search fails (e.g. due to server-side errors on corrupt data), the
 * cleanup is skipped — this is non-fatal since module names are unique and
 * each test's before() also deletes specific modules by name before importing.
 */
export async function cleanupTestModules(client: Client): Promise<void> {
  const limit = 100;
  const MAX_ITERATIONS = 50;
  let iterations = 0;
  while (true) {
    if (++iterations > MAX_ITERATIONS) {
      throw new Error(`cleanupTestModules exceeded ${MAX_ITERATIONS} iterations — possible infinite loop`);
    }
    let result;
    try {
      result = await client.module.moduleControllerSearch({
        limit,
        page: 0,
        search: { name: ['test-'] },
      });
    } catch (err) {
      // Non-fatal: cleanup search failed (e.g. server-side error on corrupt module data).
      // The test's pushModule will handle idempotent cleanup for the specific module being tested.
      console.error('cleanupTestModules: search failed (non-fatal, skipping cleanup):', err);
      return;
    }
    const mods = result.data.data.filter((m) => m.name.startsWith('test-'));
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
      try {
        await client.gameserver.gameServerControllerRemove(gs.id);
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) {
          console.error(`cleanupTestGameServers: server '${gs.id}' already disappeared during cleanup, skipping`);
          continue;
        }
        throw err;
      }
    }
  }
}
