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
import { ReplacementStateConfig, TakaroModuleExport } from '../types/module.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TOKEN_CACHE_PATH = '/tmp/takaro-token';
const INSTALLATION_PAGE_SIZE = 100;
const PAGE_SIZE = 100;
const REPLACEMENT_PERMISSION_POLL_DELAY_MS = 500;
const REPLACEMENT_PERMISSION_POLL_TIMEOUT_MS = 15000;
const REPLACEMENT_MODULE_POLL_DELAY_MS = 500;
const REPLACEMENT_MODULE_POLL_TIMEOUT_MS = 15000;

export function loadRepoEnv(): Record<string, string> {
  return config({ path: path.join(REPO_ROOT, '.env') }).parsed ?? {};
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

interface RolePermissionSnapshot {
  permissionId: string;
  count?: number;
}

interface RoleSnapshot {
  id: string;
  permissions: RolePermissionSnapshot[];
}

interface RoleDetailPermissionSnapshot {
  permissionId: string;
  count?: number;
}

interface ReplacementSnapshot {
  installations: InstallationSnapshot[];
  variables: VariableSnapshot[];
  rolesUsingModulePermissions: RoleSnapshot[];
  permissionIdToCode: Map<string, string>;
}

interface ReplacementPlan {
  existingModuleId?: string;
  variableConfig?: ReplacementStateConfig;
}

interface ImportModuleExportOptions {
  request?: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface RoleSearchPermissionSnapshot {
  permissionId: string;
  count?: number;
  permission?: {
    permission?: string;
    module?: {
      id?: string;
      name?: string;
    };
  };
}

interface RoleSearchResultSnapshot {
  id: string;
  permissions: RoleSearchPermissionSnapshot[];
}

interface RolesUsingModulePermissionsSnapshot {
  roles: RoleSnapshot[];
  permissionIdToCode: Map<string, string>;
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
  getRolesUsingModulePermissions(moduleId: string, permissionIdToCode: Map<string, string>): Promise<RolesUsingModulePermissionsSnapshot>;
  getModulePermissionCodeToId(moduleId: string): Promise<Map<string, string>>;
  getRolePermissions(roleId: string): Promise<RoleDetailPermissionSnapshot[]>;
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

function shouldRestoreModuleVariable(variable: VariableSnapshot, config?: ReplacementStateConfig): boolean {
  if (isExpiredVariable(variable)) {
    return false;
  }

  const durableVariableKeys = config?.durableVariableKeys;
  if (!durableVariableKeys || durableVariableKeys.length === 0) {
    return true;
  }

  return durableVariableKeys.includes(variable.key);
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveAuthValue(env: NodeJS.ProcessEnv, repoEnv: Record<string, string>, key: string): string | undefined {
  return normalizeEnvValue(env[key]) ?? normalizeEnvValue(repoEnv[key]);
}

function normalizeVariableSnapshot(variable: VariableSnapshot): VariableSnapshot {
  return {
    key: variable.key,
    value: variable.value,
    ...(variable.expiresAt ? { expiresAt: variable.expiresAt } : {}),
    ...(variable.gameServerId ? { gameServerId: variable.gameServerId } : {}),
    ...(variable.playerId ? { playerId: variable.playerId } : {}),
  };
}

export function getTakaroAuthConfig(env: NodeJS.ProcessEnv = process.env): TakaroAuthConfig {
  const repoEnv = loadRepoEnv();

  const url = resolveAuthValue(env, repoEnv, 'TAKARO_HOST');
  const domainId = resolveAuthValue(env, repoEnv, 'TAKARO_DOMAIN_ID');
  const username = resolveAuthValue(env, repoEnv, 'TAKARO_USERNAME');
  const password = resolveAuthValue(env, repoEnv, 'TAKARO_PASSWORD');
  const token = resolveAuthValue(env, repoEnv, 'TAKARO_TOKEN') ?? readCachedToken();

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
      ...result.data.data.map((variable) => normalizeVariableSnapshot({
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
    ...normalizeVariableSnapshot(variable),
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

function extractRoleSnapshotForModule(
  role: RoleSearchResultSnapshot,
  moduleId: string,
  knownPermissionIdToCode: Map<string, string>,
): { roleSnapshot: RoleSnapshot | null; discoveredPermissionIdToCode: Map<string, string> } {
  const discoveredPermissionIdToCode = new Map<string, string>();

  const usesModulePermission = role.permissions.some((permission) => {
    if (knownPermissionIdToCode.has(permission.permissionId)) {
      return true;
    }

    const modulePermission = permission.permission;
    const code = typeof modulePermission?.permission === 'string' ? modulePermission.permission : undefined;
    const ownerModuleId = modulePermission?.module?.id;
    if (ownerModuleId === moduleId && code) {
      discoveredPermissionIdToCode.set(permission.permissionId, code);
      return true;
    }

    return false;
  });

  if (!usesModulePermission) {
    return {
      roleSnapshot: null,
      discoveredPermissionIdToCode,
    };
  }

  return {
    roleSnapshot: {
      id: role.id,
      permissions: role.permissions.map((permission) => ({
        permissionId: permission.permissionId,
        count: permission.count,
      })),
    },
    discoveredPermissionIdToCode,
  };
}

async function getRolesUsingModulePermissions(
  client: Client,
  moduleId: string,
  permissionIdToCode: Map<string, string>,
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<RolesUsingModulePermissionsSnapshot> {
  const snapshots: RoleSnapshot[] = [];
  const discoveredPermissionIdToCode = new Map(permissionIdToCode);

  for (let page = 0; ; page++) {
    const result = await request(() => client.role.roleControllerSearch({
      extend: ['permissions'],
      limit: PAGE_SIZE,
      page,
    }));

    for (const role of result.data.data as RoleSearchResultSnapshot[]) {
      const extracted = extractRoleSnapshotForModule(role, moduleId, discoveredPermissionIdToCode);
      for (const [permissionId, code] of extracted.discoveredPermissionIdToCode) {
        discoveredPermissionIdToCode.set(permissionId, code);
      }
      if (extracted.roleSnapshot) {
        snapshots.push(extracted.roleSnapshot);
      }
    }

    const fetched = result.data.data.length;
    const total = result.data.meta?.total;
    if (fetched < PAGE_SIZE) break;
    if (typeof total === 'number' && (page + 1) * PAGE_SIZE >= total) break;
  }

  return {
    roles: snapshots,
    permissionIdToCode: discoveredPermissionIdToCode,
  };
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

async function getRolePermissions(
  client: Client,
  roleId: string,
  request: <T>(operation: () => Promise<T>) => Promise<T> = async <T>(operation: () => Promise<T>) => operation(),
): Promise<RoleDetailPermissionSnapshot[]> {
  const role = await request(() => client.role.roleControllerGetOne(roleId));
  return (role.data.data.permissions ?? []).map((permission) => ({
    permissionId: permission.permissionId,
    count: permission.count,
  }));
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
    getRolesUsingModulePermissions: async (moduleId, permissionIdToCode) => getRolesUsingModulePermissions(client, moduleId, permissionIdToCode, request),
    getModulePermissionCodeToId: async (moduleId) => getModulePermissionCodeToId(client, moduleId, request),
    getRolePermissions: async (roleId) => getRolePermissions(client, roleId, request),
    updateRolePermissions: async (roleId, permissions) => updateRolePermissions(client, roleId, permissions, request),
  };
}

async function snapshotReplacementState(
  ops: ImportOps,
  existingModule: ModuleOutputDTO,
  variableConfig?: ReplacementStateConfig,
): Promise<ReplacementSnapshot> {
  const permissionIdToCode = await ops.getModulePermissionIdToCode(existingModule.id);

  const [installations, variables, roleSnapshot] = await Promise.all([
    ops.getInstallations(existingModule.id),
    ops.getVariables(existingModule.id),
    ops.getRolesUsingModulePermissions(existingModule.id, permissionIdToCode),
  ]);

  return {
    installations,
    variables: variables.filter((variable) => shouldRestoreModuleVariable(variable, variableConfig)),
    rolesUsingModulePermissions: roleSnapshot.roles,
    permissionIdToCode: roleSnapshot.permissionIdToCode,
  };
}

async function restoreVariablesOnModule(ops: ImportOps, moduleId: string, variables: VariableSnapshot[]): Promise<void> {
  for (const variable of variables) {
    await ops.upsertVariable(moduleId, variable);
  }
}

async function waitForReplacementPermissionMap(
  ops: ImportOps,
  replacementModule: ModuleOutputDTO,
  expectedCodes: string[],
): Promise<Map<string, string>> {
  const uniqueExpectedCodes = [...new Set(expectedCodes)];
  let lastSeen = new Map<string, string>();
  const deadline = Date.now() + REPLACEMENT_PERMISSION_POLL_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    lastSeen = await ops.getModulePermissionCodeToId(replacementModule.id);
    const missingCodes = uniqueExpectedCodes.filter((code) => !lastSeen.has(code));
    if (missingCodes.length === 0) {
      return lastSeen;
    }

    if (Date.now() + REPLACEMENT_PERMISSION_POLL_DELAY_MS > deadline) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, REPLACEMENT_PERMISSION_POLL_DELAY_MS));
  }

  return lastSeen;
}

async function rebindRolesToReplacementPermissions(
  ops: ImportOps,
  replacementModule: ModuleOutputDTO,
  snapshot: ReplacementSnapshot,
): Promise<void> {
  if (snapshot.rolesUsingModulePermissions.length === 0 || snapshot.permissionIdToCode.size === 0) {
    return;
  }

  const expectedCodes = [...snapshot.permissionIdToCode.values()];
  const newPermissionCodeToId = await waitForReplacementPermissionMap(ops, replacementModule, expectedCodes);
  const missingCodes = [...new Set(
    expectedCodes.filter((code) => !newPermissionCodeToId.has(code)),
  )];

  if (missingCodes.length > 0) {
    throw new Error(
      `Replacement module '${replacementModule.name}' is missing permissions required to preserve existing role bindings [${missingCodes.join(', ')}]. Aborting replacement import so the previous module can be restored without silently removing access.`,
    );
  }

  const previousModulePermissionIds = new Set(snapshot.permissionIdToCode.keys());

  for (const role of snapshot.rolesUsingModulePermissions) {
    const currentPermissions = await ops.getRolePermissions(role.id);
    const preservedCurrentPermissions = currentPermissions.filter(
      (permission) => !previousModulePermissionIds.has(permission.permissionId),
    );

    const replacementPermissions = role.permissions.flatMap((permission) => {
      const code = snapshot.permissionIdToCode.get(permission.permissionId);
      if (!code) {
        return [];
      }

      const replacementPermissionId = newPermissionCodeToId.get(code);
      if (!replacementPermissionId) {
        return [];
      }

      return [{
        permissionId: replacementPermissionId,
        count: permission.count,
      }];
    });

    const mergedPermissions = new Map<string, RolePermissionSnapshot>();
    for (const permission of [...preservedCurrentPermissions, ...replacementPermissions]) {
      mergedPermissions.set(permission.permissionId, permission);
    }

    await ops.updateRolePermissions(role.id, [...mergedPermissions.values()]);
  }
}

function getReplacementExportPermissionCodes(moduleExport: TakaroModuleExport): Set<string> {
  return new Set(
    (moduleExport.versions ?? [])
      .flatMap((version) => version.permissions ?? [])
      .map((permission) => permission.permission)
      .filter((permission): permission is string => typeof permission === 'string' && permission.length > 0),
  );
}

function assertReplacementExportCanPreserveRoleBindings(
  moduleExport: TakaroModuleExport,
  snapshot: ReplacementSnapshot,
): void {
  if (snapshot.rolesUsingModulePermissions.length === 0 || snapshot.permissionIdToCode.size === 0) {
    return;
  }

  const replacementPermissionCodes = getReplacementExportPermissionCodes(moduleExport);
  const requiredCodes = [...new Set(snapshot.permissionIdToCode.values())];
  const missingCodes = requiredCodes.filter((code) => !replacementPermissionCodes.has(code));

  if (missingCodes.length > 0) {
    throw new Error(
      `Replacement module '${moduleExport.name}' is missing permissions required to preserve existing role bindings [${missingCodes.join(', ')}]. Aborting replacement import before deleting the previous module so access is preserved.`,
    );
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

async function waitForImportedModule(
  ops: ImportOps,
  moduleName: string,
  existingModuleId?: string,
): Promise<ModuleOutputDTO> {
  const deadline = Date.now() + REPLACEMENT_MODULE_POLL_TIMEOUT_MS;
  let lastSeen: ModuleOutputDTO | null = null;

  while (Date.now() <= deadline) {
    lastSeen = await ops.findExactModuleByName(moduleName);
    if (lastSeen && (!existingModuleId || lastSeen.id !== existingModuleId)) {
      return lastSeen;
    }

    if (Date.now() + REPLACEMENT_MODULE_POLL_DELAY_MS > deadline) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, REPLACEMENT_MODULE_POLL_DELAY_MS));
  }

  if (!lastSeen) {
    throw new Error(`Module '${moduleName}' not found after import`);
  }

  throw new Error(
    `Module '${moduleName}' search still resolves to the deleted module id '${existingModuleId}' after import; refusing to continue until the replacement record is discoverable.`,
  );
}

async function importModuleExportWithOps(ops: ImportOps, moduleExport: TakaroModuleExport, plan: ReplacementPlan = {}): Promise<ModuleOutputDTO> {
  const existingModule = await ops.findExactModuleByName(moduleExport.name);
  const existingModuleId = plan.existingModuleId ?? existingModule?.id;
  let backupModuleExport: TakaroModuleExport | null = null;
  let replacementSnapshot: ReplacementSnapshot = {
    installations: [],
    variables: [],
    rolesUsingModulePermissions: [],
    permissionIdToCode: new Map(),
  };

  if (existingModule) {
    console.error(`Module '${moduleExport.name}' already exists (id: ${existingModule.id}), exporting backup before replacement...`);
    replacementSnapshot = await snapshotReplacementState(ops, existingModule, plan.variableConfig);
    assertReplacementExportCanPreserveRoleBindings(moduleExport, replacementSnapshot);
    backupModuleExport = await ops.exportModule(existingModule.id);
    await ops.removeModule(existingModule.id);
    console.error(`Removed existing module ${existingModule.id}`);
  }

  try {
    await ops.importModule(moduleExport);
    const found = await waitForImportedModule(ops, moduleExport.name, existingModuleId);

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
      const restored = await waitForImportedModule(ops, moduleExport.name, importedReplacement?.id);
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
  return await importModuleExportWithOps(createClientImportOps(client, request), moduleExport, {
    variableConfig: moduleExport.xPiReplacementState,
  });
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
  let parsed: unknown = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (!response.ok) {
        throw new TakaroApiError(
          `Request failed with status code ${response.status}: ${text.slice(0, 500)}`,
          response.status,
        );
      }

      throw new Error(
        `Takaro token request to '${requestPath}' returned a non-JSON success response: ${(err as Error).message}`,
      );
    }
  }

  if (!response.ok) {
    const message = (parsed as { meta?: { error?: { message?: string } } } | undefined)?.meta?.error?.message
      ?? (text.trim().length > 0 ? text.slice(0, 500) : `Request failed with status code ${response.status}`);
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
  permissions: RoleSearchPermissionSnapshot[];
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
      ...result.data.map((variable) => normalizeVariableSnapshot({
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
      ...normalizeVariableSnapshot(variable),
      moduleId,
    },
  });
}

async function getAllPermissionsWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
): Promise<TokenPermissionResult[]> {
  const permissions: TokenPermissionResult[] = [];
  const seenPermissionIds = new Set<string>();

  for (let page = 0; ; page++) {
    const result = await takaroTokenRequest<SearchResponse<TokenPermissionResult>>(
      auth,
      `/permissions?page=${page}&limit=${PAGE_SIZE}`,
      { method: 'GET' },
    );

    const batch = Array.isArray(result.data) ? result.data : [];
    let addedFromBatch = 0;
    for (const permission of batch) {
      if (seenPermissionIds.has(permission.id)) {
        continue;
      }

      seenPermissionIds.add(permission.id);
      permissions.push(permission);
      addedFromBatch++;
    }

    const total = result.meta?.total;
    if (typeof total === 'number' && permissions.length >= total) {
      break;
    }

    if (batch.length < PAGE_SIZE) {
      break;
    }

    if (addedFromBatch === 0) {
      console.warn('module-import: stopping permission pagination early because the next /permissions page repeated only previously-seen ids');
      break;
    }
  }

  return permissions;
}

async function getRolesUsingModulePermissionsWithToken(
  auth: Required<Pick<TakaroAuthConfig, 'url' | 'domainId' | 'token'>>,
  moduleId: string,
  permissionIdToCode: Map<string, string>,
): Promise<RolesUsingModulePermissionsSnapshot> {
  const snapshots: RoleSnapshot[] = [];
  const discoveredPermissionIdToCode = new Map(permissionIdToCode);

  for (let page = 0; ; page++) {
    const result = await takaroTokenRequest<SearchResponse<TokenRoleResult>>(auth, '/role/search', {
      body: { extend: ['permissions'], limit: PAGE_SIZE, page },
    });

    for (const role of result.data) {
      const extracted = extractRoleSnapshotForModule(role, moduleId, discoveredPermissionIdToCode);
      for (const [permissionId, code] of extracted.discoveredPermissionIdToCode) {
        discoveredPermissionIdToCode.set(permissionId, code);
      }
      if (extracted.roleSnapshot) {
        snapshots.push(extracted.roleSnapshot);
      }
    }

    const fetched = result.data.length;
    const total = result.meta?.total;
    if (fetched < PAGE_SIZE) break;
    if (typeof total === 'number' && (page + 1) * PAGE_SIZE >= total) break;
  }

  return {
    roles: snapshots,
    permissionIdToCode: discoveredPermissionIdToCode,
  };
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
    getRolesUsingModulePermissions: async (moduleId, permissionIdToCode) =>
      getRolesUsingModulePermissionsWithToken(auth, moduleId, permissionIdToCode),
    getModulePermissionCodeToId: async (moduleId) => {
      const permissions = await getAllPermissionsWithToken(auth);
      return new Map(
        permissions
          .filter((permission) => permission.module?.id === moduleId)
          .map((permission) => [permission.permission, permission.id]),
      );
    },
    getRolePermissions: async (roleId) => {
      const role = await takaroTokenRequest<{ data: { permissions?: Array<{ permissionId: string; count?: number }> } }>(auth, `/role/${roleId}`, {
        method: 'GET',
      });
      return (role.data.permissions ?? []).map((permission) => ({
        permissionId: permission.permissionId,
        count: permission.count,
      }));
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

  const ops = createTokenImportOps(tokenAuth);
  const existingModule = await ops.findExactModuleByName(moduleExport.name);
  if (existingModule) {
    throw new Error(
      `Token-only replacement import for '${moduleExport.name}' is disabled because it deletes the existing module before the replacement is fully restored. Provide TAKARO_USERNAME and TAKARO_PASSWORD so module-import can recover safely if auth expires mid-flight.`,
    );
  }

  return await importModuleExportWithOps(ops, moduleExport, {
    variableConfig: moduleExport.xPiReplacementState,
  });
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
