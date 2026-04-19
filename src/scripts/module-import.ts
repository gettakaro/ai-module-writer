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
}

interface ExportResponse<T> {
  data: T;
}

interface InstallationSnapshot {
  gameServerId: string;
  userConfig: unknown;
  systemConfig: unknown;
}

class TakaroApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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

async function findExactModuleByName(client: Client, name: string): Promise<ModuleOutputDTO | null> {
  const existing = await client.module.moduleControllerSearch({
    filters: { name: [name] },
  });

  return existing.data.data.find((mod) => mod.name === name) ?? null;
}

async function getInstallationsForModule(client: Client, moduleId: string): Promise<InstallationSnapshot[]> {
  const installations = await client.module.moduleInstallationsControllerGetInstalledModules({
    filters: { moduleId: [moduleId] },
    limit: 100,
  });

  return installations.data.data.map((installation) => ({
    gameServerId: installation.gameserverId,
    userConfig: installation.userConfig,
    systemConfig: installation.systemConfig,
  }));
}

async function reinstallSnapshotsOnModule(
  client: Client,
  module: ModuleOutputDTO,
  installations: InstallationSnapshot[],
): Promise<void> {
  if (installations.length === 0) return;

  for (const installation of installations) {
    await client.module.moduleInstallationsControllerInstallModule({
      versionId: module.latestVersion.id,
      gameServerId: installation.gameServerId,
      userConfig: installation.userConfig === undefined ? undefined : JSON.stringify(installation.userConfig),
      systemConfig: installation.systemConfig === undefined ? undefined : JSON.stringify(installation.systemConfig),
    });
  }
}

export async function importModuleExport(
  client: Client,
  moduleExport: TakaroModuleExport,
): Promise<ModuleOutputDTO> {
  const existingModule = await findExactModuleByName(client, moduleExport.name);
  let backupModuleExport: TakaroModuleExport | null = null;
  let installationSnapshots: InstallationSnapshot[] = [];

  if (existingModule) {
    console.error(`Module '${moduleExport.name}' already exists (id: ${existingModule.id}), exporting backup before replacement...`);
    installationSnapshots = await getInstallationsForModule(client, existingModule.id);
    const exported = await client.module.moduleControllerExport(existingModule.id);
    backupModuleExport = exported.data.data as TakaroModuleExport;
    await client.module.moduleControllerRemove(existingModule.id);
    console.error(`Removed existing module ${existingModule.id}`);
  }

  try {
    await client.module.moduleControllerImport(moduleExport);
    const found = await findExactModuleByName(client, moduleExport.name);
    if (!found) {
      throw new Error(`Module '${moduleExport.name}' not found after import`);
    }

    await reinstallSnapshotsOnModule(client, found, installationSnapshots);
    console.error(`Successfully imported module '${found.name}' (id: ${found.id})`);
    return found;
  } catch (err) {
    if (!backupModuleExport) {
      throw err;
    }

    try {
      const importedReplacement = await findExactModuleByName(client, moduleExport.name);
      if (importedReplacement) {
        await client.module.moduleControllerRemove(importedReplacement.id);
      }
      await client.module.moduleControllerImport(backupModuleExport);
      const restored = await findExactModuleByName(client, moduleExport.name);
      if (!restored) {
        throw new Error(`Module '${moduleExport.name}' not found after restore`);
      }
      await reinstallSnapshotsOnModule(client, restored, installationSnapshots);
      console.error(`Restored previous module '${moduleExport.name}' from backup after import failure`);
    } catch (restoreErr) {
      throw new Error(
        `Import of '${moduleExport.name}' failed and automatic restore also failed. Import error: ${err}. Restore error: ${restoreErr}`,
      );
    }

    throw new Error(`Import of '${moduleExport.name}' failed, but the previous module was restored. Cause: ${err}`);
  }
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
  const result = await takaroTokenRequest<SearchResponse<{ gameserverId: string; userConfig: unknown; systemConfig: unknown }>>(
    auth,
    '/module/installation/search',
    {
      body: { filters: { moduleId: [moduleId] }, limit: 100 },
    },
  );

  return result.data.map((installation) => ({
    gameServerId: installation.gameserverId,
    userConfig: installation.userConfig,
    systemConfig: installation.systemConfig,
  }));
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

async function importModuleExportWithToken(auth: TakaroAuthConfig, moduleExport: TakaroModuleExport): Promise<ModuleOutputDTO> {
  if (!auth.token) {
    throw new Error('TAKARO_TOKEN is required for token-only module imports');
  }

  const tokenAuth = {
    url: auth.url,
    domainId: auth.domainId,
    token: auth.token,
  };

  const existingModule = await findExactModuleByNameWithToken(tokenAuth, moduleExport.name);
  let backupModuleExport: TakaroModuleExport | null = null;
  let installationSnapshots: InstallationSnapshot[] = [];

  if (existingModule) {
    console.error(`Module '${moduleExport.name}' already exists (id: ${existingModule.id}), exporting backup before replacement...`);
    installationSnapshots = await getInstallationsForModuleWithToken(tokenAuth, existingModule.id);
    const exported = await takaroTokenRequest<ExportResponse<TakaroModuleExport>>(
      tokenAuth,
      `/module/${existingModule.id}/export`,
      { body: {} },
    );
    backupModuleExport = exported.data;
    await takaroTokenRequest(tokenAuth, `/module/${existingModule.id}`, { method: 'DELETE' });
    console.error(`Removed existing module ${existingModule.id}`);
  }

  try {
    await takaroTokenRequest(tokenAuth, '/module/import', { body: moduleExport });
    const found = await findExactModuleByNameWithToken(tokenAuth, moduleExport.name);
    if (!found) {
      throw new Error(`Module '${moduleExport.name}' not found after import`);
    }

    await reinstallSnapshotsOnModuleWithToken(tokenAuth, found, installationSnapshots);
    console.error(`Successfully imported module '${found.name}' (id: ${found.id})`);
    return found;
  } catch (err) {
    if (!backupModuleExport) {
      throw err;
    }

    try {
      const importedReplacement = await findExactModuleByNameWithToken(tokenAuth, moduleExport.name);
      if (importedReplacement) {
        await takaroTokenRequest(tokenAuth, `/module/${importedReplacement.id}`, { method: 'DELETE' });
      }
      await takaroTokenRequest(tokenAuth, '/module/import', { body: backupModuleExport });
      const restored = await findExactModuleByNameWithToken(tokenAuth, moduleExport.name);
      if (!restored) {
        throw new Error(`Module '${moduleExport.name}' not found after restore`);
      }
      await reinstallSnapshotsOnModuleWithToken(tokenAuth, restored, installationSnapshots);
      console.error(`Restored previous module '${moduleExport.name}' from backup after import failure`);
    } catch (restoreErr) {
      throw new Error(
        `Import of '${moduleExport.name}' failed and automatic restore also failed. Import error: ${err}. Restore error: ${restoreErr}`,
      );
    }

    throw new Error(`Import of '${moduleExport.name}' failed, but the previous module was restored. Cause: ${err}`);
  }
}

export async function importModuleExportFile(jsonFile: string): Promise<ModuleOutputDTO> {
  const auth = getTakaroAuthConfig();
  const moduleExport = readModuleExport(jsonFile);

  if (auth.token && !auth.username && !auth.password) {
    return await importModuleExportWithToken(auth, moduleExport);
  }

  const { client, canLogin } = createTakaroClient(auth);
  return await withOptionalLoginRetry(client, canLogin, auth.domainId, async () => importModuleExport(client, moduleExport));
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
