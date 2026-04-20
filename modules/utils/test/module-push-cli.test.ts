import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { startMockServer, stopMockServer, MockServerContext } from '../../../test/helpers/mock-server.js';
import {
  assignPermissions,
  cleanupRole,
  cleanupTestGameServers,
  cleanupTestModules,
  deleteModule,
  installModule,
  uninstallModule,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_DIR = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'module-push.sh');

interface PushedModuleResult {
  data: {
    id: string;
    name: string;
    latestVersion: {
      id: string;
    };
  };
}

function runModulePush(moduleDir: string): PushedModuleResult {
  const stdout = execFileSync('bash', [SCRIPT_PATH, moduleDir], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
  });

  return JSON.parse(stdout) as PushedModuleResult;
}

describe('module-push CLI', () => {
  let client: Client;
  let ctx: MockServerContext;
  let tempModuleDir: string | undefined;
  let moduleId: string | undefined;
  let roleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);
  });

  after(async () => {
    await cleanupRole(client, roleId);
    if (moduleId) {
      try {
        await uninstallModule(client, moduleId, ctx.gameServer.id);
      } catch {
        // Best effort cleanup only.
      }
      await deleteModule(client, moduleId);
    }
    if (tempModuleDir) {
      await rm(tempModuleDir, { recursive: true, force: true });
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('preserves installations, variables, and roles when invoked through scripts/module-push.sh', async () => {
    tempModuleDir = await mkdtemp(path.join(os.tmpdir(), 'module-push-cli-'));
    await cp(MODULE_DIR, tempModuleDir, { recursive: true });

    const moduleJsonPath = path.join(tempModuleDir, 'module.json');
    const moduleJson = JSON.parse(await readFile(moduleJsonPath, 'utf8')) as Record<string, any>;
    moduleJson.name = `test-utils-cli-${Date.now()}`;
    moduleJson.description = 'CLI push smoke test (first import)';
    await writeFile(moduleJsonPath, `${JSON.stringify(moduleJson, null, 2)}\n`);

    const firstPush = runModulePush(tempModuleDir);
    moduleId = firstPush.data.id;

    await installModule(client, firstPush.data.latestVersion.id, ctx.gameServer.id, {
      userConfig: {
        discordLink: 'https://discord.gg/cli-push-smoke',
      },
    });

    await client.variable.variableControllerCreate({
      key: '__cli_push_preserved',
      value: JSON.stringify({ ok: true }),
      gameServerId: ctx.gameServer.id,
      moduleId,
    });

    roleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['UTILS_KICK']);

    moduleJson.description = 'CLI push smoke test (replacement import)';
    await writeFile(moduleJsonPath, `${JSON.stringify(moduleJson, null, 2)}\n`);

    const secondPush = runModulePush(tempModuleDir);
    moduleId = secondPush.data.id;

    const installations = await client.module.moduleInstallationsControllerGetInstalledModules({
      filters: {
        moduleId: [moduleId],
        gameserverId: [ctx.gameServer.id],
      },
      limit: 10,
    });
    assert.equal(installations.data.data.length, 1, JSON.stringify(installations.data.data));
    assert.equal(
      (installations.data.data[0].userConfig as Record<string, unknown>)?.discordLink,
      'https://discord.gg/cli-push-smoke',
      JSON.stringify(installations.data.data[0]),
    );

    const variables = await client.variable.variableControllerSearch({
      filters: {
        moduleId: [moduleId],
        gameServerId: [ctx.gameServer.id],
        key: ['__cli_push_preserved'],
      },
      limit: 10,
    });
    assert.equal(variables.data.data.length, 1, JSON.stringify(variables.data.data));

    const reboundRole = (await client.role.roleControllerGetOne(roleId!)).data.data;
    const permissionCodes = reboundRole.permissions.map((entry) => entry.permission.permission);
    assert.ok(permissionCodes.includes('UTILS_KICK'), JSON.stringify(permissionCodes));
  });

  it('fails fast with a clear protected-name error when a built-in exact-name module collision exists', async (t) => {
    const existing = await client.module.moduleControllerSearch({ filters: { name: ['utils'] }, limit: 20 });
    if (!existing.data.data.some((module) => module.name === 'utils')) {
      t.skip('This Takaro environment does not expose a built-in utils module to collide with.');
      return;
    }

    const protectedDir = await mkdtemp(path.join(os.tmpdir(), 'module-push-cli-protected-'));
    try {
      await cp(MODULE_DIR, protectedDir, { recursive: true });
      const moduleJsonPath = path.join(protectedDir, 'module.json');
      const moduleJson = JSON.parse(await readFile(moduleJsonPath, 'utf8')) as Record<string, any>;
      moduleJson.name = 'utils';
      await writeFile(moduleJsonPath, `${JSON.stringify(moduleJson, null, 2)}\n`);

      await assert.rejects(
        async () => execFileSync('bash', [SCRIPT_PATH, protectedDir], {
          cwd: REPO_ROOT,
          env: process.env,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 180_000,
        }),
        (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
          const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
          assert.match(output, /protected module\(s\) with that exact name|Use a unique local development name/i);
          return true;
        },
      );
    } finally {
      await rm(protectedDir, { recursive: true, force: true });
    }
  });
});
