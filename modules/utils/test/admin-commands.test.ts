import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
import {
  UTILS_DEBUG_FORCE_BAN_API_FAILURE_KEY,
  UTILS_DEBUG_FORCE_GIVECURRENCY_API_FAILURE_KEY,
  UTILS_DEBUG_FORCE_KICK_API_FAILURE_KEY,
} from '../src/functions/utils-debug-keys.js';

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

    try {
      await client.command.commandControllerTrigger(ctx.gameServer.id, { msg, playerId });
    } catch (err) {
      const responseData = (err as { response?: { data?: unknown } })?.response?.data;
      const rawMessages = Array.isArray(responseData)
        ? responseData
        : [responseData];
      const logs = rawMessages
        .flatMap((entry) => {
          if (!entry) return [];
          if (typeof entry === 'string') return [entry];
          if (typeof entry === 'object' && entry !== null) {
            const message = (entry as { message?: unknown }).message;
            if (typeof message === 'string') return [message];
          }
          return [String(entry)];
        })
        .filter(Boolean);

      return {
        success: false,
        logs: logs.length > 0 ? logs : [String((err as Error).message ?? err)],
      };
    }

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

  async function setDebugFlag(key: string) {
    await client.variable.variableControllerCreate({
      key,
      value: JSON.stringify(true),
      gameServerId: ctx.gameServer.id,
      moduleId,
    });
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

  it('rejects /givecurrency with a friendly message when economy support is disabled', async () => {
    const target = ctx.players[1];
    const targetName = await getPlayerName(target.playerId);

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'false',
    });

    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency ${targetName} 5`);

    assert.equal(res.success, false, 'Expected /givecurrency to fail cleanly when economy support is disabled');
    assert.ok(res.logs.some((msg) => msg.includes('Currency is not available on this game server.')), JSON.stringify(res.logs));

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });
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
    assert.ok(
      res.logs.some((msg) => msg.includes('Please specify a valid player to receive currency.'))
        || res.logs.some((msg) => msg.includes('No player found with the name or ID')),
      JSON.stringify(res.logs),
    );
    assert.ok(!res.logs.some((msg) => msg.includes('positive whole number')), JSON.stringify(res.logs));
  });

  it('rejects /givecurrency when the player exists globally but is not online on this server', async () => {
    const otherServerPlayerName = await getPlayerName(otherCtx.players[0].playerId);
    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency ${otherServerPlayerName} 5`);

    assert.equal(res.success, false, 'Expected /givecurrency to reject a player from another server');
    assert.ok(res.logs.some((msg) => msg.includes('not currently online')), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes(`Gave 5 currency to ${otherServerPlayerName}.`)), JSON.stringify(res.logs));
  });

  it('prioritizes the offline-target error over the economy-disabled error for /givecurrency', async () => {
    const otherServerPlayerName = await getPlayerName(otherCtx.players[0].playerId);

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'false',
    });

    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency ${otherServerPlayerName} 5`);

    assert.equal(res.success, false, 'Expected /givecurrency to fail when the target is on another server');
    assert.ok(res.logs.some((msg) => msg.includes('not currently online')), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes('Currency is not available on this game server.')), JSON.stringify(res.logs));

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });
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

  it('surfaces the generic /givecurrency API failure message when the currency call fails for a non-economy reason', async () => {
    const targetName = await getPlayerName(ctx.players[1].playerId);
    await setDebugFlag(UTILS_DEBUG_FORCE_GIVECURRENCY_API_FAILURE_KEY);

    const res = await trigger(ctx.players[0].playerId, `${prefix}givecurrency ${targetName} 5`);

    assert.equal(res.success, false, 'Expected forced /givecurrency API failure to be translated');
    assert.ok(res.logs.some((msg) => msg.includes('utils:givecurrency failed')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes('game server API returned an error')), JSON.stringify(res.logs));
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
    assert.ok(
      res.logs.some((msg) => msg.includes('Please specify a valid player to ban.'))
        || res.logs.some((msg) => msg.includes('No player found with the name or ID')),
      JSON.stringify(res.logs),
    );
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

  it('preserves multi-word /ban reasons when the admin targets by player ID', async () => {
    const target = ctx.players[1];
    const reason = 'repeat xray abuse';
    await clearBans(target.playerId);

    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${target.playerId} 10m ${reason}`);

    assert.equal(res.success, true, `Expected ID-targeted /ban to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes(`Reason: ${reason}`)), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes(target.playerId) && msg.includes(`Reason: ${reason}`)), JSON.stringify(res.logs));

    await clearBans(target.playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);
  });

  it('allows banning an offline player that Takaro can still resolve', async () => {
    const target = otherCtx.players[2];
    const targetName = await getPlayerName(target.playerId);
    await clearBans(target.playerId);
    await otherCtx.server.executeConsoleCommand('disconnectAll');

    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} 10m offline test`);

    assert.equal(res.success, true, `Expected offline /ban to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes(`Banned ${targetName} for 10 minutes. Reason: offline test`)), JSON.stringify(res.logs));

    const bans = await getBans(target.playerId);
    assert.ok(bans.length > 0, `Expected a ban record for offline player, got: ${JSON.stringify(bans)}`);

    await clearBans(target.playerId);
    await otherCtx.server.executeConsoleCommand('connectAll');
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

  it('accepts the permanent alias and supported temporary duration units', async () => {
    const target = ctx.players[2];
    const targetName = await getPlayerName(target.playerId);

    for (const [token, fragment] of [
      ['permanent', 'Banned by an admin.'],
      ['12h', '12 hours'],
      ['7d', '7 days'],
      ['2w', '2 weeks'],
    ] as const) {
      await clearBans(target.playerId);
      const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} ${token}`);

      assert.equal(res.success, true, `Expected /ban ${token} to succeed, logs: ${JSON.stringify(res.logs)}`);
      assert.ok(res.logs.some((msg) => msg.includes(fragment)), JSON.stringify(res.logs));
    }

    await clearBans(target.playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);
  });

  it('surfaces the generic /ban API failure message when the ban creation call fails', async () => {
    const targetName = await getPlayerName(ctx.players[1].playerId);
    await setDebugFlag(UTILS_DEBUG_FORCE_BAN_API_FAILURE_KEY);

    const res = await trigger(ctx.players[0].playerId, `${prefix}ban ${targetName} 10m debug failure`);

    assert.equal(res.success, false, 'Expected forced /ban API failure to be translated');
    assert.ok(res.logs.some((msg) => msg.includes('utils:ban failed')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes('ban could not be created right now')), JSON.stringify(res.logs));
  });

  it('denies self /kick', async () => {
    const self = ctx.players[0];
    const selfName = await getPlayerName(self.playerId);
    const res = await trigger(self.playerId, `${prefix}kick ${selfName}`);

    assert.equal(res.success, false, 'Expected self kick to fail');
    assert.ok(res.logs.some((msg) => msg.includes('cannot use this command on yourself')), JSON.stringify(res.logs));
  });

  it('rejects invalid /kick targets with a friendly player-resolution error', async () => {
    const res = await trigger(ctx.players[0].playerId, `${prefix}kick definitely-not-a-real-player-name`);

    assert.equal(res.success, false, 'Expected /kick with an invalid player to fail');
    assert.ok(res.logs.some((msg) => msg.includes('not currently online')), JSON.stringify(res.logs));
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

  it('preserves multi-word /kick reasons when the admin targets by player ID', async () => {
    const target = ctx.players[1];
    const reason = 'breaking spawn rules again';
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(target.playerId, true);

    const res = await trigger(ctx.players[0].playerId, `${prefix}kick ${target.playerId} ${reason}`);

    assert.equal(res.success, true, `Expected ID-targeted /kick to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes(`reason=${reason}`)), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes(`Reason: ${reason}`)), JSON.stringify(res.logs));
    assert.ok(!res.logs.some((msg) => msg.includes(target.playerId) && msg.includes(`Reason: ${reason}`)), JSON.stringify(res.logs));

    const pog = await waitForOnline(target.playerId, false);
    assert.equal(pog?.online, false, 'Expected target to be offline after ID-targeted kick');
  });

  it('surfaces the generic /kick API failure message when the kick call fails', async () => {
    const targetName = await getPlayerName(ctx.players[1].playerId);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnline(ctx.players[1].playerId, true);
    await setDebugFlag(UTILS_DEBUG_FORCE_KICK_API_FAILURE_KEY);

    const res = await trigger(ctx.players[0].playerId, `${prefix}kick ${targetName} debug failure`);

    assert.equal(res.success, false, 'Expected forced /kick API failure to be translated');
    assert.ok(res.logs.some((msg) => msg.includes('utils:kick failed')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes('could not be kicked right now')), JSON.stringify(res.logs));
  });
});

describe('test helper: pushModule rollback', () => {
  let client: Client;
  let ctx: MockServerContext;
  let restoredModuleId: string | undefined;
  let tempModuleDir: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);
  });

  after(async () => {
    if (restoredModuleId) {
      try {
        await uninstallModule(client, restoredModuleId, ctx.gameServer.id);
      } catch {
        // Best-effort cleanup only.
      }
      await deleteModule(client, restoredModuleId);
    }
    if (tempModuleDir) {
      await rm(tempModuleDir, { recursive: true, force: true });
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('restores the previous module, installation, and module state when a replacement import fails', async () => {
    const original = await pushModule(client, MODULE_DIR);
    restoredModuleId = original.id;

    await installModule(client, original.latestVersion.id, ctx.gameServer.id, {
      userConfig: {
        discordLink: 'https://discord.gg/rollback-check',
      },
    });

    await client.variable.variableControllerCreate({
      key: '__rollback_marker',
      value: JSON.stringify({ ok: true }),
      gameServerId: ctx.gameServer.id,
      moduleId: original.id,
    });

    const originalSearch = await client.module.moduleControllerSearch({
      filters: { name: ['utils'] },
    });
    const originalRecord = originalSearch.data.data.find((module) => module.name === 'utils') as (Record<string, any> | undefined);
    assert.ok(originalRecord, `Expected original utils module, got: ${JSON.stringify(originalSearch.data.data)}`);

    tempModuleDir = await mkdtemp(path.join(os.tmpdir(), 'utils-rollback-'));
    await cp(MODULE_DIR, tempModuleDir, { recursive: true });

    const originalImport = client.module.moduleControllerImport.bind(client.module);
    let importCallCount = 0;
    client.module.moduleControllerImport = (async (...args: Parameters<typeof originalImport>) => {
      importCallCount += 1;
      if (importCallCount === 1) {
        throw new Error('synthetic replacement import failure');
      }
      return originalImport(...args);
    }) as typeof client.module.moduleControllerImport;

    try {
      await assert.rejects(
        pushModule(client, tempModuleDir),
        /previous module was restored|failed|synthetic replacement import failure/i,
      );
    } finally {
      client.module.moduleControllerImport = originalImport;
    }

    const searchResult = await client.module.moduleControllerSearch({
      filters: { name: ['utils'] },
    });
    const restored = searchResult.data.data.find((module) => module.name === 'utils') as (Record<string, any> | undefined);

    assert.ok(restored, `Expected restored utils module, got: ${JSON.stringify(searchResult.data.data)}`);
    assert.equal(restored.description, originalRecord.description, 'Expected rollback to restore the original module metadata');
    restoredModuleId = restored.id;
    const restoredModuleIdValue = String(restored.id);

    const installations = await client.module.moduleInstallationsControllerGetInstalledModules({
      filters: {
        moduleId: [restoredModuleIdValue],
        gameserverId: [ctx.gameServer.id],
      },
      limit: 10,
    });
    assert.equal(installations.data.data.length, 1, `Expected restored module installation, got: ${JSON.stringify(installations.data.data)}`);
    assert.equal(
      (installations.data.data[0].userConfig as Record<string, unknown>)?.discordLink,
      'https://discord.gg/rollback-check',
      `Expected restored installation config, got: ${JSON.stringify(installations.data.data[0])}`,
    );

    const variables = await client.variable.variableControllerSearch({
      filters: {
        moduleId: [restoredModuleIdValue],
        gameServerId: [ctx.gameServer.id],
        key: ['__rollback_marker'],
      },
      limit: 10,
    });
    assert.equal(variables.data.data.length, 1, `Expected restored module variable, got: ${JSON.stringify(variables.data.data)}`);
    assert.equal(variables.data.data[0].value, JSON.stringify({ ok: true }));

    const prefix = await getCommandPrefix(client, ctx.gameServer.id);
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}discord`,
      playerId: ctx.players[0].playerId,
    });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((entry) => entry.msg);
    assert.equal(meta?.result?.success, true, `Expected restored installation to execute commands, logs: ${JSON.stringify(logs)}`);
    assert.ok(logs.some((msg) => msg.includes('https://discord.gg/rollback-check')), JSON.stringify(logs));
  });
});

