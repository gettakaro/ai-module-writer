import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'url';
import { Client } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { cleanupTestGameServers, cleanupTestModules, deleteModule, installModule } from '../../../test/helpers/modules.js';
import { MockServerContext, startMockServer, stopMockServer } from '../../../test/helpers/mock-server.js';
import {
  createTakaroClient,
  getTakaroAuthConfig,
  importModuleExport,
  importModuleExportWithToken,
  REPO_ROOT,
  withOptionalLoginRetry,
} from '../../../src/scripts/module-import.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
const MODULE_TO_JSON_SCRIPT = path.join(REPO_ROOT, 'dist', 'scripts', 'module-to-json.js');
const MODULE_IMPORT_SCRIPT = path.join(REPO_ROOT, 'dist', 'scripts', 'module-import.js');
const MODULE_PUSH_SCRIPT = path.join(REPO_ROOT, 'scripts', 'module-push.sh');
const MODULE_NAME = 'test-hello-world';
const RICH_MODULE_SOURCE_DIR = path.join(REPO_ROOT, 'modules', 'server-messages');
const RICH_MODULE_NAME = 'test-server-messages-shell';

describe('module-import CLI', () => {
  let client: Client;
  let moduleId: string | undefined;
  let mockCtx: MockServerContext | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
  });

  after(async () => {
    if (mockCtx) {
      await stopMockServer(mockCtx.server, client, mockCtx.gameServer.id);
    }

    for (const moduleName of [MODULE_NAME, RICH_MODULE_NAME]) {
      const existing = await searchExactModuleByName(moduleName);
      if (existing) {
        await deleteModule(client, existing.id);
      }
    }
  });

  async function createModuleExport(description: string): Promise<string> {
    const tempFile = path.join(os.tmpdir(), `takaro-module-import-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await execFileAsync(process.execPath, [MODULE_TO_JSON_SCRIPT, MODULE_DIR, tempFile]);
    const moduleExport = JSON.parse(await fs.readFile(tempFile, 'utf8')) as { description?: string };
    moduleExport.description = description;
    await fs.writeFile(tempFile, JSON.stringify(moduleExport, null, 2));
    return tempFile;
  }

  async function searchExactModuleByName(moduleName: string): Promise<{ id: string; name: string } | null> {
    const result = await client.module.moduleControllerSearch({ filters: { name: [moduleName] } });
    return (result.data.data.find((mod) => mod.name === moduleName) as { id: string; name: string } | undefined) ?? null;
  }

  async function searchExactModule(): Promise<{ id: string; name: string } | null> {
    return searchExactModuleByName(MODULE_NAME);
  }

  async function getExportedName(moduleId: string): Promise<string | undefined> {
    const exported = await client.module.moduleControllerExport(moduleId);
    return (exported.data.data as { name?: string }).name;
  }

  async function createRenamedModuleCopy(sourceDir: string, moduleName: string): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takaro-module-copy-'));
    await fs.cp(sourceDir, tempDir, { recursive: true });

    const moduleJsonPath = path.join(tempDir, 'module.json');
    const moduleJson = JSON.parse(await fs.readFile(moduleJsonPath, 'utf8')) as {
      name: string;
      description?: string;
    };
    moduleJson.name = moduleName;
    moduleJson.description = `${moduleJson.description ?? ''} (shell push coverage)`;
    await fs.writeFile(moduleJsonPath, JSON.stringify(moduleJson, null, 2));

    return tempDir;
  }

  it('loads repo .env from outside the repo and accepts token-only auth', async () => {
    const exportFile = await createModuleExport('CLI env/token import');
    const auth = getTakaroAuthConfig();
    const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'takaro-module-import-cwd-'));

    try {
      await execFileAsync(
        process.execPath,
        [MODULE_IMPORT_SCRIPT, exportFile],
        {
          cwd: tempCwd,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TAKARO_TOKEN: client.token ?? '',
            TAKARO_HOST: auth.url,
            TAKARO_DOMAIN_ID: auth.domainId,
            TAKARO_USERNAME: '',
            TAKARO_PASSWORD: '',
          },
        },
      );

      const imported = await searchExactModule();
      assert.ok(imported, 'Expected CLI import to create the module from a non-repo working directory');
      moduleId = imported.id;
      assert.equal(await getExportedName(imported.id), MODULE_NAME);
    } finally {
      await fs.rm(tempCwd, { recursive: true, force: true });
      await fs.rm(exportFile, { force: true });
    }
  });

  it('uses the credentialed client path when username/password are present', async () => {
    const { client: credentialedClient, canLogin } = createTakaroClient({
      url: 'https://example.invalid',
      domainId: 'domain-id',
      username: 'user@example.com',
      password: 'secret',
      token: 'stale-token',
    });

    assert.equal(canLogin, true);
    assert.ok(credentialedClient, 'Expected a client instance for credential auth');
  });

  it('retries once with login after a 401 when credential auth is available', async () => {
    let attempts = 0;
    let loginCalls = 0;
    let domainSetTo: string | undefined;

    const fakeClient = {
      login: async () => {
        loginCalls += 1;
      },
      setDomain: (domainId: string) => {
        domainSetTo = domainId;
      },
    } as unknown as Client;

    const result = await withOptionalLoginRetry(fakeClient, true, 'domain-123', async () => {
      attempts += 1;
      if (attempts === 1) {
        throw { response: { status: 401 } };
      }
      return 'ok';
    });

    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
    assert.equal(loginCalls, 1);
    assert.equal(domainSetTo, 'domain-123');
  });

  it('push script imports a module end-to-end through the documented shell workflow', async () => {
    const auth = getTakaroAuthConfig();
    const tokenOnlyEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TAKARO_TOKEN: client.token ?? '',
      TAKARO_HOST: auth.url,
      TAKARO_DOMAIN_ID: auth.domainId,
      TAKARO_USERNAME: '',
      TAKARO_PASSWORD: '',
    };

    const { stdout } = await execFileAsync('bash', [MODULE_PUSH_SCRIPT, MODULE_DIR], { env: tokenOnlyEnv });
    const parsed = JSON.parse(stdout) as { data?: { id?: string; name?: string } };
    assert.equal(parsed.data?.name, MODULE_NAME);

    const imported = await searchExactModule();
    assert.ok(imported, 'Expected module-push.sh to import the module');
    moduleId = imported.id;
  });

  it('bootstraps cached auth for module-push when only username/password are provided', async () => {
    const auth = getTakaroAuthConfig();
    const tokenFile = '/tmp/takaro-token';
    const originalToken = await fs.readFile(tokenFile, 'utf8').catch(() => null);

    try {
      await fs.rm(tokenFile, { force: true });
      const { stdout } = await execFileAsync('bash', [MODULE_PUSH_SCRIPT, MODULE_DIR], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TAKARO_TOKEN: '',
          TAKARO_HOST: auth.url,
          TAKARO_DOMAIN_ID: auth.domainId,
          TAKARO_USERNAME: auth.username ?? process.env.TAKARO_USERNAME ?? '',
          TAKARO_PASSWORD: auth.password ?? process.env.TAKARO_PASSWORD ?? '',
        },
      });

      const parsed = JSON.parse(stdout) as { data?: { id?: string; name?: string } };
      assert.equal(parsed.data?.name, MODULE_NAME);
      const refreshedToken = await fs.readFile(tokenFile, 'utf8');
      assert.ok(refreshedToken.trim().length > 0, 'Expected module-push auth bootstrap to refresh the cached token file');
    } finally {
      if (originalToken === null) {
        await fs.rm(tokenFile, { force: true });
      } else {
        await fs.writeFile(tokenFile, originalToken);
      }
    }
  });

  it('retries individual replacement requests without restarting the full destructive flow', async () => {
    let loginCalls = 0;
    let removedModuleIds: string[] = [];
    let exportCalls = 0;
    let importCalls = 0;
    let reinstallCalls = 0;
    let searchCalls = 0;
    let domainSetTo: string | undefined;

    const fakeClient = {
      login: async () => {
        loginCalls += 1;
      },
      setDomain: (domainId: string) => {
        domainSetTo = domainId;
      },
      module: {
        moduleControllerSearch: async () => {
          searchCalls += 1;
          if (searchCalls === 1) {
            return { data: { data: [{ id: 'old-module', name: MODULE_NAME, latestVersion: { id: 'old-version' } }] } };
          }
          return { data: { data: [{ id: 'new-module', name: MODULE_NAME, latestVersion: { id: 'new-version' } }] } };
        },
        moduleInstallationsControllerGetInstalledModules: async () => ({
          data: {
            data: [{ gameserverId: 'gs-1', userConfig: { foo: 'bar' }, systemConfig: { cron: true } }],
            meta: { total: 1 },
          },
        }),
        moduleControllerExport: async () => {
          exportCalls += 1;
          return { data: { data: { name: MODULE_NAME, versions: [] } } };
        },
        moduleControllerRemove: async (moduleId: string) => {
          removedModuleIds.push(moduleId);
        },
        moduleControllerImport: async () => {
          importCalls += 1;
          if (importCalls === 1) {
            throw { response: { status: 401 } };
          }
        },
        moduleInstallationsControllerInstallModule: async () => {
          reinstallCalls += 1;
        },
      },
      variable: {
        variableControllerSearch: async () => ({ data: { data: [], meta: { total: 0 } } }),
      },
      role: {
        roleControllerGetPermissions: async () => ({ data: { data: [] } }),
        roleControllerSearch: async () => ({ data: { data: [], meta: { total: 0 } } }),
        roleControllerUpdate: async () => ({ data: { data: {} } }),
      },
    } as unknown as Client;

    const imported = await importModuleExport(
      fakeClient,
      { name: MODULE_NAME, versions: [] } as any,
      { request: (operation) => withOptionalLoginRetry(fakeClient, true, 'domain-123', operation) },
    );

    assert.equal(imported.id, 'new-module');
    assert.equal(loginCalls, 1, 'Expected one credential refresh for the mid-replacement 401');
    assert.equal(domainSetTo, 'domain-123');
    assert.equal(exportCalls, 1, 'Expected the original module to be backed up once');
    assert.deepEqual(removedModuleIds, ['old-module'], 'Expected the original module to be removed only once');
    assert.equal(importCalls, 2, 'Expected the failed import request to be retried once');
    assert.equal(reinstallCalls, 1, 'Expected installations to be restored after the retried import succeeds');
  });

  it('reinstalls every paginated module installation during replacement', async () => {
    const installationCalls: Array<{ page?: number; limit?: number }> = [];
    const reinstalledGameServers: string[] = [];
    let searchCalls = 0;

    const fakeClient = {
      module: {
        moduleControllerSearch: async () => {
          searchCalls += 1;
          if (searchCalls === 1) {
            return { data: { data: [{ id: 'old-module', name: MODULE_NAME, latestVersion: { id: 'old-version' } }] } };
          }
          return { data: { data: [{ id: 'new-module', name: MODULE_NAME, latestVersion: { id: 'new-version' } }] } };
        },
        moduleInstallationsControllerGetInstalledModules: async ({ page = 0, limit }: { page?: number; limit?: number }) => {
          installationCalls.push({ page, limit });
          if (page === 0) {
            return {
              data: {
                data: Array.from({ length: 100 }, (_, index) => ({
                  gameserverId: `gs-${index + 1}`,
                  userConfig: { slot: index + 1 },
                  systemConfig: { nested: true },
                })),
                meta: { total: 125 },
              },
            };
          }

          return {
            data: {
              data: Array.from({ length: 25 }, (_, index) => ({
                gameserverId: `gs-${index + 101}`,
                userConfig: { slot: index + 101 },
                systemConfig: { nested: true },
              })),
              meta: { total: 125 },
            },
          };
        },
        moduleControllerExport: async () => ({ data: { data: { name: MODULE_NAME, versions: [] } } }),
        moduleControllerRemove: async () => {},
        moduleControllerImport: async () => {},
        moduleInstallationsControllerInstallModule: async ({ gameServerId }: { gameServerId: string }) => {
          reinstalledGameServers.push(gameServerId);
        },
      },
      variable: {
        variableControllerSearch: async () => ({ data: { data: [], meta: { total: 0 } } }),
      },
      role: {
        roleControllerGetPermissions: async () => ({ data: { data: [] } }),
        roleControllerSearch: async () => ({ data: { data: [], meta: { total: 0 } } }),
        roleControllerUpdate: async () => ({ data: { data: {} } }),
      },
    } as unknown as Client;

    await importModuleExport(fakeClient, { name: MODULE_NAME, versions: [] } as any);

    assert.deepEqual(
      installationCalls,
      [{ page: 0, limit: 100 }, { page: 1, limit: 100 }],
      'Expected replacement flow to paginate through all module installations',
    );
    assert.equal(reinstalledGameServers.length, 125, 'Expected every paginated installation to be restored');
    assert.equal(reinstalledGameServers[0], 'gs-1');
    assert.equal(reinstalledGameServers.at(-1), 'gs-125');
  });

  it('preserves durable module-scoped variables and role permission assignments across replacement imports', async () => {
    const createdVariables: Array<{ moduleId?: string; key: string; value: string; gameServerId?: string }> = [];
    const updatedRoles: Array<{ roleId: string; permissions: Array<{ permissionId: string; count?: number }> }> = [];
    let searchCalls = 0;

    const fakeClient = {
      module: {
        moduleControllerSearch: async () => {
          searchCalls += 1;
          if (searchCalls === 1) {
            return { data: { data: [{ id: 'old-module', name: MODULE_NAME, latestVersion: { id: 'old-version' } }] } };
          }
          return { data: { data: [{ id: 'new-module', name: MODULE_NAME, latestVersion: { id: 'new-version' } }] } };
        },
        moduleInstallationsControllerGetInstalledModules: async () => ({
          data: {
            data: [{ gameserverId: 'gs-1', userConfig: { foo: 'bar' }, systemConfig: { cron: true } }],
            meta: { total: 1 },
          },
        }),
        moduleControllerExport: async () => ({ data: { data: { name: MODULE_NAME, versions: [] } } }),
        moduleControllerRemove: async () => {},
        moduleControllerImport: async () => {},
        moduleInstallationsControllerInstallModule: async () => ({ data: { data: {} } }),
      },
      variable: {
        variableControllerSearch: async ({ filters }: { filters?: Record<string, string[]> }) => {
          if (filters?.moduleId?.[0] === 'old-module' && !filters.key) {
            return {
              data: {
                data: [
                  {
                    id: 'old-var-1',
                    key: 'server_messages_state',
                    value: '{"sequentialIndex":1}',
                    gameServerId: 'gs-1',
                  },
                  {
                    id: 'old-var-2',
                    key: 'server_messages_lock',
                    value: '{"token":"transient"}',
                    gameServerId: 'gs-1',
                  },
                  {
                    id: 'old-var-3',
                    key: 'server_messages_delivery_receipt',
                    value: '{"messageIndex":0}',
                    gameServerId: 'gs-1',
                  },
                  {
                    id: 'old-var-4',
                    key: 'expired_config_snapshot',
                    value: '{"stale":true}',
                    gameServerId: 'gs-1',
                    expiresAt: '2000-01-01T00:00:00.000Z',
                  },
                ],
                meta: { total: 1 },
              },
            };
          }

          return { data: { data: [], meta: { total: 0 } } };
        },
        variableControllerCreate: async (payload: { moduleId?: string; key: string; value: string; gameServerId?: string }) => {
          createdVariables.push(payload);
          return { data: { data: payload } };
        },
        variableControllerUpdate: async () => ({ data: { data: {} } }),
      },
      role: {
        roleControllerGetPermissions: async () => ({
          data: {
            data: [
              { id: 'old-perm', permission: 'HELLO_USE', module: { id: 'old-module', name: MODULE_NAME } },
              { id: 'other-perm', permission: 'UNRELATED', module: { id: 'other-module', name: 'other' } },
              { id: 'new-perm', permission: 'HELLO_USE', module: { id: 'new-module', name: MODULE_NAME } },
            ],
          },
        }),
        roleControllerSearch: async () => ({
          data: {
            data: [
              {
                id: 'role-1',
                permissions: [
                  { permissionId: 'old-perm', count: 3 },
                  { permissionId: 'other-perm', count: 1 },
                ],
              },
            ],
            meta: { total: 1 },
          },
        }),
        roleControllerUpdate: async (roleId: string, payload: { permissions?: Array<{ permissionId: string; count?: number }> }) => {
          updatedRoles.push({ roleId, permissions: payload.permissions ?? [] });
          return { data: { data: {} } };
        },
      },
    } as unknown as Client;

    await importModuleExport(fakeClient, { name: MODULE_NAME, versions: [] } as any);

    assert.deepEqual(
      createdVariables,
      [
        {
          moduleId: 'new-module',
          key: 'server_messages_state',
          value: '{"sequentialIndex":1}',
          gameServerId: 'gs-1',
          playerId: undefined,
          expiresAt: undefined,
        },
      ],
      'Expected only durable module-scoped variables to migrate to the replacement module id',
    );
    assert.deepEqual(
      updatedRoles,
      [
        {
          roleId: 'role-1',
          permissions: [
            { permissionId: 'new-perm', count: 3 },
            { permissionId: 'other-perm', count: 1 },
          ],
        },
      ],
      'Expected roles to be rebound from deleted permission ids to the replacement module permissions',
    );
  });

  it('reinstalls prior installations again when a replacement import rolls back', async () => {
    const reinstalledVersionIds: string[] = [];
    let searchCalls = 0;
    let importCalls = 0;

    const fakeClient = {
      module: {
        moduleControllerSearch: async () => {
          searchCalls += 1;
          if (searchCalls === 1) {
            return { data: { data: [{ id: 'old-module', name: MODULE_NAME, latestVersion: { id: 'old-version' } }] } };
          }
          if (searchCalls === 2) {
            return { data: { data: [{ id: 'failed-replacement', name: MODULE_NAME, latestVersion: { id: 'new-version' } }] } };
          }
          return { data: { data: [{ id: 'restored-module', name: MODULE_NAME, latestVersion: { id: 'restored-version' } }] } };
        },
        moduleInstallationsControllerGetInstalledModules: async () => ({
          data: {
            data: [{ gameserverId: 'gs-1', userConfig: { foo: 'bar' }, systemConfig: { cron: true } }],
            meta: { total: 1 },
          },
        }),
        moduleControllerExport: async () => ({ data: { data: { name: MODULE_NAME, versions: [] } } }),
        moduleControllerRemove: async () => {},
        moduleControllerImport: async () => {
          importCalls += 1;
          if (importCalls === 1) {
            throw new Error('boom');
          }
        },
        moduleInstallationsControllerInstallModule: async ({ versionId }: { versionId: string }) => {
          reinstalledVersionIds.push(versionId);
          return { data: { data: {} } };
        },
      },
      variable: {
        variableControllerSearch: async () => ({ data: { data: [], meta: { total: 0 } } }),
      },
      role: {
        roleControllerGetPermissions: async () => ({ data: { data: [] } }),
        roleControllerSearch: async () => ({ data: { data: [], meta: { total: 0 } } }),
        roleControllerUpdate: async () => ({ data: { data: {} } }),
      },
    } as unknown as Client;

    await assert.rejects(
      importModuleExport(fakeClient, { name: MODULE_NAME, versions: [] } as any),
      /previous module was restored|Import of/i,
    );

    assert.deepEqual(
      reinstalledVersionIds,
      ['restored-version'],
      'Expected rollback to reinstall the previously-installed game servers onto the restored module version',
    );
  });

  it('push script preserves nested cronjobs, functions, and config schema for richer modules', async () => {
    const auth = getTakaroAuthConfig();
    const tokenOnlyEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TAKARO_TOKEN: client.token ?? '',
      TAKARO_HOST: auth.url,
      TAKARO_DOMAIN_ID: auth.domainId,
      TAKARO_USERNAME: '',
      TAKARO_PASSWORD: '',
    };
    const richModuleDir = await createRenamedModuleCopy(RICH_MODULE_SOURCE_DIR, RICH_MODULE_NAME);

    try {
      const { stdout } = await execFileAsync('bash', [MODULE_PUSH_SCRIPT, richModuleDir], { env: tokenOnlyEnv });
      const parsed = JSON.parse(stdout) as { data?: { id?: string; name?: string } };
      assert.equal(parsed.data?.name, RICH_MODULE_NAME);

      const imported = await searchExactModuleByName(RICH_MODULE_NAME);
      assert.ok(imported, 'Expected module-push.sh to import the richer module fixture');

      const exported = await client.module.moduleControllerExport(imported.id);
      const richExport = exported.data.data as {
        name?: string;
        versions?: Array<{
          configSchema?: unknown;
          cronJobs?: unknown[];
          functions?: unknown[];
        }>;
      };
      const latestVersion = richExport.versions?.[0];

      assert.equal(richExport.name, RICH_MODULE_NAME);
      assert.ok(latestVersion?.configSchema, 'Expected exported module to keep its config schema');
      assert.ok((latestVersion?.cronJobs as unknown[] | undefined)?.length, 'Expected exported module to keep cronjobs');
      assert.ok((latestVersion?.functions as unknown[] | undefined)?.length, 'Expected exported module to keep functions');
    } finally {
      await fs.rm(richModuleDir, { recursive: true, force: true });
    }
  });

  it('replays replacement snapshots through the token-only import path and skips transient variables', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    let searchCalls = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const requestPath = new URL(url).pathname;
      const method = init?.method ?? 'POST';
      const body = typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
      requests.push({ path: requestPath, method, body });

      const json = (payload: unknown) => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      if (requestPath === '/module/search') {
        searchCalls += 1;
        if (searchCalls === 1) {
          return json({ data: [{ id: 'old-module', name: MODULE_NAME, latestVersion: { id: 'old-version' } }] });
        }
        return json({ data: [{ id: 'new-module', name: MODULE_NAME, latestVersion: { id: 'new-version' } }] });
      }

      if (requestPath === '/module/installation/search') {
        return json({
          data: [{ gameserverId: 'gs-1', userConfig: { foo: 'bar' }, systemConfig: { cron: true } }],
          meta: { total: 1 },
        });
      }

      if (requestPath === '/module/old-module/export') {
        return json({ data: { name: MODULE_NAME, versions: [] } });
      }

      if (requestPath === '/module/old-module' && method === 'DELETE') {
        return json({ data: {} });
      }

      if (requestPath === '/module/import') {
        return json({ data: {} });
      }

      if (requestPath === '/variables/search') {
        if (body?.filters?.moduleId?.[0] === 'old-module' && !body?.filters?.key) {
          return json({
            data: [
              { key: 'server_messages_state', value: '{"sequentialIndex":1}', gameServerId: 'gs-1' },
              { key: 'server_messages_lock', value: '{"token":"transient"}', gameServerId: 'gs-1' },
              { key: 'server_messages_delivery_receipt', value: '{"messageIndex":0}', gameServerId: 'gs-1' },
            ],
            meta: { total: 3 },
          });
        }

        return json({ data: [], meta: { total: 0 } });
      }

      if (requestPath === '/variables' && method === 'POST') {
        return json({ data: body });
      }

      if (requestPath === '/permissions' && method === 'GET') {
        return json({
          data: [
            { id: 'old-perm', permission: 'HELLO_USE', module: { id: 'old-module', name: MODULE_NAME } },
            { id: 'new-perm', permission: 'HELLO_USE', module: { id: 'new-module', name: MODULE_NAME } },
          ],
        });
      }

      if (requestPath === '/role/search') {
        return json({
          data: [{ id: 'role-1', permissions: [{ permissionId: 'old-perm', count: 2 }] }],
          meta: { total: 1 },
        });
      }

      if (requestPath === '/role/role-1' && method === 'PUT') {
        return json({ data: {} });
      }

      if (requestPath === '/module/installation/' && method === 'POST') {
        return json({ data: {} });
      }

      throw new Error(`Unexpected fetch request: ${method} ${requestPath}`);
    }) as typeof fetch;

    try {
      await importModuleExportWithToken(
        { url: 'https://takaro.invalid', domainId: 'domain-1', token: 'token-only' },
        { name: MODULE_NAME, versions: [] } as any,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const createdVariableBodies = requests
      .filter((request) => request.path === '/variables' && request.method === 'POST')
      .map((request) => request.body);

    assert.deepEqual(createdVariableBodies, [
      {
        key: 'server_messages_state',
        value: '{"sequentialIndex":1}',
        gameServerId: 'gs-1',
        moduleId: 'new-module',
      },
    ]);
    assert.ok(
      requests.some((request) => request.path === '/module/installation/' && request.method === 'POST'),
      'Expected token-only replacement flow to reinstall prior installations',
    );
    assert.ok(
      requests.some((request) => request.path === '/role/role-1' && request.method === 'PUT'),
      'Expected token-only replacement flow to rebind role permissions',
    );
  });

  it('replays paginated replacement snapshots through the token-only import path', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    let moduleSearchCalls = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const requestPath = new URL(url).pathname;
      const method = init?.method ?? 'POST';
      const body = typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
      requests.push({ path: requestPath, method, body });

      const json = (payload: unknown) => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

      if (requestPath === '/module/search') {
        moduleSearchCalls += 1;
        if (moduleSearchCalls === 1) {
          return json({ data: [{ id: 'old-module', name: MODULE_NAME, latestVersion: { id: 'old-version' } }] });
        }
        return json({ data: [{ id: 'new-module', name: MODULE_NAME, latestVersion: { id: 'new-version' } }] });
      }

      if (requestPath === '/module/installation/search') {
        if (body?.page === 0) {
          return json({
            data: Array.from({ length: 100 }, (_, index) => ({
              gameserverId: `gs-${index + 1}`,
              userConfig: { slot: index + 1 },
              systemConfig: { enabled: true },
            })),
            meta: { total: 101 },
          });
        }
        if (body?.page === 1) {
          return json({
            data: [{ gameserverId: 'gs-101', userConfig: { slot: 101 }, systemConfig: { enabled: true } }],
            meta: { total: 101 },
          });
        }
      }

      if (requestPath === '/module/old-module/export') {
        return json({ data: { name: MODULE_NAME, versions: [] } });
      }

      if (requestPath === '/module/old-module' && method === 'DELETE') {
        return json({ data: {} });
      }

      if (requestPath === '/module/import') {
        return json({ data: {} });
      }

      if (requestPath === '/variables/search') {
        if (body?.filters?.moduleId?.[0] === 'old-module' && !body?.filters?.key) {
          if (body?.page === 0) {
            return json({
              data: Array.from({ length: 100 }, (_, index) => ({
                key: `persistent_${index + 1}`,
                value: JSON.stringify({ index: index + 1 }),
                gameServerId: 'gs-1',
              })),
              meta: { total: 101 },
            });
          }
          if (body?.page === 1) {
            return json({
              data: [{ key: 'persistent_101', value: '{"index":101}', gameServerId: 'gs-1' }],
              meta: { total: 101 },
            });
          }
        }

        return json({ data: [], meta: { total: 0 } });
      }

      if (requestPath === '/variables' && method === 'POST') {
        return json({ data: body });
      }

      if (requestPath === '/permissions' && method === 'GET') {
        return json({
          data: [
            { id: 'old-perm-1', permission: 'HELLO_USE', module: { id: 'old-module', name: MODULE_NAME } },
            { id: 'old-perm-2', permission: 'HELLO_ADMIN', module: { id: 'old-module', name: MODULE_NAME } },
            { id: 'new-perm-1', permission: 'HELLO_USE', module: { id: 'new-module', name: MODULE_NAME } },
            { id: 'new-perm-2', permission: 'HELLO_ADMIN', module: { id: 'new-module', name: MODULE_NAME } },
          ],
        });
      }

      if (requestPath === '/role/search') {
        if (body?.page === 0) {
          return json({
            data: Array.from({ length: 100 }, (_, index) => ({
              id: `role-${index + 1}`,
              permissions: [{ permissionId: 'old-perm-1', count: index + 1 }],
            })),
            meta: { total: 101 },
          });
        }
        if (body?.page === 1) {
          return json({
            data: [{ id: 'role-101', permissions: [{ permissionId: 'old-perm-2', count: 101 }] }],
            meta: { total: 101 },
          });
        }
      }

      if (requestPath.startsWith('/role/') && method === 'PUT') {
        return json({ data: {} });
      }

      if (requestPath === '/module/installation/' && method === 'POST') {
        return json({ data: {} });
      }

      throw new Error(`Unexpected fetch request: ${method} ${requestPath}`);
    }) as typeof fetch;

    try {
      await importModuleExportWithToken(
        { url: 'https://takaro.invalid', domainId: 'domain-1', token: 'token-only' },
        { name: MODULE_NAME, versions: [] } as any,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const installationPosts = requests.filter((request) => request.path === '/module/installation/' && request.method === 'POST');
    const variablePosts = requests.filter((request) => request.path === '/variables' && request.method === 'POST');
    const roleUpdates = requests.filter((request) => request.path.startsWith('/role/') && request.method === 'PUT');

    assert.equal(installationPosts.length, 101, 'Expected token-only import to replay all paginated installations');
    assert.equal(variablePosts.length, 101, 'Expected token-only import to replay all paginated persistent variables');
    assert.equal(roleUpdates.length, 101, 'Expected token-only import to replay all paginated role bindings');
    assert.ok(
      requests.some((request) => request.path === '/module/installation/search' && request.body?.page === 1),
      'Expected token-only import to request the second installations page',
    );
    assert.ok(
      requests.some((request) => request.path === '/variables/search' && request.body?.page === 1),
      'Expected token-only import to request the second variables page',
    );
    assert.ok(
      requests.some((request) => request.path === '/role/search' && request.body?.page === 1),
      'Expected token-only import to request the second roles page',
    );
  });

  it('surfaces HTTP status and raw response text for non-JSON token-only failures', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => new Response('<html>unauthorized</html>', {
      status: 401,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;

    try {
      await assert.rejects(
        importModuleExportWithToken(
          { url: 'https://takaro.invalid', domainId: 'domain-1', token: 'token-only' },
          { name: MODULE_NAME, versions: [] } as any,
        ),
        /401|unauthorized/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces structured rollback errors with readable messages', async () => {
    const fakeClient = {
      module: {
        moduleControllerSearch: async () => ({ data: { data: [{ id: 'old-module', name: MODULE_NAME, latestVersion: { id: 'old-version' } }] } }),
        moduleInstallationsControllerGetInstalledModules: async () => ({ data: { data: [], meta: { total: 0 } } }),
        moduleControllerExport: async () => ({ data: { data: { name: MODULE_NAME, versions: [] } } }),
        moduleControllerRemove: async () => {},
        moduleControllerImport: async () => {
          throw { response: { data: { meta: { error: { message: 'replacement exploded' } } } } };
        },
      },
      variable: {
        variableControllerSearch: async () => ({ data: { data: [], meta: { total: 0 } } }),
      },
      role: {
        roleControllerGetPermissions: async () => ({ data: { data: [] } }),
        roleControllerSearch: async () => ({ data: { data: [], meta: { total: 0 } } }),
        roleControllerUpdate: async () => ({ data: { data: {} } }),
      },
    } as unknown as Client;

    await assert.rejects(
      importModuleExport(fakeClient, { name: MODULE_NAME, versions: [] } as any),
      /replacement exploded/,
    );
  });

  it('fails fast with actionable module.json errors for missing module metadata', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takaro-module-push-empty-'));

    try {
      await assert.rejects(
        execFileAsync('bash', [MODULE_PUSH_SCRIPT, emptyDir], {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          },
        }),
        /Missing module metadata file|module\.json/i,
      );
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('fails fast with actionable module.json errors for invalid module metadata', async () => {
    const badDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takaro-module-push-bad-'));
    await fs.writeFile(path.join(badDir, 'module.json'), '{"name": ');

    try {
      await assert.rejects(
        execFileAsync('bash', [MODULE_PUSH_SCRIPT, badDir], {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          },
        }),
        /Invalid module metadata|module\.json must be valid JSON/i,
      );
    } finally {
      await fs.rm(badDir, { recursive: true, force: true });
    }
  });

  it('imports end-to-end through the username/password auth path', async () => {
    const exportFile = await createModuleExport('CLI credential import');
    const auth = getTakaroAuthConfig();

    try {
      await execFileAsync(process.execPath, [MODULE_IMPORT_SCRIPT, exportFile], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TAKARO_TOKEN: '',
          TAKARO_HOST: auth.url,
          TAKARO_DOMAIN_ID: auth.domainId,
          TAKARO_USERNAME: auth.username ?? process.env.TAKARO_USERNAME ?? '',
          TAKARO_PASSWORD: auth.password ?? process.env.TAKARO_PASSWORD ?? '',
        },
      });

      const imported = await searchExactModule();
      assert.ok(imported, 'Expected username/password CLI import to create the module');
      moduleId = imported.id;
    } finally {
      await fs.rm(exportFile, { force: true });
    }
  });

  it('preserves live installations across replacement imports', async () => {
    const auth = getTakaroAuthConfig();
    const tokenOnlyEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TAKARO_TOKEN: client.token ?? '',
      TAKARO_HOST: auth.url,
      TAKARO_DOMAIN_ID: auth.domainId,
      TAKARO_USERNAME: '',
      TAKARO_PASSWORD: '',
    };
    const updatedExport = await createModuleExport('Updated while keeping installation');
    mockCtx = await startMockServer(client);

    try {
      await execFileAsync('bash', [MODULE_PUSH_SCRIPT, MODULE_DIR], { env: tokenOnlyEnv });
      const baselineModule = await searchExactModule();
      assert.ok(baselineModule, 'Expected baseline module import before installation migration test');
      moduleId = baselineModule.id;

      const baselineDetails = await client.module.moduleControllerGetOne(baselineModule.id);
      await installModule(client, baselineDetails.data.data.latestVersion.id, mockCtx.gameServer.id);

      await execFileAsync(process.execPath, [MODULE_IMPORT_SCRIPT, updatedExport], { env: tokenOnlyEnv });
      const replacementModule = await searchExactModule();
      assert.ok(replacementModule, 'Expected replacement module after re-import');
      moduleId = replacementModule.id;

      const installations = await client.module.moduleInstallationsControllerGetInstalledModules({
        filters: {
          moduleId: [replacementModule.id],
          gameserverId: [mockCtx.gameServer.id],
        },
      });

      assert.equal(installations.data.data.length, 1, 'Expected re-imported module to stay installed on the same game server');
    } finally {
      await fs.rm(updatedExport, { force: true });
      if (mockCtx) {
        await stopMockServer(mockCtx.server, client, mockCtx.gameServer.id);
        mockCtx = undefined;
      }
    }
  });

  it('restores the previous module when a replacement import fails', async () => {
    const goodExport = await createModuleExport('Rollback baseline');
    const badExport = path.join(os.tmpdir(), `takaro-module-import-bad-${Date.now()}.json`);
    const auth = getTakaroAuthConfig();
    const tokenOnlyEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TAKARO_TOKEN: client.token ?? '',
      TAKARO_HOST: auth.url,
      TAKARO_DOMAIN_ID: auth.domainId,
      TAKARO_USERNAME: '',
      TAKARO_PASSWORD: '',
    };

    try {
      await execFileAsync(process.execPath, [MODULE_IMPORT_SCRIPT, goodExport], { env: tokenOnlyEnv });
      const baseline = await searchExactModule();
      assert.ok(baseline, 'Expected baseline import to succeed');
      moduleId = baseline.id;

      await fs.writeFile(
        badExport,
        JSON.stringify({
          name: MODULE_NAME,
          versions: 'definitely-not-a-valid-module-export',
        }),
      );

      await assert.rejects(
        execFileAsync(process.execPath, [MODULE_IMPORT_SCRIPT, badExport], { env: tokenOnlyEnv }),
        /previous module was restored|automatic restore also failed|Import of/i,
      );

      const afterFailure = await searchExactModule();
      assert.ok(afterFailure, 'Expected previous module to remain after failed replacement import');
      moduleId = afterFailure.id;
      assert.equal(await getExportedName(afterFailure.id), MODULE_NAME);
    } finally {
      await fs.rm(goodExport, { force: true });
      await fs.rm(badExport, { force: true });
    }
  });
});
