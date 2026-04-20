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

interface ModuleInstallationBackup {
  gameServerId: string;
  userConfig?: Record<string, unknown>;
  systemConfig?: Record<string, unknown>;
}

interface ModuleVariableBackup {
  key: string;
  value: string;
  gameServerId?: string;
  playerId?: string;
}

interface RolePermissionBackup {
  permission: string;
  count?: number;
}

interface RoleBindingBackup {
  roleId: string;
  roleName: string;
  permissions: RolePermissionBackup[];
}

function shouldPreserveModuleVariable(key: string): boolean {
  if (key.startsWith('__debug_')) {
    return false;
  }

  return !/(^|[_-])(lock|mutex|semaphore)([_-]|$)/i.test(key);
}

async function collectAllPages<T>(
  fetchPage: (page: number, limit: number) => Promise<{ data: T[]; total?: number }>,
  { limit = 100, maxPages = 100 }: { limit?: number; maxPages?: number } = {},
): Promise<T[]> {
  const items: T[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(page, limit);
    const batch = result.data;
    items.push(...batch);

    if (batch.length === 0) break;
    if (typeof result.total === 'number' && items.length >= result.total) break;
    if (batch.length < limit && result.total === undefined) break;
  }

  return items;
}

async function collectModuleInstallations(client: Client, moduleId: string): Promise<ModuleInstallationBackup[]> {
  const installations = await collectAllPages(async (page, limit) => {
    const result = await client.module.moduleInstallationsControllerGetInstalledModules({
      filters: { moduleId: [moduleId] },
      page,
      limit,
    });

    return {
      data: result.data.data,
      total: result.data.meta?.total,
    };
  });

  return installations.map((installation) => ({
    gameServerId: installation.gameserverId,
    userConfig: installation.userConfig as Record<string, unknown> | undefined,
    systemConfig: installation.systemConfig as Record<string, unknown> | undefined,
  }));
}

async function collectModuleVariables(client: Client, moduleId: string): Promise<ModuleVariableBackup[]> {
  const variables = await collectAllPages(async (page, limit) => {
    const result = await client.variable.variableControllerSearch({
      filters: { moduleId: [moduleId] },
      page,
      limit,
    });

    return {
      data: result.data.data,
      total: result.data.meta?.total,
    };
  }, { limit: 250 });

  return variables
    .filter((variable) => shouldPreserveModuleVariable(variable.key))
    .map((variable) => ({
      key: variable.key,
      value: variable.value,
      gameServerId: typeof variable.gameServerId === 'string' && variable.gameServerId !== ''
        ? variable.gameServerId as string
        : undefined,
      playerId: typeof variable.playerId === 'string' && variable.playerId !== ''
        ? variable.playerId as string
        : undefined,
    }));
}

async function collectModuleRoleBindings(client: Client, moduleId: string): Promise<RoleBindingBackup[]> {
  const permissionsResult = await client.role.roleControllerGetPermissions();
  const modulePermissionIds = new Set(
    permissionsResult.data.data
      .filter((permission) => permission.module?.id === moduleId)
      .map((permission) => permission.id),
  );

  if (modulePermissionIds.size === 0) {
    return [];
  }

  const roles = await collectAllPages(async (page, limit) => {
    const result = await client.role.roleControllerSearch({ page, limit });
    return {
      data: result.data.data,
      total: result.data.meta?.total,
    };
  }, { limit: 250 });

  return roles
    .map((role) => ({
      role,
      modulePermissions: role.permissions
        .filter((permissionOnRole) => modulePermissionIds.has(permissionOnRole.permissionId))
        .map((permissionOnRole) => ({
          permission: permissionOnRole.permission.permission,
          count: permissionOnRole.count,
        })),
    }))
    .filter(({ modulePermissions }) => modulePermissions.length > 0)
    .map(({ role, modulePermissions }) => ({
      roleId: role.id,
      roleName: role.name,
      permissions: modulePermissions,
    }));
}

async function restoreVariables(client: Client, moduleId: string, variables: ModuleVariableBackup[]): Promise<void> {
  for (const variable of variables) {
    await client.variable.variableControllerCreate({
      key: variable.key,
      value: variable.value,
      gameServerId: variable.gameServerId,
      playerId: variable.playerId,
      moduleId,
    });
  }
}

