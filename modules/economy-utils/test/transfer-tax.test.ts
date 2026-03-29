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

describe('economy-utils: /transfer with tax', () => {
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

    // Install with 10% transfer tax
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        pendingAmount: 0,
        zombieKillReward: 1,
        transferTax: 0.1,
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

  it('should apply tax during transfer (10% tax on 100 = receiver gets 90)', async () => {
    const sender = ctx.players[0]!;
    const receiver = ctx.players[1]!;

    // Get balances before transfer
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
    assert.equal(meta?.result?.success, true, 'Expected transfer with tax to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('tax') && msg.includes('10') && msg.includes('90')),
      `Expected log to mention tax deduction (10 tax, 90 received), got: ${JSON.stringify(logMessages)}`,
    );

    // Verify exact balances after transfer
    // tax = ceil(100 * 0.1) = 10, receiver gets 90, sender loses 100
    const [senderAfter, receiverAfter] = await Promise.all([
      client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], playerId: [sender.playerId] },
      }).then((r) => r.data.data[0]?.currency ?? 0),
      client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], playerId: [receiver.playerId] },
      }).then((r) => r.data.data[0]?.currency ?? 0),
    ]);

    assert.equal(senderAfter, senderBefore - 100, `Sender should lose 100. Before: ${senderBefore}, After: ${senderAfter}`);
    assert.equal(receiverAfter, receiverBefore + 90, `Receiver should gain 90. Before: ${receiverBefore}, After: ${receiverAfter}`);
  });
});
