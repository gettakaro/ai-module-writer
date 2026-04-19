#!/usr/bin/env node
/**
 * Import a Takaro module export JSON using the API client instead of raw curl.
 * This preserves nested version payloads that the shell import path can drop.
 * Usage: node dist/scripts/module-import.js <module-export-json-file>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { Client, ModuleOutputDTO } from '@takaro/apiclient';
import { TakaroModuleExport } from '../types/module.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TOKEN_CACHE_PATH = '/tmp/takaro-token';
const INSTALLATION_PAGE_SIZE = 100;
const PAGE_SIZE = 100;

export function loadRepoEnv(): void {
  config({ path: path.join(REPO_ROOT, '.env') });
}

function readCachedToken(tokenPath = DEFAULT_TOKEN_CACHE_PATH): string | undefined {
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function isUnauthorizedError(err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status === 401;
}

export interface TakaroAuthConfig {
  url: string;
  domainId: string;
  username?: string;
  password?: string;
  token?: string;
}

interface SearchResponse<T> {
  data: T[];
  meta?: {
    total?: number;
  };
}

interface ExportResponse<T> {
  data: T;
}

interface InstallationSnapshot {
  gameServerId: string;
  userConfig: unknown;
  systemConfig: unknown;
}

interface VariableSnapshot {
  key: string;
  value: string;
  expiresAt?: string;
  gameServerId?: string;
  playerId?: string;
}

const TRANSIENT_MODULE_VARIABLE_PATTERNS = [
  /(?:^|_)lock$/i,
  /(?:^|_)delivery_receipt$/i,
];

interface RolePermissionSnapshot {
  permissionId: string;
  count?: number;
}

interface RoleSnapshot {
  id: string;
  permissions: RolePermissionSnapshot[];
}

interface ReplacementSnapshot {
  installations: InstallationSnapshot[];
  variables: VariableSnapshot[];
  rolesUsingModulePermissions: RoleSnapshot[];
  permissionIdToCode: Map<string, string>;
}

interface ImportModuleExportOptions {
  request?: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface ImportOps {
  findExactModuleByName(name: string): Promise<ModuleOutputDTO | null>;
  getInstallations(moduleId: string): Promise<InstallationSnapshot[]>;
  exportModule(moduleId: string): Promise<TakaroModuleExport>;
  removeModule(moduleId: string): Promise<void>;
  importModule(moduleExport: TakaroModuleExport): Promise<void>;
  reinstallInstallations(module: ModuleOutputDTO, installations: InstallationSnapshot[]): Promise<void>;
  getVariables(moduleId: string): Promise<VariableSnapshot[]>;
  upsertVariable(moduleId: string, variable: VariableSnapshot): Promise<void>;
  getModulePermissionIdToCode(moduleId: string): Promise<Map<string, string>>;
  getRolesUsingPermissionIds(permissionIds: string[]): Promise<RoleSnapshot[]>;
  getModulePermissionCodeToId(moduleId: string): Promise<Map<string, string>>;
  updateRolePermissions(roleId: string, permissions: RolePermissionSnapshot[]): Promise<void>;
}

class TakaroApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }

  const maybeResponse = (err as { response?: { data?: unknown; status?: number } })?.response;
  const apiMessage = (maybeResponse?.data as { meta?: { error?: { message?: string } } } | undefined)?.meta?.error?.message;
  if (apiMessage) {
    return apiMessage;
  }

  if (typeof err === 'string') {
    return err;
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isExpiredVariable(variable: VariableSnapshot, now = Date.now()): boolean {
  if (!variable.expiresAt) return false;
  const expiresAt = Date.parse(variable.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function isTransientModuleVariable(variable: VariableSnapshot): boolean {
  return TRANSIENT_MODULE_VARIABLE_PATTERNS.some((pattern) => pattern.test(variable.key));
}

function shouldRestoreModuleVariable(variable: VariableSnapshot): boolean {
  if (isExpiredVariable(variable)) {
    return false;
  }

  if (isTransientModuleVariable(variable)) {
    return false;
  }

  return true;
}

export function getTakaroAuthConfig(env: NodeJS.ProcessEnv = process.env): TakaroAuthConfig {
  loadRepoEnv();

  const url = env['TAKARO_HOST'];
  const domainId = env['TAKARO_DOMAIN_ID'];
  const username = env['TAKARO_USERNAME'];
  const password = env['TAKARO_PASSWORD'];
  const token = env['TAKARO_TOKEN'] ?? readCachedToken();

  if (!url) throw new Error('TAKARO_HOST is required');
  if (!domainId) throw new Error('TAKARO_DOMAIN_ID is required');
  if (!token && (!username || !password)) {
    throw new Error('TAKARO_TOKEN or TAKARO_USERNAME/TAKARO_PASSWORD is required');
  }

  return {
    url,
    domainId,
    username,
    password,
    token,
  };
}

export function createTakaroClient(auth: TakaroAuthConfig): { client: Client; canLogin: boolean } {
  const canLogin = Boolean(auth.username && auth.password);
  const client = new Client({
    url: auth.url,
    auth: canLogin
      ? {
          username: auth.username,
          password: auth.password,
        }
      : { token: auth.token },
    log: false,
  });
  client.setDomain(auth.domainId);
  if (!canLogin && auth.token) {
    client.setHeader('Authorization', `Bearer ${auth.token}`);
  }

  return {
    client,
    canLogin,
  };
}

export async function withOptionalLoginRetry<T>(
  client: Client,
  canLogin: boolean,
  domainId: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (!isUnauthorizedError(err) || !canLogin) {
      throw err;
    }

    await client.login();
    client.setDomain(domainId);
    return await operation();
  }
}

function createClientRequestRunner(
  client: Client,
  canLogin: boolean,
  domainId: string,
): <T>(operation: () => Promise<T>) => Promise<T> {
  return async <T>(operation: () => Promise<T>) => withOptionalLoginRetry(client, canLogin, domainId, operation);
}

export function readModuleExport(jsonFile: string): TakaroModuleExport {
  let moduleExport: TakaroModuleExport;
  try {
    moduleExport = JSON.parse(fs.readFileSync(jsonFile, 'utf-8')) as TakaroModuleExport;
  } catch (err) {
    throw new Error(`Failed to parse module export from '${jsonFile}': ${(err as Error).message}`);
  }

  if (!moduleExport?.name) {
    throw new Error(`Module export '${jsonFile}' is missing required field 'name'`);
  }

  return moduleExport;
}

async function findExactModuleByName(
  client: Client,
  name: string,
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<ModuleOutputDTO | null> {
  const existing = await request(() => client.module.moduleControllerSearch({
    filters: { name: [name] },
  }));

  return existing.data.data.find((mod) => mod.name === name) ?? null;
}

async function getInstallationsForModule(
  client: Client,
  moduleId: string,
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<InstallationSnapshot[]> {
  const snapshots: InstallationSnapshot[] = [];

  for (let page = 0; ; page++) {
    const installations = await request(() => client.module.moduleInstallationsControllerGetInstalledModules({
      filters: { moduleId: [moduleId] },
      limit: INSTALLATION_PAGE_SIZE,
      page,
    }));

    snapshots.push(
      ...installations.data.data.map((installation) => ({
        gameServerId: installation.gameserverId,
        userConfig: installation.userConfig,
        systemConfig: installation.systemConfig,
      })),
    );

    const fetched = installations.data.data.length;
    const total = installations.data.meta?.total;
    if (fetched < INSTALLATION_PAGE_SIZE) break;
    if (typeof total === 'number' && snapshots.length >= total) break;
  }

  return snapshots;
}

async function reinstallSnapshotsOnModule(
  client: Client,
  module: ModuleOutputDTO,
  installations: InstallationSnapshot[],
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<void> {
  if (installations.length === 0) return;

  for (const installation of installations) {
    await request(() => client.module.moduleInstallationsControllerInstallModule({
      versionId: module.latestVersion.id,
      gameServerId: installation.gameServerId,
      userConfig: installation.userConfig === undefined ? undefined : JSON.stringify(installation.userConfig),
      systemConfig: installation.systemConfig === undefined ? undefined : JSON.stringify(installation.systemConfig),
    }));
  }
}

async function getVariablesForModule(
  client: Client,
  moduleId: string,
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<VariableSnapshot[]> {
  const snapshots: VariableSnapshot[] = [];

  for (let page = 0; ; page++) {
    const result = await request(() => client.variable.variableControllerSearch({
      filters: { moduleId: [moduleId] },
      limit: PAGE_SIZE,
      page,
    }));

    snapshots.push(
      ...result.data.data.map((variable) => ({
        key: variable.key,
        value: variable.value,
        expiresAt: variable.expiresAt,
        gameServerId: variable.gameServerId,
        playerId: variable.playerId,
      })),
    );

    const fetched = result.data.data.length;
    const total = result.data.meta?.total;
    if (fetched < PAGE_SIZE) break;
    if (typeof total === 'number' && snapshots.length >= total) break;
  }

  return snapshots;
}

function buildVariableFilters(moduleId: string, variable: VariableSnapshot): Record<string, string[]> {
  const filters: Record<string, string[]> = {
    key: [variable.key],
    moduleId: [moduleId],
  };

  if (variable.gameServerId) {
    filters['gameServerId'] = [variable.gameServerId];
  }

  if (variable.playerId) {
    filters['playerId'] = [variable.playerId];
  }

  return filters;
}

async function upsertVariableOnModule(
  client: Client,
  moduleId: string,
  variable: VariableSnapshot,
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<void> {
  const existing = await request(() => client.variable.variableControllerSearch({
    filters: buildVariableFilters(moduleId, variable),
    limit: 1,
    page: 0,
  }));

  const found = existing.data.data[0];
  if (found) {
    await request(() => client.variable.variableControllerUpdate(found.id, {
      value: variable.value,
      expiresAt: variable.expiresAt,
    }));
    return;
  }

  await request(() => client.variable.variableControllerCreate({
    key: variable.key,
    value: variable.value,
    expiresAt: variable.expiresAt,
    gameServerId: variable.gameServerId,
    playerId: variable.playerId,
    moduleId,
  }));
}

async function getModulePermissionIdToCode(
  client: Client,
  moduleId: string,
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<Map<string, string>> {
  const permissions = await request(() => client.role.roleControllerGetPermissions());
  return new Map(
    permissions.data.data
      .filter((permission) => permission.module?.id === moduleId)
      .map((permission) => [permission.id, permission.permission]),
  );
}

async function getRolesUsingPermissionIds(
  client: Client,
  permissionIds: string[],
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<RoleSnapshot[]> {
  if (permissionIds.length === 0) return [];

  const wanted = new Set(permissionIds);
  const snapshots: RoleSnapshot[] = [];

  for (let page = 0; ; page++) {
    const result = await request(() => client.role.roleControllerSearch({
      extend: ['permissions'],
      limit: PAGE_SIZE,
      page,
    }));

    const affected = result.data.data
      .filter((role) => role.permissions.some((permission) => wanted.has(permission.permissionId)))
      .map((role) => ({
        id: role.id,
        permissions: role.permissions.map((permission) => ({
          permissionId: permission.permissionId,
          count: permission.count,
        })),
      }));

    snapshots.push(...affected);

    const fetched = result.data.data.length;
    const total = result.data.meta?.total;
    if (fetched < PAGE_SIZE) break;
    if (typeof total === 'number' && (page + 1) * PAGE_SIZE >= total) break;
  }

  return snapshots;
}

async function getModulePermissionCodeToId(
  client: Client,
  moduleId: string,
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<Map<string, string>> {
  const permissions = await request(() => client.role.roleControllerGetPermissions());
  return new Map(
    permissions.data.data
      .filter((permission) => permission.module?.id === moduleId)
      .map((permission) => [permission.permission, permission.id]),
  );
}

async function updateRolePermissions(
  client: Client,
  roleId: string,
  permissions: RolePermissionSnapshot[],
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<void> {
  await request(() => client.role.roleControllerUpdate(roleId, {
    permissions: permissions.map((permission) => ({
      permissionId: permission.permissionId,
      count: permission.count,
    })),
  }));
}

function createClientImportOps(
  client: Client,
  request: <T>(operation: () => Promise<T>) => Promise<T>,
): ImportOps {
  return {
    findExactModuleByName: async (name) => findExactModuleByName(client, name, request),
    getInstallations: async (moduleId) => getInstallationsForModule(client, moduleId, request),
    exportModule: async (moduleId) => {
      const exported = await request(() => client.module.moduleControllerExport(moduleId));
      return exported.data.data as TakaroModuleExport;
    },
    removeModule: async (moduleId) => {
      await request(() => client.module.moduleControllerRemove(moduleId));
    },
    importModule: async (moduleExport) => {
      await request(() => client.module.moduleControllerImport(moduleExport));
    },
    reinstallInstallations: async (module, installations) => reinstallSnapshotsOnModule(client, module, installations, request),
    getVariables: async (moduleId) => getVariablesForModule(client, moduleId, request),
    upsertVariable: async (moduleId, variable) => upsertVariableOnModule(client, moduleId, variable, request),
    getModulePermissionIdToCode: async (moduleId) => getModulePermissionIdToCode(client, moduleId, request),
    getRolesUsingPermissionIds: async (permissionIds) => getRolesUsingPermissionIds(client, permissionIds, request),
    getModulePermissionCodeToId: async (moduleId) => getModulePermissionCodeToId(client, moduleId, request),
    updateRolePermissions: async (roleId, permissions) => updateRolePermissions(client, roleId, permissions, request),
  };
}

async function snapshotReplacementState(ops: ImportOps, existingModule: ModuleOutputDTO): Promise<ReplacementSnapshot> {
  const permissionIdToCode = await ops.getModulePermissionIdToCode(existingModule.id);
  const permissionIds = [...permissionIdToCode.keys()];

  const [installations, variables, rolesUsingModulePermissions] = await Promise.all([
    ops.getInstallations(existingModule.id),
    ops.getVariables(existingModule.id),
    ops.getRolesUsingPermissionIds(permissionIds),
  ]);

  return {
    installations,
    variables: variables.filter(shouldRestoreModuleVariable),
    rolesUsingModulePermissions,
    permissionIdToCode,
  };
}

async function restoreVariablesOnModule(ops: ImportOps, moduleId: string, variables: VariableSnapshot[]): Promise<void> {
  for (const variable of variables) {
    await ops.upsertVariable(moduleId, variable);
  }
}

async function rebindRolesToReplacementPermissions(
  ops: ImportOps,
  replacementModule: ModuleOutputDTO,
  snapshot: ReplacementSnapshot,
): Promise<void> {
  if (snapshot.rolesUsingModulePermissions.length === 0 || snapshot.permissionIdToCode.size === 0) {
    return;
  }

  const newPermissionCodeToId = await ops.getModulePermissionCodeToId(replacementModule.id);

  for (const [oldPermissionId, code] of snapshot.permissionIdToCode.entries()) {
    if (!newPermissionCodeToId.has(code)) {
      throw new Error(
        `Replacement module '${replacementModule.name}' is missing permission '${code}' required to preserve existing role assignments from permission '${oldPermissionId}'`,
      );
    }
  }

  for (const role of snapshot.rolesUsingModulePermissions) {
    const reboundPermissions = role.permissions.map((permission) => {
      const code = snapshot.permissionIdToCode.get(permission.permissionId);
      if (!code) {
        return permission;
      }

      const replacementPermissionId = newPermissionCodeToId.get(code);
      if (!replacementPermissionId) {
        throw new Error(`Could not find replacement permission '${code}' while updating role '${role.id}'`);
      }

      return {
        permissionId: replacementPermissionId,
        count: permission.count,
      };
    });

    await ops.updateRolePermissions(role.id, reboundPermissions);
  }
}

async function applyReplacementSnapshot(
  ops: ImportOps,
  replacementModule: ModuleOutputDTO,
  snapshot: ReplacementSnapshot,
): Promise<void> {
  await restoreVariablesOnModule(ops, replacementModule.id, snapshot.variables);
  await rebindRolesToReplacementPermissions(ops, replacementModule, snapshot);
  await ops.reinstallInstallations(replacementModule, snapshot.installations);
}

async function importModuleExportWithOps(ops: ImportOps, moduleExport: TakaroModuleExport): Promise<ModuleOutputDTO> {
  const existingModule = await ops.findExactModuleByName(moduleExport.name);
  let backupModuleExport: TakaroModuleExport | null = null;
  let replacementSnapshot: ReplacementSnapshot = {
    installations: [],
    variables: [],
    rolesUsingModulePermissions: [],
    permissionIdToCode: new Map(),
  };

  if (existingModule) {
    console.error(`Module '${moduleExport.name}' already exists (id: ${existingModule.id}), exporting backup before replacement...`);
    replacementSnapshot = await snapshotReplacementState(ops, existingModule);
    backupModuleExport = await ops.exportModule(existingModule.id);
    await ops.removeModule(existingModule.id);
    console.error(`Removed existing module ${existingModule.id}`);
  }

  try {
    await ops.importModule(moduleExport);
    const found = await ops.findExactModuleByName(moduleExport.name);
    if (!found) {
      throw new Error(`Module '${moduleExport.name}' not found after import`);
    }

    await applyReplacementSnapshot(ops, found, replacementSnapshot);
    console.error(`Successfully imported module '${found.name}' (id: ${found.id})`);
    return found;
  } catch (err) {
    if (!backupModuleExport) {
      throw err;
    }

    try {
      const importedReplacement = await ops.findExactModuleByName(moduleExport.name);
      if (importedReplacement) {
        await ops.removeModule(importedReplacement.id);
      }
      await ops.importModule(backupModuleExport);
      const restored = await ops.findExactModuleByName(moduleExport.name);
      if (!restored) {
        throw new Error(`Module '${moduleExport.name}' not found after restore`);
      }
      await applyReplacementSnapshot(ops, restored, replacementSnapshot);
      console.error(`Restored previous module '${moduleExport.name}' from backup after import failure`);
    } catch (restoreErr) {
      throw new Error(
        `Import of '${moduleExport.name}' failed and automatic restore also failed. Import error: ${describeError(err)}. Restore error: ${describeError(restoreErr)}`,
      );
    }

    throw new Error(`Import of '${moduleExport.name}' failed, but the previous module was restored. Cause: ${describeError(err)}`);
  }
}

export async function importModuleExport(
  client: Client,
  moduleExport: TakaroModuleExport,
  options: ImportModuleExportOptions = {},
): Promise<ModuleOutputDTO> {
  const request = options.request ?? (async <T>(operation: () => Promise<T>) => operation());
  return await importModuleExportWithOps(createClientImportOps(client, request), moduleExport);
}

async function takaroTokenRequest<T>(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
  requestPath: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${auth.url}${requestPath}`, {
    method: options.method ?? 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'X-Takaro-Domain': auth.domainId,
      'Content-Type': 'application/json',
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const parsed = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = parsed?.meta?.error?.message ?? `Request failed with status code ${response.status}`;
    throw new TakaroApiError(message, response.status);
  }

  return parsed as T;
}

async function findExactModuleByNameWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
  name: string,
): Promise<ModuleOutputDTO | null> {
  const searchResult = await takaroTokenRequest<SearchResponse<ModuleOutputDTO>>(auth, '/module/search', {
    body: { filters: { name: [name] } },
  });

  return searchResult.data.find((mod) => mod.name === name) ?? null;
}

async function getInstallationsForModuleWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
  moduleId: string,
): Promise<InstallationSnapshot[]> {
  const snapshots: InstallationSnapshot[] = [];

  for (let page = 0; ; page++) {
    const result = await takaroTokenRequest<
      SearchResponse<{ gameserverId: string; userConfig: unknown; systemConfig: unknown }>
    >(auth, '/module/installation/search', {
      body: { filters: { moduleId: [moduleId] }, limit: INSTALLATION_PAGE_SIZE, page },
    });

    snapshots.push(
      ...result.data.map((installation) => ({
        gameServerId: installation.gameserverId,
        userConfig: installation.userConfig,
        systemConfig: installation.systemConfig,
      })),
    );

    const fetched = result.data.length;
    const total = result.meta?.total;
    if (fetched < INSTALLATION_PAGE_SIZE) break;
    if (typeof total === 'number' && snapshots.length >= total) break;
  }

  return snapshots;
}

interface TokenVariableSearchResult {
  id: string;
  key: string;
  value: string;
  expiresAt?: string;
  gameServerId?: string;
  playerId?: string;
}

interface TokenPermissionResult {
  id: string;
  permission: string;
  module?: { id: string; name: string };
}

interface TokenRoleResult {
  id: string;
  permissions: Array<{ permissionId: string; count?: number }>;
}

async function getVariablesForModuleWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
  moduleId: string,
): Promise<VariableSnapshot[]> {
  const snapshots: VariableSnapshot[] = [];

  for (let page = 0; ; page++) {
    const result = await takaroTokenRequest<SearchResponse<TokenVariableSearchResult>>(auth, '/variables/search', {
      body: { filters: { moduleId: [moduleId] }, limit: PAGE_SIZE, page },
    });

    snapshots.push(
      ...result.data.map((variable) => ({
        key: variable.key,
        value: variable.value,
        expiresAt: variable.expiresAt,
        gameServerId: variable.gameServerId,
        playerId: variable.playerId,
      })),
    );

    const fetched = result.data.length;
    const total = result.meta?.total;
    if (fetched < PAGE_SIZE) break;
    if (typeof total === 'number' && snapshots.length >= total) break;
  }

  return snapshots;
}

async function upsertVariableOnModuleWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
  moduleId: string,
  variable: VariableSnapshot,
): Promise<void> {
  const existing = await takaroTokenRequest<SearchResponse<TokenVariableSearchResult>>(auth, '/variables/search', {
    body: { filters: buildVariableFilters(moduleId, variable), limit: 1, page: 0 },
  });

  const found = existing.data[0];
  if (found) {
    await takaroTokenRequest(auth, `/variables/${found.id}`, {
      method: 'PUT',
      body: {
        value: variable.value,
        expiresAt: variable.expiresAt,
      },
    });
    return;
  }

  await takaroTokenRequest(auth, '/variables', {
    method: 'POST',
    body: {
      key: variable.key,
      value: variable.value,
      expiresAt: variable.expiresAt,
      gameServerId: variable.gameServerId,
      playerId: variable.playerId,
      moduleId,
    },
  });
}

async function getAllPermissionsWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
): Promise<TokenPermissionResult[]> {
  const result = await takaroTokenRequest<SearchResponse<TokenPermissionResult>>(auth, '/permissions', {
    method: 'GET',
  });
  return result.data;
}

async function getRolesUsingPermissionIdsWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
  permissionIds: string[],
): Promise<RoleSnapshot[]> {
  if (permissionIds.length === 0) return [];

  const wanted = new Set(permissionIds);
  const snapshots: RoleSnapshot[] = [];

  for (let page = 0; ; page++) {
    const result = await takaroTokenRequest<SearchResponse<TokenRoleResult>>(auth, '/role/search', {
      body: { extend: ['permissions'], limit: PAGE_SIZE, page },
    });

    snapshots.push(
      ...result.data
        .filter((role) => role.permissions.some((permission) => wanted.has(permission.permissionId)))
        .map((role) => ({
          id: role.id,
          permissions: role.permissions.map((permission) => ({
            permissionId: permission.permissionId,
            count: permission.count,
          })),
        })),
    );

    const fetched = result.data.length;
    const total = result.meta?.total;
    if (fetched < PAGE_SIZE) break;
    if (typeof total === 'number' && (page + 1) * PAGE_SIZE >= total) break;
  }

  return snapshots;
}

async function reinstallSnapshotsOnModuleWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
  module: ModuleOutputDTO,
  installations: InstallationSnapshot[],
): Promise<void> {
  if (installations.length === 0) return;

  for (const installation of installations) {
    await takaroTokenRequest(auth, '/module/installation/', {
      body: {
        versionId: module.latestVersion.id,
        gameServerId: installation.gameServerId,
        userConfig: installation.userConfig === undefined ? undefined : JSON.stringify(installation.userConfig),
        systemConfig: installation.systemConfig === undefined ? undefined : JSON.stringify(installation.systemConfig),
      },
    });
  }
}

function createTokenImportOps(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
): ImportOps {
  return {
    findExactModuleByName: async (name) => findExactModuleByNameWithToken(auth, name),
    getInstallations: async (moduleId) => getInstallationsForModuleWithToken(auth, moduleId),
    exportModule: async (moduleId) => {
      const exported = await takaroTokenRequest<ExportResponse<TakaroModuleExport>>(auth, `/module/${moduleId}/export`, { body: {} });
      return exported.data;
    },
    removeModule: async (moduleId) => {
      await takaroTokenRequest(auth, `/module/${moduleId}`, { method: 'DELETE' });
    },
    importModule: async (moduleExport) => {
      await takaroTokenRequest(auth, '/module/import', { body: moduleExport });
    },
    reinstallInstallations: async (module, installations) => reinstallSnapshotsOnModuleWithToken(auth, module, installations),
    getVariables: async (moduleId) => getVariablesForModuleWithToken(auth, moduleId),
    upsertVariable: async (moduleId, variable) => upsertVariableOnModuleWithToken(auth, moduleId, variable),
    getModulePermissionIdToCode: async (moduleId) => {
      const permissions = await getAllPermissionsWithToken(auth);
      return new Map(
        permissions
          .filter((permission) => permission.module?.id === moduleId)
          .map((permission) => [permission.id, permission.permission]),
      );
    },
    getRolesUsingPermissionIds: async (permissionIds) => getRolesUsingPermissionIdsWithToken(auth, permissionIds),
    getModulePermissionCodeToId: async (moduleId) => {
      const permissions = await getAllPermissionsWithToken(auth);
      return new Map(
        permissions
          .filter((permission) => permission.module?.id === moduleId)
          .map((permission) => [permission.permission, permission.id]),
      );
    },
    updateRolePermissions: async (roleId, permissions) => {
      await takaroTokenRequest(auth, `/role/${roleId}`, {
        method: 'PUT',
        body: {
          permissions: permissions.map((permission) => ({
            permissionId: permission.permissionId,
            count: permission.count,
          })),
        },
      });
    },
  };
}

export async function importModuleExportWithToken(auth: TakaroAuthConfig, moduleExport: TakaroModuleExport): Promise<ModuleOutputDTO> {
  if (!auth.token) {
    throw new Error('TAKARO_TOKEN is required for token-only module imports');
  }

  const tokenAuth = {
    url: auth.url,
    domainId: auth.domainId,
    token: auth.token,
  };

  return await importModuleExportWithOps(createTokenImportOps(tokenAuth), moduleExport);
}

export async function importModuleExportFile(jsonFile: string): Promise<ModuleOutputDTO> {
  const auth = getTakaroAuthConfig();
  const moduleExport = readModuleExport(jsonFile);

  if (auth.token && !auth.username && !auth.password) {
    return await importModuleExportWithToken(auth, moduleExport);
  }

  const { client, canLogin } = createTakaroClient(auth);
  const request = createClientRequestRunner(client, canLogin, auth.domainId);
  return await importModuleExport(client, moduleExport, { request });
}

async function main() {
  const jsonFile = process.argv[2];

  if (!jsonFile) {
    console.error('Usage: module-import.js <module-export-json-file>');
    process.exit(1);
  }

  try {
    const found = await importModuleExportFile(jsonFile);
    console.log(JSON.stringify({ data: found satisfies ModuleOutputDTO }, null, 2));
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  await main();
}