async function rebindRoles(client: Client, roles: RoleBindingBackup[]): Promise<void> {
  if (roles.length === 0) {
    return;
  }

  const permissionsResult = await client.role.roleControllerGetPermissions();
  const permissionsByCode = new Map(
    permissionsResult.data.data.map((permission) => [permission.permission, permission.id]),
  );

  for (const role of roles) {
    let currentRole;
    try {
      currentRole = (await client.role.roleControllerGetOne(role.roleId)).data.data;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        console.warn(`rebindRoles: skipping missing role '${role.roleName}' (${role.roleId}) during module replacement`);
        continue;
      }
      throw err;
    }

    const mergedPermissions = new Map<string, { permissionId: string; count?: number }>(
      currentRole.permissions.map((permissionOnRole) => [
        permissionOnRole.permissionId,
        {
          permissionId: permissionOnRole.permissionId,
          count: permissionOnRole.count,
        },
      ]),
    );

    for (const permission of role.permissions) {
      const permissionId = permissionsByCode.get(permission.permission);
      if (!permissionId) {
        console.warn(
          `rebindRoles: skipping missing permission '${permission.permission}' while rebinding role '${role.roleName}'`,
        );
        continue;
      }

      mergedPermissions.set(permissionId, {
        permissionId,
        count: permission.count,
      });
    }

    await client.role.roleControllerUpdate(role.roleId, {
      name: currentRole.name,
      linkedDiscordRoleId: currentRole.linkedDiscordRoleId,
      permissions: Array.from(mergedPermissions.values()),
    });
  }
}

async function findModulesByName(client: Client, name: string): Promise<ModuleOutputDTO[]> {
  const searchResult = await client.module.moduleControllerSearch({
    filters: { name: [name] },
  });

  return searchResult.data.data.filter((module) => module.name === name);
}

async function findImportedModuleByName(
  client: Client,
  name: string,
  preexistingIds: Iterable<string> = [],
): Promise<ModuleOutputDTO> {
  const beforeIds = new Set(preexistingIds);
  const matches = await findModulesByName(client, name);
  const newMatches = matches.filter((module) => !beforeIds.has(module.id));

  if (newMatches.length === 1) {
    return newMatches[0];
  }

  if (newMatches.length > 1) {
    throw new Error(`Multiple new modules named '${name}' appeared after import; refusing to guess which one was imported`);
  }

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0) {
    throw new Error(`Module '${name}' not found after import`);
  }

  throw new Error(`Module '${name}' is ambiguous after import; found ${matches.length} exact-name matches and could not identify the new one`);
}

