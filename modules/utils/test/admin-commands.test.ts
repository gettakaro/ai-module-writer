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

describe('utils: admin commands', () => {
  let client: Client;
  let ctx: MockServerContext;
  let otherCtx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let adminRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);
    otherCtx = await startMockServer(client);

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        broadcastCurrencyGrants: true,
        currencyGrantBroadcastMessage: '{player} received {amount} currency from {admin}.',
        broadcastKicks: true,
        kickBroadcastMessage: '{player} was kicked by {admin}. Reason: {reason}',
        broadcastBans: true,
        banBroadcastMessage: '{player} was banned by {admin} for {duration}. Reason: {reason}',
      },
    });

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
    await stopMockServer(otherCtx.server, client, otherCtx.gameServer.id);
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

  async function getPog(playerId: string) {
    const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [playerId],
      },
    });
    return result.data.data[0];
  }

  async function getPlayerName(playerId: string) {
    const result = await client.player.playerControllerGetOne(playerId);
    return result.data.data.name;
  }

  async function waitForOnline(playerId: string, expectedOnline: boolean) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const pog = await getPog(playerId);
      if (pog && pog.online === expectedOnline) return pog;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for player ${playerId} online=${expectedOnline}`);
  }

  async function getBans(playerId: string) {
    const bans = await client.player.banControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [playerId],
      },
      sortBy: 'createdAt',
      sortDirection: 'desc',
    });
    return bans.data.data;
  }

  async function clearBans(playerId: string) {
    const bans = await getBans(playerId);
    for (const ban of bans) {
      await client.player.banControllerDelete(ban.id);
    }
  }

  it('denies /kick without permission', async () => {
    const targetName = await getPlayerName(ctx.players[1].playerId);
    const res = await trigger(ctx.players[1].playerId, `${prefix}kick ${targetName}`);

    assert.equal(res.success, false, 'Expected /kick to fail without permission');
    assert.ok(res.logs.some((msg) => msg.includes('do not have permission')), JSON.stringify(res.logs));
  });

  it('denies /ban without permission', async () => {
    const targetName = await getPlayerName(ctx.players[0].playerId);
    const res = await trigger(ctx.players[1].playerId, `${prefix}ban ${targetName} 10m`);

    assert.equal(res.success, false, 'Expected /ban to fail without permission');
    assert.ok(res.logs.some((msg) => msg.includes('do not have permission')), JSON.stringify(res.logs));
  });

  it('denies /givecurrency without permission', async () => {
    const targetName = await getPlayerName(ctx.players[0].playerId);
    const res = await trigger(ctx.players[1].playerId, `${prefix}givecurrency ${targetName} 5`);

    assert.equal(res.success, false, 'Expected /givecurrency to fail without permission');
    assert.ok(res.logs.some((msg) => msg.includes('do not have permission')), JSON.stringify(res.logs));
  });

  it('allows /givecurrency for admins and broadcasts success', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    const beforePog = await getPog(target.playerId);
    assert.ok(beforePog, 'Expected target POG to exist');
    const beforeCurrency = beforePog?.currency ?? 0;

    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency ${targetName} 25`);

    assert.equal(res.success, true, `Expected /givecurrency to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes('utils:givecurrency')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Gave 25 currency to ${targetName}.`)), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`${targetName} received 25 currency`)), JSON.stringify(res.logs));

    const afterPog = await getPog(target.playerId);
    assert.ok(afterPog, 'Expected target POG to exist after command');
    assert.equal(afterPog?.currency, beforeCurrency + 25, 'Expected currency to increase by 25');
  });

  it('rejects invalid /givecurrency amounts', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency ${targetName} 0`);

    assert.equal(res.success, false, 'Expected /givecurrency 0 to fail');
    assert.ok(res.logs.some((msg) => msg.includes('positive whole number')), JSON.stringify(res.logs));
  });

  it('rejects invalid /givecurrency targets with a player-resolution error, not an amount error', async () => {
    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency definitely-not-a-real-player-name 5`);

    assert.equal(res.success, false, 'Expected /givecurrency with an invalid player to fail');
    assert.ok(res.logs.some((msg) => msg.includes('No player found with the name or ID')), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes('positive whole number')), JSON.stringify(res.logs));
  });

  it('rejects /givecurrency when the player exists globally but is not online on this server', async () => {
    const otherServerPlayerName = await getPlayerName(otherCtx.players[0].playerId);
    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency ${otherServerPlayerName} 5`);

    assert.equal(res.success, false, 'Expected /givecurrency to reject a player from another server');
    assert.ok(res.logs.some((msg) => msg.includes('not currently online')), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes(`Gave 5 currency to ${otherServerPlayerName}.`)), JSON.stringify(res.logs));
  });

  it('allows self /givecurrency', async () => {
    const self = ctx.players[0];
    const selfName = await getPlayerName(self.playerId);
    const beforePog = await getPog(self.playerId);
    assert.ok(beforePog, 'Expected self POG to exist');
    const beforeCurrency = beforePog?.currency ?? 0;

    const res = await trigger(self.playerId, `${prefix}givecurrency ${selfName} 7`);

    assert.equal(res.success, true, `Expected self /givecurrency to succeed, logs: ${JSON.stringify(res.logs)}`);

    const afterPog = await getPog(self.playerId);
    assert.ok(afterPog, 'Expected self POG to exist after self grant');
    assert.equal(afterPog?.currency, beforeCurrency + 7, 'Expected self currency to increase by 7');
  });

  it('rejects invalid /ban duration', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} nonsense`);

    assert.equal(res.success, false, 'Expected invalid duration to fail');
    assert.ok(res.logs.some((msg) => msg.includes('Invalid duration.')), JSON.stringify(res.logs));
  });

  it('rejects invalid /ban targets with a friendly player-resolution error', async () => {
    const res = await trigger(ctx.players[0].playerId, `${prefix}ban definitely-not-a-real-player-name 10m`);

    assert.equal(res.success, false, 'Expected /ban with an invalid player to fail');
    assert.ok(res.logs.some((msg) => msg.includes('No player found with the name or ID')), JSON.stringify(res.logs));
  });

  it('rejects oversized /ban durations with the friendly validation message', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} 999999999999999999999w`);

    assert.equal(res.success, false, 'Expected oversized duration to fail');
    assert.ok(res.logs.some((msg) => msg.includes('Invalid duration.')), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes('Invalid time value')), JSON.stringify(res.logs));
  });

  it('denies self /ban', async () => {
    const self = ctx.players[0];
    const selfName = await getPlayerName(self.playerId);
    const res = await trigger(self.playerId, `${prefix}ban ${selfName} 10m`);

    assert.equal(res.success, false, 'Expected self ban to fail');
    assert.ok(res.logs.some((msg) => msg.includes('cannot use this command on yourself')), JSON.stringify(res.logs));
  });

  it('creates a temporary ban with a human-readable confirmation and broadcast', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    await clearBans(target.playerId);

    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} 10m griefing`);

    assert.equal(res.success, true, `Expected temporary ban to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes('utils:ban result=')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes('reason=griefing')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Banned ${targetName} for 10 minutes. Reason: griefing`)), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`${targetName} was banned`) && msg.includes('10 minutes')), JSON.stringify(res.logs));

    assert.ok(
      res.logs.some((msg) => msg.includes('utils:ban payload=') && msg.includes('"reason":"griefing"') && msg.includes('"expiresAt":"')),
      JSON.stringify(res.logs),
    );

    await clearBans(target.playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);
  });

  it('preserves multi-word /ban reasons when reconstructing the fallback reason text', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    const reason = 'spawn camping again';
    await clearBans(target.playerId);

    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} 10m ${reason}`);

    assert.equal(res.success, true, `Expected multi-word /ban to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes(`Reason: ${reason}`)), JSON.stringify(res.logs));

    assert.ok(
      res.logs.some((msg) => msg.includes('utils:ban payload=') && msg.includes(`"reason":"${reason}"`)),
      JSON.stringify(res.logs),
    );

    await clearBans(target.playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);
  });

  it('creates a permanent ban when using perm', async () => {
    const target = ctx.players[2];
    const targetName = await getPlayerName(target.playerId);
    await clearBans(target.playerId);

    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} perm`);

    assert.equal(res.success, true, `Expected permanent ban to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes('utils:ban result=')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Banned ${targetName} permanently. Reason: Banned by an admin.`)), JSON.stringify(res.logs));

    assert.ok(
      res.logs.some((msg) => msg.includes('utils:ban payload=') && msg.includes('"reason":"Banned by an admin."') && !msg.includes('expiresAt')),
      JSON.stringify(res.logs),
    );

    await clearBans(target.playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);
  });

  it('denies self /kick', async () => {
    const self = ctx.players[0];
    const selfName = await getPlayerName(self.playerId);
    const res = await trigger(self.playerId, `${prefix}kick ${selfName}`);

    assert.equal(res.success, false, 'Expected self kick to fail');
    assert.ok(res.logs.some((msg) => msg.includes('cannot use this command on yourself')), JSON.stringify(res.logs));
  });

  it('rejects /kick when the player exists globally but is not online on this server', async () => {
    const otherServerPlayerName = await getPlayerName(otherCtx.players[1].playerId);
    const res = await trigger(ctx.players[0].playerId, `${prefix}kick ${otherServerPlayerName}`);

    assert.equal(res.success, false, 'Expected /kick to reject a player from another server');
    assert.ok(res.logs.some((msg) => msg.includes('not currently online')), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes(`Kicked ${otherServerPlayerName}.`)), JSON.stringify(res.logs));
  });

  it('kicks an online player, confirms success, and broadcasts when enabled', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);

    const res = await trigger(ctx.players[0].playerId, `${prefix}kick ${targetName}`);

    assert.equal(res.success, true, `Expected /kick to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes('utils:kick')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Kicked ${targetName}. Reason: Kicked by an admin.`)), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`${targetName} was kicked`) && msg.includes('Kicked by an admin.')), JSON.stringify(res.logs));

    const pog = await waitForOnline(target.playerId, false);
    assert.equal(pog?.online, false, 'Expected target to be offline after kick');
  });

  it('preserves multi-word /kick reasons when reconstructing the fallback reason text', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);
    const reason = 'repeated base griefing';
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);

    const res = await trigger(ctx.players[0].playerId, `${prefix}kick ${targetName} ${reason}`);

    assert.equal(res.success, true, `Expected multi-word /kick to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes(`reason=${reason}`)), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Reason: ${reason}`)), JSON.stringify(res.logs));

    const pog = await waitForOnline(target.playerId, false);
    assert.equal(pog?.online, false, 'Expected target to be offline after multi-word kick');
  });
});
