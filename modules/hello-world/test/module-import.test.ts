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

    const result = await client.module.moduleControllerSearch({ filters: { name: [MODULE_NAME] } });
    const existing = result.data.data.find((mod) => mod.name === MODULE_NAME);
    if (existing) {
      await deleteModule(client, existing.id);
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

  async function searchExactModule(): Promise<{ id: string; name: string } | null> {
    const result = await client.module.moduleControllerSearch({ filters: { name: [MODULE_NAME] } });
    return (result.data.data.find((mod) => mod.name === MODULE_NAME) as { id: string; name: string } | undefined) ?? null;
  }

  async function getExportedName(moduleId: string): Promise<string | undefined> {
    const exported = await client.module.moduleControllerExport(moduleId);
    return (exported.data.data as { name?: string }).name;
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
