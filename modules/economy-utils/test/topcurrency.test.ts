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

describe('economy-utils: /topcurrency command', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;

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

    // Give players different amounts of currency
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[0].playerId,
      { currency: 300 },
    );
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      ctx.players[1].playerId,
      { currency: 100 },
    );
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

  it('should show leaderboard of richest players', async () => {
    const player = ctx.players[0]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}topcurrency`,
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
    assert.equal(meta?.result?.success, true, 'Expected topcurrency to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('Richest players:')),
      `Expected "Richest players:" header, got: ${JSON.stringify(logMessages)}`,
    );
    // player[0] has 300, should be ranked 1st
    assert.ok(
      logMessages.some((msg) => msg.includes('1.') && msg.includes('300')),
      `Expected player[0] ranked #1 with 300 currency, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should respect custom count argument', async () => {
    const player = ctx.players[0]!;
    const before = new Date();

    // Request only top 1
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}topcurrency 1`,
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
    assert.equal(meta?.result?.success, true, 'Expected topcurrency with count=1 to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    // Should have "1." but NOT "2."
    assert.ok(
      logMessages.some((msg) => msg.includes('1.')),
      `Expected rank 1 in results, got: ${JSON.stringify(logMessages)}`,
    );
    assert.ok(
      !logMessages.some((msg) => msg.includes('2.')),
      `Expected only 1 result, got: ${JSON.stringify(logMessages)}`,
    );
  });
});
