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

export async function importModuleExport(
  client: Client,
  moduleExport: TakaroModuleExport,
): Promise<ModuleOutputDTO> {
  const existingModule = await findExactModuleByName(client, moduleExport.name);
  let backupModuleExport: TakaroModuleExport | null = null;

  if (existingModule) {
    console.error(`Module '${moduleExport.name}' already exists (id: ${existingModule.id}), exporting backup before replacement...`);
    const exported = await client.module.moduleControllerExport(existingModule.id);
    backupModuleExport = exported.data.data as TakaroModuleExport;
    await client.module.moduleControllerRemove(existingModule.id);
    console.error(`Removed existing module ${existingModule.id}`);
  }

  try {
    await client.module.moduleControllerImport(moduleExport);
  } catch (err) {
    if (!backupModuleExport) {
      throw err;
    }

    try {
      await client.module.moduleControllerImport(backupModuleExport);
      console.error(`Restored previous module '${moduleExport.name}' from backup after import failure`);
    } catch (restoreErr) {
      throw new Error(
        `Import of '${moduleExport.name}' failed and automatic restore also failed. Import error: ${err}. Restore error: ${restoreErr}`,
      );
    }

    throw new Error(`Import of '${moduleExport.name}' failed, but the previous module was restored. Cause: ${err}`);
  }

  const found = await findExactModuleByName(client, moduleExport.name);
  if (!found) {
    throw new Error(`Module '${moduleExport.name}' not found after import`);
  }

  console.error(`Successfully imported module '${found.name}' (id: ${found.id})`);
  return found;
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

async function importModuleExportWithToken(auth: TakaroAuthConfig, moduleExport: TakaroModuleExport): Promise<ModuleOutputDTO> {
  if (!auth.token) {
    throw new Error('TAKARO_TOKEN is required for token-only module imports');
  }

  const tokenAuth = {
    url: auth.url,
    domainId: auth.domainId,
    token: auth.token,
  };

  const searchExisting = await takaroTokenRequest<SearchResponse<ModuleOutputDTO>>(tokenAuth, '/module/search', {
    body: { filters: { name: [moduleExport.name] } },
  });
  const existingModule = searchExisting.data.find((mod) => mod.name === moduleExport.name) ?? null;
  let backupModuleExport: TakaroModuleExport | null = null;

  if (existingModule) {
    console.error(`Module '${moduleExport.name}' already exists (id: ${existingModule.id}), exporting backup before replacement...`);
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
  } catch (err) {
    if (!backupModuleExport) {
      throw err;
    }

    try {
      await takaroTokenRequest(tokenAuth, '/module/import', { body: backupModuleExport });
      console.error(`Restored previous module '${moduleExport.name}' from backup after import failure`);
    } catch (restoreErr) {
      throw new Error(
        `Import of '${moduleExport.name}' failed and automatic restore also failed. Import error: ${err}. Restore error: ${restoreErr}`,
      );
    }

    throw new Error(`Import of '${moduleExport.name}' failed, but the previous module was restored. Cause: ${err}`);
  }

  const searchImported = await takaroTokenRequest<SearchResponse<ModuleOutputDTO>>(tokenAuth, '/module/search', {
    body: { filters: { name: [moduleExport.name] } },
  });
  const found = searchImported.data.find((mod) => mod.name === moduleExport.name) ?? null;
  if (!found) {
    throw new Error(`Module '${moduleExport.name}' not found after import`);
  }

  console.error(`Successfully imported module '${found.name}' (id: ${found.id})`);
  return found;
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
