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
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

// NOTE: Tests in this suite are intentionally sequential and order-dependent.
// The 'should complete transfer after confirmtransfer' test relies on the pending transfer
// created by the 'should prompt for confirmation' test. This is an accepted pattern for
// expensive integration test setups where recreating state per test would be prohibitively slow.
describe('economy-utils: /transfer with pendingAmount confirmation', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let receiverName: string;

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

    // Install with pending amount of 100 (transfers >= 100 require confirmation)
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        pendingAmount: 100,
        zombieKillReward: 1,
        transferTax: 0,
        maxTransferAmount: 0,
        showBalanceOnLogin: false,
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    // Give player[0] starting currency
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 500 },
    );

    // Look up player[1]'s name for use in command messages
    const player1Data = await client.player.playerControllerGetOne(ctx.players[1].playerId);
    receiverName = player1Data.data.data.name;
  });

  after(async () => {
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

  it('should prompt for confirmation when amount >= pendingAmount', async () => {
    const sender = ctx.players[0]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}transfer ${receiverName} 100`,
      playerId: sender.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected pending confirmation to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('confirmtransfer') || msg.includes('confirm')),
      `Expected confirmation prompt, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should fail confirmtransfer when no pending transfer exists', async () => {
    // player[1] has no pending transfer
    const player = ctx.players[1]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}confirmtransfer`,
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
    assert.equal(meta?.result?.success, false, 'Expected confirmtransfer to fail with no pending transfer');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('no pending transfer')),
      `Expected no pending transfer error, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should complete transfer after confirmtransfer with correct balances', async () => {
    // player[0] already has a pending transfer from the first test
    const sender = ctx.players[0]!;
    const receiver = ctx.players[1]!;

    // Get balances before confirming
    const [senderBefore, receiverBefore] = await Promise.all([
      client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], playerId: [sender.playerId] },
      }).then((r) => r.data.data[0]?.currency ?? 0),
      client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], playerId: [receiver.playerId] },
      }).then((r) => r.data.data[0]?.currency ?? 0),
    ]);

    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}confirmtransfer`,
      playerId: sender.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected confirmtransfer to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('successfully transferred')),
      `Expected successful transfer log, got: ${JSON.stringify(logMessages)}`,
    );

    // Verify exact balances after transfer (no tax configured)
    const [senderAfter, receiverAfter] = await Promise.all([
      client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], playerId: [sender.playerId] },
      }).then((r) => r.data.data[0]?.currency ?? 0),
      client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], playerId: [receiver.playerId] },
      }).then((r) => r.data.data[0]?.currency ?? 0),
    ]);

    assert.equal(senderAfter, senderBefore - 100, `Sender should lose 100. Before: ${senderBefore}, After: ${senderAfter}`);
    assert.equal(receiverAfter, receiverBefore + 100, `Receiver should gain 100. Before: ${receiverBefore}, After: ${receiverAfter}`);
  });
});
