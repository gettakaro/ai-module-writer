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
import { cleanupTestModules, deleteModule } from '../../../test/helpers/modules.js';
import { getTakaroAuthConfig, REPO_ROOT } from '../../../src/scripts/module-import.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
const MODULE_TO_JSON_SCRIPT = path.join(REPO_ROOT, 'dist', 'scripts', 'module-to-json.js');
const MODULE_IMPORT_SCRIPT = path.join(REPO_ROOT, 'dist', 'scripts', 'module-import.js');
const MODULE_NAME = 'test-hello-world';

describe('module-import CLI', () => {
  let client: Client;
  let moduleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
  });

  after(async () => {
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
