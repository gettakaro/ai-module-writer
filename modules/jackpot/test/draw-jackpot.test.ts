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

describe('jackpot: draw-jackpot cronjob', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;
  let prefix: string;
  let buyRoleId: string;
  let buy2RoleId: string;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    // Enable economy
    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        ticketPrice: 10,
        profitMargin: 0.1,
        maxTicketsPerPlayer: 100,
        minimumParticipants: 2,
        announceTicketPurchases: false,
        rolloverOnCancel: false,
      },
      // Set command cost=ticketPrice so the system auto-deducts 1x ticketPrice.
      // The handler deducts only (amount-1)*ticketPrice additional.
      systemConfig: {
        commands: {
          'buy-ticket': {
            cost: 10,
          },
        },
      },
    });

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected at least one cronjob in jackpot module');
    cronjobId = cronjob.id;

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    // Assign JACKPOT_BUY permission to player[0] and player[1]
    buyRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['JACKPOT_BUY'],
    );
    buy2RoleId = await assignPermissions(
      client,
      ctx.players[1].playerId,
      ctx.gameServer.id,
      ['JACKPOT_BUY'],
    );

    // Give both players currency
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 500 },
    );
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[1].playerId,
      { currency: 500 },
    );
  });

  after(async () => {
    await cleanupRole(client, buyRoleId);
    await cleanupRole(client, buy2RoleId);
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

  async function triggerDraw(): Promise<{ success: boolean; logs: string[] }> {
    const before = new Date();

    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId,
      moduleId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const success = meta?.result?.success ?? false;
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);

    // Give Takaro time to fully commit variable updates before next operation reads them
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return { success, logs };
  }

  it('should cancel draw and refund exact ticket price when not enough participants', async () => {
    // Only player[0] has bought a ticket — need 2 participants, have 1
    const buyBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 1`,
      playerId: ctx.players[0].playerId,
    });
    await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: buyBefore,
      timeout: 30000,
    });

    // Record player[0]'s currency before the draw/refund
    const pogBefore = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[0].playerId] },
    });
    const currencyBeforeRefund = pogBefore.data.data[0]?.currency ?? 0;

    // Trigger the draw — should cancel since only 1 participant (need 2)
    const { success, logs } = await triggerDraw();

    assert.equal(success, true, `Expected draw cronjob to succeed (even on cancel), logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('cancelling draw')),
      `Expected cancellation log, got: ${JSON.stringify(logs)}`,
    );

    // Player should have been refunded exactly 10 (1 ticket * 10 price)
    const pogAfter = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[0].playerId] },
    });
    const currencyAfterRefund = pogAfter.data.data[0]?.currency ?? 0;
    assert.equal(
      currencyAfterRefund,
      currencyBeforeRefund + 10,
      `Expected player currency to increase by exactly 10 (refund). Before: ${currencyBeforeRefund}, After: ${currencyAfterRefund}`,
    );
  });

  it('should run draw and award winner exact prize when enough participants', async () => {
    // Both player[0] and player[1] buy tickets
    // player[0] buys 2 tickets, player[1] buys 1 ticket
    // pot = 3 * 10 = 30, prize = floor(30 * 0.9) = 27
    const buy0Before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 2`,
      playerId: ctx.players[0].playerId,
    });
    await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: buy0Before,
      timeout: 30000,
    });

    const buy1Before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 1`,
      playerId: ctx.players[1].playerId,
    });
    await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: buy1Before,
      timeout: 30000,
    });

    // Record currencies before draw
    const pog0Before = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[0].playerId] },
    });
    const pog1Before = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[1].playerId] },
    });
    const currency0Before = pog0Before.data.data[0]?.currency ?? 0;
    const currency1Before = pog1Before.data.data[0]?.currency ?? 0;

    // Trigger the draw
    const { success, logs } = await triggerDraw();

    assert.equal(success, true, `Expected draw to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('jackpot-cron: winner=')),
      `Expected winner selection log, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((msg) => msg.includes('drawNumber=')),
      `Expected drawNumber increment log, got: ${JSON.stringify(logs)}`,
    );

    // Verify one of the players received exactly the expected prize
    // pot = player[0] paid 2*10=20 (auto 10 + additional 10) + player[1] paid 1*10=10 (auto 10) = 30
    // prize = floor(30 * 0.9) = 27
    const expectedPrize = 27;

    const pog0After = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[0].playerId] },
    });
    const pog1After = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[1].playerId] },
    });
    const currency0After = pog0After.data.data[0]?.currency ?? 0;
    const currency1After = pog1After.data.data[0]?.currency ?? 0;

    const player0Gain = currency0After - currency0Before;
    const player1Gain = currency1After - currency1Before;

    const player0Won = player0Gain === expectedPrize;
    const player1Won = player1Gain === expectedPrize;

    assert.ok(
      player0Won || player1Won,
      `Expected one player to receive exact prize of ${expectedPrize}. Player0 gain: ${player0Gain}, Player1 gain: ${player1Gain}`,
    );
    // Only one player should have won
    assert.ok(
      !(player0Won && player1Won),
      `Expected only one winner, but both players gained ${expectedPrize}`,
    );
  });
});

