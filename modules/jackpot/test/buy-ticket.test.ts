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

// NOTE: Tests in this suite run sequentially and share jackpot state across all cases.
// player[0] has JACKPOT_BUY; player[1] does NOT. Ticket price=10, maxTicketsPerPlayer=5.
// Command cost auto-deducts 1x ticketPrice; handler deducts (amount-1)*ticketPrice additional.

describe('jackpot: /buyticket command', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let buyRoleId: string;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    // Enable economy for currency operations
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
        maxTicketsPerPlayer: 5,
        minimumParticipants: 2,
        announceTicketPurchases: false,
        rolloverOnCancel: false,
      },
      // Set command cost=ticketPrice so the system auto-deducts 1x ticketPrice.
      // The handler then deducts only (amount-1)*ticketPrice to avoid double-charging.
      systemConfig: {
        commands: {
          'buy-ticket': {
            cost: 10,
          },
        },
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    // Assign JACKPOT_BUY permission to player[0] only
    buyRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['JACKPOT_BUY'],
    );

    // Give player[0] some starting currency (500)
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 500 },
    );

    // Give player[1] some currency too so command cost check passes (permission check in handler fails instead).
    // Without currency, Takaro blocks the command at the cost check and emits a different event type.
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[1].playerId,
      { currency: 100 },
    );
  });

  after(async () => {
    await cleanupRole(client, buyRoleId);
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

  it('should buy 1 ticket successfully', async () => {
    const player = ctx.players[0]!;

    // Record currency before
    const pogBefore = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [player.playerId] },
    });
    const currencyBefore = pogBefore.data.data[0]?.currency ?? 0;

    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 1`,
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
    assert.equal(meta?.result?.success, true, 'Expected buyticket to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('jackpot-buy:') && msg.includes('buying 1 tickets')),
      `Expected log to contain "buying 1 tickets", got: ${JSON.stringify(logMessages)}`,
    );

    // Verify currency was deducted by exactly 10: the command cost system auto-deducts 1x ticketPrice (=10).
    // When amount=1, additionalCost=(1-1)*10=0, so the handler deducts nothing extra.
    const pogAfter = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [player.playerId] },
    });
    const currencyAfter = pogAfter.data.data[0]?.currency ?? 0;
    assert.equal(
      currencyAfter,
      currencyBefore - 10,
      `Expected currency to decrease by 10 (ticket price). Before: ${currencyBefore}, After: ${currencyAfter}`,
    );
  });

  it('should buy multiple tickets with correct additional currency deduction', async () => {
    const player = ctx.players[0]!;

    // Record currency before buying 2 more
    const pogBefore = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [player.playerId] },
    });
    const currencyBefore = pogBefore.data.data[0]?.currency ?? 0;

    const before = new Date();

    // Buy 2 more — player already has 1 ticket, will have 3 total.
    // Total cost = 2 * 10 = 20: 1x ticketPrice auto-deducted by command system + (2-1)*10=10 additional deducted by handler.
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 2`,
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
    assert.equal(meta?.result?.success, true, 'Expected buying multiple tickets to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('jackpot-buy:') && msg.includes('buying 2 tickets')),
      `Expected log to show buying 2 tickets, got: ${JSON.stringify(logMessages)}`,
    );
    // Verify cumulative ticket count is now 3
    assert.ok(
      logMessages.some((msg) => msg.includes('newTickets=3')),
      `Expected newTickets=3 in log, got: ${JSON.stringify(logMessages)}`,
    );

    // Verify currency deducted: buying 2 tickets costs 20 total (10 auto-deducted by command system + 10 additional deducted by handler)
    const pogAfter = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [player.playerId] },
    });
    const currencyAfter = pogAfter.data.data[0]?.currency ?? 0;
    assert.equal(
      currencyAfter,
      currencyBefore - 20,
      `Expected currency to decrease by 20 (2 tickets * price 10). Before: ${currencyBefore}, After: ${currencyAfter}`,
    );
  });

  it('should deny purchase without JACKPOT_BUY permission', async () => {
    // player[1] has no JACKPOT_BUY permission
    const player = ctx.players[1]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 1`,
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
    assert.equal(meta?.result?.success, false, 'Expected command to fail without permission');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('do not have permission')),
      `Expected permission denied message, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should reject purchase exceeding maxTicketsPerPlayer', async () => {
    // player[0] has 3 tickets, maxTicketsPerPlayer=5, try to buy 3 more (would be 6)
    const player = ctx.players[0]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 3`,
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
    assert.equal(meta?.result?.success, false, 'Expected command to fail when exceeding max tickets');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('only hold') || msg.includes('maxTicketsPerPlayer') || msg.includes('5 tickets')),
      `Expected max tickets error, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should reject purchase when player has insufficient currency', async () => {
    // Drain player's currency and give exactly 10 (enough for 1 ticket via command cost, but not 2).
    // With command cost=10, Takaro auto-deducts 10 before the handler runs.
    // The handler sees original pog.currency=10 and checks 10 < (2-1)*10 + 10 = 20 → throws error.
    const pogResult = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [ctx.players[0].playerId],
      },
    });
    const currentCurrency = pogResult.data.data[0]?.currency ?? 0;
    if (currentCurrency > 0) {
      await client.playerOnGameserver.playerOnGameServerControllerDeductCurrency(
        ctx.gameServer.id,
        ctx.players[0].playerId,
        { currency: currentCurrency },
      );
    }
    // Give exactly 10: enough to pass the command cost check but not enough for 2 tickets total.
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 10 },
    );

    const player = ctx.players[0]!;
    const before = new Date();

    // Try to buy 2 tickets (costs 20 total — player has only 10)
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 2`,
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
    assert.equal(meta?.result?.success, false, 'Expected command to fail with insufficient currency');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('enough currency')),
      `Expected "enough currency" error message, got: ${JSON.stringify(logMessages)}`,
    );
  });
});
