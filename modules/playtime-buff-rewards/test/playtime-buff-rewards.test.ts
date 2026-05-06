import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { startMockServer, stopMockServer, MockServerContext } from '../../../test/helpers/mock-server.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import {
  pushModule,
  installModule,
  uninstallModule,
  deleteModule,
  getCommandPrefix,
  cleanupTestModules,
  cleanupTestGameServers,
  assignPermissions,
  cleanupRole,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

type ExecutionMeta = { result?: { success?: boolean; logs?: Array<{ msg: string }> } };

async function fetchPlayerName(client: Client, playerId: string): Promise<string> {
  const result = await client.player.playerControllerGetOne(playerId);
  return result.data.data.name;
}

describe('playtime-buff-rewards', () => {
  let client: Client;
  let ctx: MockServerContext | undefined;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;
  let prefix: string;
  let adminRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected grant-playtime-rewards cronjob');
    cronjobId = cronjob.id;

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    assert.ok(ctx.players[0], 'Expected at least one mock player');
  });

  after(async () => {
    await cleanupRole(client, adminRoleId);
    if (!ctx) return;
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (_err) {
      // Ignore cleanup races.
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function installWithBuffConfig(): Promise<void> {
    await installModule(client, versionId, ctx!.gameServer.id, {
      userConfig: {
        buffCommandTemplate: 'buffplayer {playerName} {buffName}',
        announceRewards: false,
        buffRewards: [
          {
            buffName: 'CustomerBuff',
            weight: 1,
            enabled: true,
          },
        ],
        commandRewards: [],
        currencyRewards: [],
      },
    });
  }

  async function installWithCommandRewardConfig(): Promise<void> {
    await installModule(client, versionId, ctx!.gameServer.id, {
      userConfig: {
        announceRewards: false,
        buffRewards: [],
        commandRewards: [
          {
            name: 'Coffee and meds pack',
            command: 'give {playerName} coffee 3',
            weight: 1,
            enabled: true,
          },
        ],
        currencyRewards: [],
      },
    });
  }

  async function triggerCronjob(): Promise<{ success: boolean; logs: string[] }> {
    const before = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx!.gameServer.id,
      cronjobId,
      moduleId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx!.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as ExecutionMeta;
    const success = meta?.result?.success ?? false;
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    return { success, logs };
  }

  async function triggerCommand(message: string, playerId: string): Promise<{ success: boolean; logs: string[] }> {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx!.gameServer.id, {
      msg: `${prefix}${message}`,
      playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx!.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as ExecutionMeta;
    const success = meta?.result?.success ?? false;
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    return { success, logs };
  }

  it('hourly playtime cron grants configured buff rewards through the game command', async () => {
    await installWithBuffConfig();
    try {
      const { success, logs } = await triggerCronjob();

      assert.equal(success, true, `Expected cronjob success, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some((msg) => msg.includes('buffplayer') && msg.includes('CustomerBuff')),
        `Expected buff command in logs, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      await uninstallModule(client, moduleId, ctx!.gameServer.id);
    }
  });

  it('hourly playtime cron grants generic item-style rewards through game commands, not shop actions', async () => {
    await installWithCommandRewardConfig();
    try {
      const playerName = await fetchPlayerName(client, ctx!.players[0].playerId);
      const { success, logs } = await triggerCronjob();

      assert.equal(success, true, `Expected cronjob success, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some((msg) => msg.includes(`give ${playerName} coffee 3`)),
        `Expected generic reward to execute a game command for ${playerName}, got: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        !logs.some((msg) => msg.toLowerCase().includes('shop')),
        `Expected generic reward path to avoid shop actions, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      await uninstallModule(client, moduleId, ctx!.gameServer.id);
    }
  });

  it('grantbuff admin command executes the configured buff command', async () => {
    await installWithBuffConfig();
    try {
      adminRoleId = await assignPermissions(
        client,
        ctx!.players[0].playerId,
        ctx!.gameServer.id,
        ['PLAYTIME_BUFF_ADMIN'],
      );
      const targetName = await fetchPlayerName(client, ctx!.players[0].playerId);
      const { success, logs } = await triggerCommand(`grantbuff ${targetName} ManualBuff`, ctx!.players[0].playerId);

      assert.equal(success, true, `Expected grantbuff success, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some((msg) => msg.includes('buffplayer') && msg.includes('ManualBuff')),
        `Expected manual buff command in logs, got: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        logs.some((msg) => msg.includes(`buffplayer ${targetName} ManualBuff`)),
        `Expected manual buff command to use target name ${targetName}, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      await cleanupRole(client, adminRoleId);
      adminRoleId = undefined;
      await uninstallModule(client, moduleId, ctx!.gameServer.id);
    }
  });
});
