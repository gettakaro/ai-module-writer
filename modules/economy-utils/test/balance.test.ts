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

describe('economy-utils: /balance command', () => {
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

    // Enable economy for this game server
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

  it('should show player balance of 0 by default', async () => {
    const player = ctx.players[0]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}balance`,
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
    assert.equal(meta?.result?.success, true, 'Expected balance command to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('balance:')),
      `Expected log to contain "balance:", got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should show updated balance after receiving currency', async () => {
    const player = ctx.players[0]!;

    // Give player some currency
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, player.playerId, {
      currency: 250,
    });

    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}balance`,
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
    assert.equal(meta?.result?.success, true, 'Expected balance command to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('balance:') && msg.includes('250')),
      `Expected log to show balance of 250, got: ${JSON.stringify(logMessages)}`,
    );
  });
});
