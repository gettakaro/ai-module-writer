import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { SettingsControllerGetKeysEnum } from '@takaro/apiclient';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Absolute path to the repo root */
const REPO_ROOT = process.cwd();
/** Path to the compiled module-to-json script */
const MODULE_TO_JSON_SCRIPT = path.join(REPO_ROOT, 'dist', 'scripts', 'module-to-json.js');
const TRANSIENT_INSTALLATION_RETRY_DELAY_MS = 1000;
const DEFAULT_INSTALLATION_WAIT_TIMEOUT_MS = 30000;
const TEST_RUN_STARTED_AT_MS = Number(process.env['TEST_RUN_STARTED_AT'] ?? '0');
const STALE_RESOURCE_SKEW_MS = 1000;
const TEST_IMPORT_NAME_PREFIX = 'test-';
function getTakaroErrorStatus(err) {
    return err?.response?.status;
}
function getTakaroErrorMessage(err) {
    return String(err?.message ?? err).toLowerCase();
}
function isTransientTakaroError(err) {
    const status = getTakaroErrorStatus(err);
    const message = getTakaroErrorMessage(err);
    return status === 500 || message.includes('econnreset') || message.includes('socket hang up');
}
function isAlreadyInstalledError(err) {
    const status = getTakaroErrorStatus(err);
    const message = getTakaroErrorMessage(err);
    return status === 409 || (status === 400 && message.includes('already')) || message.includes('already installed');
}
function isNotInstalledError(err) {
    const status = getTakaroErrorStatus(err);
    const message = getTakaroErrorMessage(err);
    return status === 404 || (status === 400 && message.includes('not installed')) || message.includes('not installed');
}
function summarizeTakaroError(err) {
    const status = getTakaroErrorStatus(err);
    const message = String(err?.message ?? err);
    return status ? `status=${status} message=${message}` : message;
}
function isStaleTestResource(createdAt) {
    if (!TEST_RUN_STARTED_AT_MS)
        return false;
    if (!createdAt)
        return false;
    const createdAtMs = Date.parse(createdAt);
    if (Number.isNaN(createdAtMs))
        return false;
    return createdAtMs < TEST_RUN_STARTED_AT_MS - STALE_RESOURCE_SKEW_MS;
}
async function waitForModuleInstallationState(client, moduleId, gameServerId, shouldExist, timeoutMs = DEFAULT_INSTALLATION_WAIT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await client.module.moduleInstallationsControllerGetModuleInstallation(moduleId, gameServerId);
            if (shouldExist)
                return;
        }
        catch (err) {
            if (err.response?.status === 404) {
                if (!shouldExist)
                    return;
            }
            else {
                throw err;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for module installation ${shouldExist ? 'to exist' : 'to be removed'}: moduleId=${moduleId} gameServerId=${gameServerId}`);
}
async function reconcileInstallationState(client, moduleId, gameServerId, shouldExist, timeoutMs = DEFAULT_INSTALLATION_WAIT_TIMEOUT_MS) {
    try {
        await waitForModuleInstallationState(client, moduleId, gameServerId, shouldExist, timeoutMs);
        return true;
    }
    catch {
        return false;
    }
}
async function withInstallationRetries(options) {
    const { fn, description, client, moduleId, gameServerId, shouldExist, isTerminalStateError } = options;
    const maxAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastError = err;
            if (await reconcileInstallationState(client, moduleId, gameServerId, shouldExist, 5000)) {
                console.warn(`${description} request failed on attempt ${attempt}/${maxAttempts}, but installation state reconciled as expected; treating as success (${summarizeTakaroError(err)}).`);
                return undefined;
            }
            if (isTerminalStateError?.(err)) {
                if (await reconcileInstallationState(client, moduleId, gameServerId, shouldExist, 5000)) {
                    console.warn(`${description} hit a terminal-state error after the desired installation state was already reached; treating as success (${summarizeTakaroError(err)}).`);
                    return undefined;
                }
            }
            if (attempt === maxAttempts || !isTransientTakaroError(err))
                throw err;
            console.warn(`${description} failed with a transient Takaro error on attempt ${attempt}/${maxAttempts}; retrying (${summarizeTakaroError(err)}).`);
            await new Promise((resolve) => setTimeout(resolve, TRANSIENT_INSTALLATION_RETRY_DELAY_MS * attempt));
        }
    }
    throw lastError;
}
/**
 * Push a local module to Takaro via the import API.
 * If a module with the same name already exists, deletes it first (idempotent).
 * Returns the imported module (found by name from module.json).
 */
export async function pushModule(client, moduleDir) {
    const absoluteModuleDir = path.resolve(moduleDir);
    // Convert the module dir to JSON using the compiled script
    const tempFile = path.join(os.tmpdir(), `takaro-push-${Date.now()}.json`);
    try {
        try {
            execFileSync(process.execPath, [MODULE_TO_JSON_SCRIPT, absoluteModuleDir, tempFile], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            const spawnErr = err;
            const stderr = spawnErr.stderr?.toString().trim() ?? '';
            throw new Error(`module-to-json failed for '${absoluteModuleDir}'${stderr ? `:\n${stderr}` : ' (no stderr output — is dist/ built?)'}`);
        }
        let moduleJson;
        try {
            moduleJson = JSON.parse(fs.readFileSync(tempFile, 'utf-8'));
        }
        catch (err) {
            throw new Error(`Failed to parse module-to-json output from '${tempFile}': ${err}`);
        }
        const resolvedName = moduleJson.name.startsWith(TEST_IMPORT_NAME_PREFIX)
            ? moduleJson.name
            : `${TEST_IMPORT_NAME_PREFIX}${moduleJson.name}`;
        const validationName = `${resolvedName}-validate-${Date.now().toString(36)}`;
        const existing = await client.module.moduleControllerSearch({
            filters: { name: [resolvedName] },
        });
        const existingModule = existing.data.data.find((m) => m.name === resolvedName);
        // First prove the payload is importable under a temporary validation name.
        await client.module.moduleControllerImport({ ...moduleJson, name: validationName });
        const validationSearch = await client.module.moduleControllerSearch({
            filters: { name: [validationName] },
        });
        const validationModule = validationSearch.data.data.find((m) => m.name === validationName);
        if (!validationModule) {
            throw new Error(`Validation import for '${resolvedName}' did not produce a temporary module`);
        }
        await client.module.moduleControllerRemove(validationModule.id);
        if (existingModule) {
            await client.module.moduleControllerRemove(existingModule.id);
        }
        await client.module.moduleControllerImport({ ...moduleJson, name: resolvedName });
        // Find the module by name after import (import API returns void, no module data in response)
        const searchResult = await client.module.moduleControllerSearch({
            filters: { name: [resolvedName] },
        });
        const found = searchResult.data.data.find((m) => m.name === resolvedName);
        if (!found)
            throw new Error(`Module '${resolvedName}' not found after import`);
        return found;
    }
    finally {
        if (fs.existsSync(tempFile))
            fs.unlinkSync(tempFile);
    }
}
/**
 * Install a module version on a game server.
 */
export async function installModule(client, versionId, gameServerId, config) {
    const version = await client.module.moduleVersionControllerGetModuleVersion(versionId);
    const moduleId = version.data.data.moduleId;
    await withInstallationRetries({
        fn: async () => {
            await client.module.moduleInstallationsControllerInstallModule({
                versionId,
                gameServerId,
                userConfig: config?.userConfig ? JSON.stringify(config.userConfig) : undefined,
                systemConfig: config?.systemConfig ? JSON.stringify(config.systemConfig) : undefined,
            });
        },
        description: 'installModule',
        client,
        moduleId,
        gameServerId,
        shouldExist: true,
        isTerminalStateError: isAlreadyInstalledError,
    });
    await waitForModuleInstallationState(client, moduleId, gameServerId, true);
}
/**
 * Uninstall a module from a game server.
 */
export async function uninstallModule(client, moduleId, gameServerId) {
    await withInstallationRetries({
        fn: async () => {
            await client.module.moduleInstallationsControllerUninstallModule(moduleId, gameServerId);
        },
        description: 'uninstallModule',
        client,
        moduleId,
        gameServerId,
        shouldExist: false,
        isTerminalStateError: isNotInstalledError,
    });
    await waitForModuleInstallationState(client, moduleId, gameServerId, false);
}
/**
 * Delete a module entirely from Takaro.
 */
export async function deleteModule(client, moduleId) {
    await client.module.moduleControllerRemove(moduleId);
}
/**
 * Get the command prefix configured for a game server.
 */
export async function getCommandPrefix(client, gameServerId) {
    const result = await client.settings.settingsControllerGet([SettingsControllerGetKeysEnum.CommandPrefix], gameServerId);
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
export async function cleanupTestModules(client) {
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
        }
        catch (err) {
            // Non-fatal: cleanup search failed (e.g. server-side error on corrupt module data).
            // The test's pushModule will handle idempotent cleanup for the specific module being tested.
            console.error('cleanupTestModules: search failed (non-fatal, skipping cleanup):', err);
            return;
        }
        const mods = result.data.data.filter((m) => m.name.startsWith('test-') && isStaleTestResource(m.createdAt));
        if (mods.length === 0)
            break;
        for (const mod of mods) {
            try {
                await client.module.moduleControllerRemove(mod.id);
            }
            catch (err) {
                if (err.response?.status !== 404)
                    throw err;
            }
        }
    }
}
/**
 * Create a role with specific module permissions and assign it to a player.
 * Returns the role ID for cleanup.
 * Accepts either string[] (no count) or PermissionInput[] (with optional count).
 */
export async function assignPermissions(client, playerId, gameServerId, permissionCodes) {
    if (permissionCodes.length === 0)
        throw new Error('assignPermissions: permissionCodes must not be empty');
    // Normalize to PermissionInput[] format
    const normalized = permissionCodes.map((p) => typeof p === 'string' ? { code: p } : p);
    const allPerms = await client.role.roleControllerGetPermissions();
    const permInputs = normalized.map((input) => {
        const found = allPerms.data.data.find((p) => p.permission === input.code);
        if (!found)
            throw new Error(`Permission '${input.code}' not found`);
        const result = { permissionId: found.id };
        if (input.count !== undefined)
            result.count = input.count;
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
    }
    catch (err) {
        // Clean up the created role to avoid orphans before rethrowing
        try {
            await client.role.roleControllerRemove(role.data.data.id);
        }
        catch (cleanupErr) {
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
export async function cleanupRole(client, roleId) {
    if (!roleId)
        return;
    try {
        await client.role.roleControllerRemove(roleId);
    }
    catch (err) {
        console.error(`cleanupRole: failed to delete role '${roleId}':`, err);
    }
}
/**
 * Delete all game servers whose names start with 'test-' (orphan cleanup).
 * Mock servers register with identityToken as the name (e.g. 'test-<uuid>').
 * These are left behind when tests crash before after() runs.
 */
export async function cleanupTestGameServers(client) {
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
        const servers = result.data.data.filter((gs) => gs.name.startsWith('test-') && isStaleTestResource(gs.createdAt));
        if (servers.length === 0)
            break;
        for (const gs of servers) {
            try {
                await client.gameserver.gameServerControllerRemove(gs.id);
            }
            catch (err) {
                if (err.response?.status !== 404)
                    throw err;
            }
        }
    }
}
