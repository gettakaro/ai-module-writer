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

describe('utils: admin commands default no-broadcast behavior', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let adminRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id);
    prefix = await getCommandPrefix(client, ctx.gameServer.id);
    adminRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, [
      'UTILS_KICK',
      'UTILS_BAN',
      'UTILS_GIVE_CURRENCY',
    ]);
  });

  after(async () => {
    await cleanupRole(client, adminRoleId);
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall module:', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function trigger(playerId: string, msg: string) {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, { msg, playerId });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((l) => l.msg),
    };
  }

  async function getPlayerName(playerId: string) {
    const result = await client.player.playerControllerGetOne(playerId);
    return result.data.data.name;
  }

  async function waitForOnline(playerId: string, expectedOnline: boolean) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: {
          gameServerId: [ctx.gameServer.id],
          playerId: [playerId],
        },
      });
      const pog = result.data.data[0];
      if (pog && pog.online === expectedOnline) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for player ${playerId} online=${expectedOnline}`);
  }

  async function clearBans(playerId: string) {
    const bans = await client.player.banControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [playerId],
      },
    });
    for (const ban of bans.data.data) {
      await client.player.banControllerDelete(ban.id);
    }
  }

  it('givecurrency succeeds without broadcasting by default', async () => {
    const targetName = await getPlayerName(ctx.players[1].playerId);
    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency ${targetName} 5`);

    assert.equal(res.success, true, JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Gave 5 currency to ${targetName}.`)), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes(`${targetName} received 5 currency from`)), JSON.stringify(res.logs));
  });

  it('kick succeeds without broadcasting by default', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);

    const res = await trigger(ctx.players[0].playerId, `${prefix}kick ${targetName}`);

    assert.equal(res.success, true, JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Kicked ${targetName}. Reason: Kicked by an admin.`)), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes(`${targetName} was kicked by`)), JSON.stringify(res.logs));
    await waitForOnline(target.playerId, false);
  });

  it('ban succeeds without broadcasting by default', async () => {
    const target = ctx.players[2];
    const targetName = await getPlayerName(target.playerId);
    await clearBans(target.playerId);

    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} 10m testing`);

    assert.equal(res.success, true, JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Banned ${targetName} for 10 minutes. Reason: testing`)), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes(`${targetName} was banned by`)), JSON.stringify(res.logs));

    await clearBans(target.playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);
  });
});

describe('utils: default ban broadcast template with permanent bans', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
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

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        broadcastBans: true,
      },
    });
    prefix = await getCommandPrefix(client, ctx.gameServer.id);
    adminRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['UTILS_BAN']);
  });

  after(async () => {
    await cleanupRole(client, adminRoleId);
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall permanent-ban module:', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete permanent-ban module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function trigger(playerId: string, msg: string) {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, { msg, playerId });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((l) => l.msg),
    };
  }

  it('renders "permanently" with the default broadcast template for permanent bans', async () => {
    const targetName = (await client.player.playerControllerGetOne(ctx.players[1].playerId)).data.data.name;
    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} perm`);

    assert.equal(res.success, true, JSON.stringify(res.logs));
    assert.ok(
      res.logs.some((msg) => msg.includes(`${targetName} was banned by`) && msg.includes('permanently') && msg.includes('Reason: Banned by an admin.')),
      JSON.stringify(res.logs),
    );
  });
});
