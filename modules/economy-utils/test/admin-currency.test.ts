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

// player[0] has ECONOMY_UTILS_MANAGE_CURRENCY permission; player[1] does NOT

describe('economy-utils: /grantcurrency and /revokecurrency commands', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let manageRoleId: string;
  let player0Name: string;
  let player1Name: string;

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

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        pendingAmount: 0,
        zombieKillReward: 1,
        transferTax: 0,
        maxTransferAmount: 0,
        showBalanceOnLogin: false,
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    manageRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['ECONOMY_UTILS_MANAGE_CURRENCY'],
    );

    // Look up player names for use in command messages
    const [p0data, p1data] = await Promise.all([
      client.player.playerControllerGetOne(ctx.players[0].playerId),
      client.player.playerControllerGetOne(ctx.players[1].playerId),
    ]);
    player0Name = p0data.data.data.name;
    player1Name = p1data.data.data.name;
  });

  after(async () => {
    await cleanupRole(client, manageRoleId);
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

  it('should grant currency to a player with permission', async () => {
    const granter = ctx.players[0]!;
    const target = ctx.players[1]!;

    // Check balance before grant
    const balanceBefore = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [target.playerId] },
    }).then((r) => r.data.data[0]?.currency ?? 0);

    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}grantcurrency ${player1Name} 200`,
      playerId: granter.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected grantcurrency to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('successfully added')),
      `Expected "successfully added" in log, got: ${JSON.stringify(logMessages)}`,
    );

    // Verify balance increased by exactly 200
    const balanceAfter = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [target.playerId] },
    }).then((r) => r.data.data[0]?.currency ?? 0);
    assert.equal(balanceAfter, balanceBefore + 200, `Balance should increase by 200. Before: ${balanceBefore}, After: ${balanceAfter}`);
  });

  it('should deny grantcurrency to player without permission', async () => {
    const player = ctx.players[1]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}grantcurrency ${player0Name} 100`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'Expected grantcurrency to fail without permission');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('do not have permission')),
      `Expected permission denied, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should revoke currency from a player with permission', async () => {
    const revoker = ctx.players[0]!;
    const target = ctx.players[1]!;
    // player[1] has currency from the grant test

    // Check balance before revoke
    const balanceBefore = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [target.playerId] },
    }).then((r) => r.data.data[0]?.currency ?? 0);

    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}revokecurrency ${player1Name} 50`,
      playerId: revoker.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected revokecurrency to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('successfully deducted')),
      `Expected "successfully deducted" in log, got: ${JSON.stringify(logMessages)}`,
    );

    // Verify balance decreased by exactly 50
    const balanceAfter = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [target.playerId] },
    }).then((r) => r.data.data[0]?.currency ?? 0);
    assert.equal(balanceAfter, balanceBefore - 50, `Balance should decrease by 50. Before: ${balanceBefore}, After: ${balanceAfter}`);
  });

  it('should deny revokecurrency to player without permission', async () => {
    const player = ctx.players[1]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}revokecurrency ${player0Name} 10`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'Expected revokecurrency to fail without permission');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('do not have permission')),
      `Expected permission denied, got: ${JSON.stringify(logMessages)}`,
    );
  });
});
