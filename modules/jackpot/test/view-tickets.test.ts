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

// Tests run sequentially with shared state:
// player[0] has JACKPOT_BUY and JACKPOT_VIEW_TICKETS; player[1] has neither.
// 1. Permission denied for player[1] (no JACKPOT_VIEW_TICKETS)
// 2. Zero tickets for player[0] before any purchase
// 3. Correct count (2) after purchase of 2 tickets

describe('jackpot: /viewtickets command', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let permRoleId: string;

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
        maxTicketsPerPlayer: 100,
        minimumParticipants: 2,
        announceTicketPurchases: false,
        rolloverOnCancel: false,
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    // Assign both JACKPOT_BUY and JACKPOT_VIEW_TICKETS to player[0]
    permRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['JACKPOT_BUY', 'JACKPOT_VIEW_TICKETS'],
    );

    // Give player[0] currency for purchases
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 500 },
    );
  });

  after(async () => {
    await cleanupRole(client, permRoleId);
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

  it('should deny viewtickets to player without JACKPOT_VIEW_TICKETS permission', async () => {
    // player[1] has no JACKPOT_VIEW_TICKETS permission
    const player = ctx.players[1]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}viewtickets`,
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
    assert.equal(meta?.result?.success, false, 'Expected viewtickets to fail for unpermitted player');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('do not have permission')),
      `Expected permission denied message, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should show zero tickets before any purchase', async () => {
    const player = ctx.players[0]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}viewtickets`,
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
    assert.equal(meta?.result?.success, true, 'Expected viewtickets to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('tickets=0')),
      `Expected log to show tickets=0, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should show correct ticket count after purchase', async () => {
    const player = ctx.players[0]!;

    // Buy 2 tickets first
    const buyBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 2`,
      playerId: player.playerId,
    });
    await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: buyBefore,
      timeout: 30000,
    });

    // Now view tickets
    const viewBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}viewtickets`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: viewBefore,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected viewtickets to succeed after purchase');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('tickets=2')),
      `Expected log to show tickets=2, got: ${JSON.stringify(logMessages)}`,
    );
  });
});