describe('test helper: pushModule successful replacement migration', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string | undefined;
  let tempModuleDir: string | undefined;
  let adminRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);
  });

  after(async () => {
    await cleanupRole(client, adminRoleId);
    if (moduleId) {
      try {
        await uninstallModule(client, moduleId, ctx.gameServer.id);
      } catch {
        // Best-effort cleanup only.
      }
      await deleteModule(client, moduleId);
    }
    if (tempModuleDir) {
      await rm(tempModuleDir, { recursive: true, force: true });
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('preserves installations, module variables, and permission-bearing roles on successful replacement', async () => {
    const original = await pushModule(client, MODULE_DIR);
    moduleId = original.id;

    await installModule(client, original.latestVersion.id, ctx.gameServer.id, {
      userConfig: {
        discordLink: 'https://discord.gg/migration-check',
      },
    });

    adminRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['UTILS_KICK']);

    await client.variable.variableControllerCreate({
      key: '__migration_server_marker',
      value: JSON.stringify({ scope: 'server' }),
      gameServerId: ctx.gameServer.id,
      moduleId: original.id,
    });
    await client.variable.variableControllerCreate({
      key: '__migration_global_marker',
      value: JSON.stringify({ scope: 'global' }),
      moduleId: original.id,
    });
    await client.variable.variableControllerCreate({
      key: '__migration_player_marker',
      value: JSON.stringify({ scope: 'player' }),
      playerId: ctx.players[1].playerId,
      moduleId: original.id,
    });

    tempModuleDir = await mkdtemp(path.join(os.tmpdir(), 'utils-migration-'));
    await cp(MODULE_DIR, tempModuleDir, { recursive: true });

    const moduleJsonPath = path.join(tempModuleDir, 'module.json');
    const moduleJson = JSON.parse(await readFile(moduleJsonPath, 'utf8')) as Record<string, any>;
    moduleJson.description = 'Replacement migration smoke test';
    await writeFile(moduleJsonPath, `${JSON.stringify(moduleJson, null, 2)}\n`);

    const replaced = await pushModule(client, tempModuleDir);
    moduleId = replaced.id;

    const installations = await client.module.moduleInstallationsControllerGetInstalledModules({
      filters: {
        moduleId: [replaced.id],
        gameserverId: [ctx.gameServer.id],
      },
      limit: 10,
    });
    assert.equal(installations.data.data.length, 1, `Expected preserved installation after replacement, got: ${JSON.stringify(installations.data.data)}`);
    assert.equal(
      (installations.data.data[0].userConfig as Record<string, unknown>)?.discordLink,
      'https://discord.gg/migration-check',
      `Expected preserved installation config after replacement, got: ${JSON.stringify(installations.data.data[0])}`,
    );

    const serverScopedVariables = await client.variable.variableControllerSearch({
      filters: {
        moduleId: [replaced.id],
        gameServerId: [ctx.gameServer.id],
        key: ['__migration_server_marker'],
      },
      limit: 10,
    });
    assert.equal(serverScopedVariables.data.data.length, 1, `Expected preserved server-scoped variable, got: ${JSON.stringify(serverScopedVariables.data.data)}`);

    const globalVariables = await client.variable.variableControllerSearch({
      filters: {
        moduleId: [replaced.id],
        key: ['__migration_global_marker'],
      },
      limit: 10,
    });
    assert.equal(globalVariables.data.data.length, 1, `Expected preserved global variable, got: ${JSON.stringify(globalVariables.data.data)}`);
    assert.ok(
      globalVariables.data.data[0].gameServerId == null,
      `Expected global variable to remain unbound, got: ${JSON.stringify(globalVariables.data.data[0])}`,
    );

    const playerScopedVariables = await client.variable.variableControllerSearch({
      filters: {
        moduleId: [replaced.id],
        playerId: [ctx.players[1].playerId],
        key: ['__migration_player_marker'],
      },
      limit: 10,
    });
    assert.equal(playerScopedVariables.data.data.length, 1, `Expected preserved player-scoped variable, got: ${JSON.stringify(playerScopedVariables.data.data)}`);
    assert.equal(playerScopedVariables.data.data[0].playerId, ctx.players[1].playerId);

    const prefix = await getCommandPrefix(client, ctx.gameServer.id);
    const targetName = (await client.player.playerControllerGetOne(ctx.players[1].playerId)).data.data.name;
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}kick ${targetName} migration check`,
      playerId: ctx.players[0].playerId,
    });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((entry) => entry.msg);
    assert.equal(meta?.result?.success, true, `Expected preserved role permissions to keep /kick working after replacement, logs: ${JSON.stringify(logs)}`);
    assert.ok(logs.some((msg) => msg.includes('Kicked')), JSON.stringify(logs));
  });

  it('drops transient debug flags and live lock variables during replacement', async () => {
    const original = await pushModule(client, MODULE_DIR);
    moduleId = original.id;

    await client.variable.variableControllerCreate({
      key: '__debug_force_givecurrency_api_failure',
      value: JSON.stringify(true),
      gameServerId: ctx.gameServer.id,
      moduleId: original.id,
    });
    await client.variable.variableControllerCreate({
      key: 'fund_state_lock',
      value: JSON.stringify({ owner: 'stale-test-lock' }),
      gameServerId: ctx.gameServer.id,
      moduleId: original.id,
    });

    tempModuleDir = await mkdtemp(path.join(os.tmpdir(), 'utils-transient-migration-'));
    await cp(MODULE_DIR, tempModuleDir, { recursive: true });

    const replaced = await pushModule(client, tempModuleDir);
    moduleId = replaced.id;

    const transientVariables = await client.variable.variableControllerSearch({
      filters: {
        moduleId: [replaced.id],
        gameServerId: [ctx.gameServer.id],
        key: ['__debug_force_givecurrency_api_failure', 'fund_state_lock'],
      },
      limit: 10,
    });

    assert.equal(
      transientVariables.data.data.length,
      0,
      `Expected debug flags and live locks to be dropped during replacement, got: ${JSON.stringify(transientVariables.data.data)}`,
    );
  });

  it('keeps role rebinding working when the replacement removes a previously assigned permission', async () => {
    await cleanupRole(client, adminRoleId);
    adminRoleId = undefined;

    const original = await pushModule(client, MODULE_DIR);
    moduleId = original.id;
    adminRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['UTILS_KICK', 'UTILS_BAN']);

    tempModuleDir = await mkdtemp(path.join(os.tmpdir(), 'utils-permission-migration-'));
    await cp(MODULE_DIR, tempModuleDir, { recursive: true });

    const moduleJsonPath = path.join(tempModuleDir, 'module.json');
    const moduleJson = JSON.parse(await readFile(moduleJsonPath, 'utf8')) as Record<string, any>;
    moduleJson.permissions = moduleJson.permissions.filter((permission: { permission: string }) => permission.permission !== 'UTILS_KICK');
    await writeFile(moduleJsonPath, `${JSON.stringify(moduleJson, null, 2)}\n`);

    const replaced = await pushModule(client, tempModuleDir);
    moduleId = replaced.id;

    const roles = await client.role.roleControllerSearch({ limit: 250 });
    const reboundRole = roles.data.data.find((role) => role.id === adminRoleId);
    assert.ok(reboundRole, `Expected assigned role ${adminRoleId} to survive replacement, got: ${JSON.stringify(roles.data.data)}`);

    const reboundPermissionCodes = reboundRole?.permissions.map((entry) => entry.permission.permission) ?? [];
    assert.ok(reboundPermissionCodes.includes('UTILS_BAN'), JSON.stringify(reboundPermissionCodes));
    assert.ok(!reboundPermissionCodes.includes('UTILS_KICK'), JSON.stringify(reboundPermissionCodes));
  });
});
