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

describe('jackpot: draw-jackpot rolloverOnCancel', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;
  let prefix: string;
  let buyRoleId: string;

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

    // Install with rolloverOnCancel=true, minimumParticipants=2 (only 1 player will buy)
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        ticketPrice: 10,
        profitMargin: 0.1,
        maxTicketsPerPlayer: 100,
        minimumParticipants: 2,
        announceTicketPurchases: false,
        rolloverOnCancel: true,
      },
      // Set command cost=ticketPrice so the system auto-deducts 1x ticketPrice.
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

    buyRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['JACKPOT_BUY'],
    );

    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 500 },
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

  it('should roll over pot when rolloverOnCancel=true and insufficient participants', async () => {
    // player[0] buys 2 tickets (pot = 20)
    const buyBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}buyticket 2`,
      playerId: ctx.players[0].playerId,
    });
    await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: buyBefore,
      timeout: 30000,
    });

    // Record player[0]'s currency before draw (should NOT be refunded)
    const pogBefore = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[0].playerId] },
    });
    const currencyBeforeDraw = pogBefore.data.data[0]?.currency ?? 0;

    // Trigger the draw — 1 participant, need 2, rolloverOnCancel=true
    const drawBefore = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId,
      moduleId,
    });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: drawBefore,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const success = meta?.result?.success ?? false;
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);

    assert.equal(success, true, `Expected draw cronjob to succeed on cancel, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('cancelling draw')),
      `Expected cancellation log, got: ${JSON.stringify(logs)}`,
    );

    // Wait for state to settle
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Player should NOT have been refunded (rolloverOnCancel=true keeps pot)
    const pogAfter = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[0].playerId] },
    });
    const currencyAfterDraw = pogAfter.data.data[0]?.currency ?? 0;

    assert.equal(
      currencyAfterDraw,
      currencyBeforeDraw,
      `Expected player currency unchanged (no refund when rolloverOnCancel=true). Before: ${currencyBeforeDraw}, After: ${currencyAfterDraw}`,
    );

    // The currency-unchanged assertion above confirms rolloverOnCancel=true path executed correctly
    // (no refund was given, so pot rolls over to next draw)
  });
});
