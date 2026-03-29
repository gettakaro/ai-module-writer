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
  cleanupTestModules,
  cleanupTestGameServers,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

describe('economy-utils: on-login-balance hook', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;

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

    // Install with showBalanceOnLogin: true to enable the hook behavior
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        pendingAmount: 0,
        zombieKillReward: 1,
        transferTax: 0,
        maxTransferAmount: 0,
        showBalanceOnLogin: true,
      },
    });
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

  it('should fire hook-executed when a player connects with showBalanceOnLogin: true', async () => {
    // Disconnect all players, then reconnect to trigger the hook
    await ctx.server.executeConsoleCommand('disconnectAll');

    // Wait for disconnect events to settle before setting our timestamp baseline
    const disconnectSettleMs = Number(process.env['TEST_DISCONNECT_SETTLE_MS'] ?? 2000);
    await new Promise((resolve) => setTimeout(resolve, disconnectSettleMs));

    const before = new Date();

    // Connect all players — triggers player-connected events which fires the hook
    await ctx.server.executeConsoleCommand('connectAll');

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a hook-executed event');
    assert.equal(event.eventName, 'hook-executed', 'Event name should be hook-executed');
    assert.equal(event.gameserverId, ctx.gameServer.id, 'Event should be for the correct game server');
    assert.ok(event.moduleId, 'Event should reference the installed module');

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected hook to succeed');

    // Verify log message contains both 'on-login-balance' and 'balance' (confirming the balance PM was prepared)
    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('on-login-balance') && msg.toLowerCase().includes('balance')),
      `Expected on-login-balance log with balance info, got: ${JSON.stringify(logMessages)}`,
    );

    // Note: showBalanceOnLogin: false is implicitly tested by all other test files — they install
    // the module with showBalanceOnLogin: false and no hook-executed events are expected.
  });
});