async function waitForInstalledModule(
  client: Client,
  moduleId: string,
  gameServerId: string,
  { timeoutMs = 30000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const installations = await client.module.moduleInstallationsControllerGetInstalledModules({
      filters: {
        moduleId: [moduleId],
        gameserverId: [gameServerId],
      },
      limit: 10,
    });

    if (installations.data.data.length > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for module '${moduleId}' to appear as installed on game server '${gameServerId}'`);
}

async function restoreInstallations(client: Client, module: ModuleOutputDTO, installations: ModuleInstallationBackup[]): Promise<void> {
  for (const installation of installations) {
    await installModule(client, module.latestVersion.id, installation.gameServerId, {
      userConfig: installation.userConfig,
      systemConfig: installation.systemConfig,
    });

    await waitForInstalledModule(client, module.id, installation.gameServerId);
  }
}

async function restoreModuleState(
  client: Client,
  moduleName: string,
  moduleExport: Record<string, unknown>,
  installations: ModuleInstallationBackup[],
  variables: ModuleVariableBackup[],
  roles: RoleBindingBackup[],
): Promise<ModuleOutputDTO> {
  const preexistingIds = (await findModulesByName(client, moduleName)).map((module) => module.id);
  await client.module.moduleControllerImport(moduleExport);
  const restoredModule = await findImportedModuleByName(client, moduleName, preexistingIds);

  await restoreInstallations(client, restoredModule, installations);
  await restoreVariables(client, restoredModule.id, variables);
  await rebindRoles(client, roles);

  return restoredModule;
}

async function removeModuleCompletely(
  client: Client,
  moduleId: string,
  installations?: ModuleInstallationBackup[],
): Promise<void> {
  const knownInstallations = installations ?? await collectModuleInstallations(client, moduleId);

  for (const installation of knownInstallations) {
    try {
      await uninstallModule(client, moduleId, installation.gameServerId);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        continue;
      }
      throw err;
    }
  }

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await client.module.moduleControllerRemove(moduleId);
      return;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        return;
      }

      if (status === 400 && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        continue;
      }

      throw err;
    }
  }
}

/**
 * Push a local module to Takaro via the import API.
 * If a module with the same name already exists, preserve its installations/state across replacement
 * and restore the prior module if the replacement import fails.
 * Returns the imported module (found by name from module.json).
 */
export async function pushModule(
  client: Client,
  moduleDir: string,
): Promise<ModuleOutputDTO> {
  const absoluteModuleDir = path.resolve(moduleDir);
  const moduleApi = client.module;

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

    const existingModules = await findModulesByName(client, name);
    const preexistingIds = existingModules.map((module) => module.id);

    let existingBackup: Record<string, unknown> | null = null;
    let existingInstallations: ModuleInstallationBackup[] = [];
    let existingVariables: ModuleVariableBackup[] = [];
    let existingRoles: RoleBindingBackup[] = [];

    for (const existingModule of existingModules) {
      const candidateBackup = (await moduleApi.moduleControllerExport(existingModule.id, {})).data.data as unknown as Record<string, unknown>;
      const candidateInstallations = await collectModuleInstallations(client, existingModule.id);
      const candidateVariables = await collectModuleVariables(client, existingModule.id);
      const candidateRoles = await collectModuleRoleBindings(client, existingModule.id);

      try {
        await removeModuleCompletely(client, existingModule.id, candidateInstallations);
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 400) {
          console.warn(
            `pushModule: leaving protected module '${name}' (${existingModule.id}) in place because Takaro rejected deletion with HTTP 400`,
          );
          continue;
        }
        throw err;
      }

      if (existingBackup) {
        throw new Error(`Found multiple replaceable modules named '${name}'. Refusing to replace them blindly.`);
      }

      existingBackup = candidateBackup;
      existingInstallations = candidateInstallations;
      existingVariables = candidateVariables;
      existingRoles = candidateRoles;
    }

    let importedModule: ModuleOutputDTO | undefined;
    try {
      await moduleApi.moduleControllerImport(moduleJson);
      importedModule = await findImportedModuleByName(client, name, preexistingIds);

      await restoreInstallations(client, importedModule, existingInstallations);
      await restoreVariables(client, importedModule.id, existingVariables);
      await rebindRoles(client, existingRoles);

      return importedModule;
    } catch (err) {
      if (!existingBackup) {
        throw err;
      }

      if (importedModule) {
        try {
          await removeModuleCompletely(client, importedModule.id);
        } catch (cleanupErr) {
          throw new Error(
            `Import of '${name}' failed after creating replacement module '${importedModule.id}', and cleanup of that replacement failed before rollback. Import error: ${err}. Cleanup error: ${cleanupErr}`,
          );
        }
      }

      try {
        await restoreModuleState(client, name, existingBackup, existingInstallations, existingVariables, existingRoles);
      } catch (restoreErr) {
        throw new Error(
          `Import of '${name}' failed and restoring the previous module also failed. Import error: ${err}. Restore error: ${restoreErr}`,
        );
      }

      throw new Error(
        `Import of '${name}' failed, but the previous module was restored. Cause: ${err}`,
      );
    }
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
  moduleId: string | undefined,
  gameServerId: string,
): Promise<void> {
  if (!moduleId) {
    console.error(`uninstallModule: skipping uninstall because moduleId was not set for game server '${gameServerId}'`);
    return;
  }
  await client.module.moduleInstallationsControllerUninstallModule(moduleId, gameServerId);
}

/**
 * Delete a module entirely from Takaro.
 */
export async function deleteModule(client: Client, moduleId: string | undefined): Promise<void> {
  if (!moduleId) {
    console.error('deleteModule: skipping delete because moduleId was not set');
    return;
  }
  try {
    await removeModuleCompletely(client, moduleId);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      console.error(`deleteModule: module '${moduleId}' already disappeared during cleanup, skipping`);
      return;
    }
    throw err;
  }
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
      const installations = await collectModuleInstallations(client, mod.id);
      await removeModuleCompletely(client, mod.id, installations);
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
