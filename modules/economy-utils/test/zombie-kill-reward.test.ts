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
  assignPermissions,
  cleanupRole,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

describe('economy-utils: zombie-kill-reward cron job', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let zombieCronId: string;

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
        zombieKillReward: 5,
        transferTax: 0,
        maxTransferAmount: 0,
        showBalanceOnLogin: false,
      },
    });

    // Find the zombie-kill-reward cron job by versionId and name
    const cronJobs = await client.cronjob.cronJobControllerSearch({
      filters: { versionId: [versionId], name: ['zombie-kill-reward'] },
    });
    const zombieCron = cronJobs.data.data.find((c) => c.name === 'zombie-kill-reward');
    assert.ok(zombieCron, 'Expected zombie-kill-reward cron job to exist after install');
    zombieCronId = zombieCron.id;
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

  it('should run the cron job and award currency for entity kills', async () => {
    const player = ctx.players[0]!;
    const killBefore = new Date();

    // Trigger an entity kill event
    await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);

    // Wait for the kill event to be stored before triggering cron
    await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.EntityKilled,
      gameserverId: ctx.gameServer.id,
      after: killBefore,
      timeout: 15000,
    });

    // Manually trigger the cron job
    const cronBefore = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId: zombieCronId,
      moduleId: moduleId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: cronBefore,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a cronjob-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected cron job to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('kill events')),
      `Expected kill events log, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should apply ZOMBIE_KILL_REWARD_OVERRIDE permission to override reward per kill', async () => {
    const player = ctx.players[1]!;
    const expectedOverrideReward = 10;

    // Grant player[1] override of 10 per kill (base is 5)
    const overrideRoleId = await assignPermissions(client, player.playerId, ctx.gameServer.id, [
      { code: 'ZOMBIE_KILL_REWARD_OVERRIDE', count: expectedOverrideReward },
    ]);

    try {
      // Get player[1]'s current balance
      const pogBefore = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], playerId: [player.playerId] },
      });
      const balanceBefore = pogBefore.data.data[0]?.currency ?? 0;

      const killBefore = new Date();

      // Trigger a kill for player[1]
      await ctx.server.executeConsoleCommand(`triggerKill ${player.gameId}`);

      // Wait for the kill event to be stored before triggering cron
      await waitForEvent(client, {
        eventName: EventSearchInputAllowedFiltersEventNameEnum.EntityKilled,
        gameserverId: ctx.gameServer.id,
        after: killBefore,
        timeout: 15000,
      });

      // Trigger the cron job
      const cronBefore = new Date();
      await client.cronjob.cronJobControllerTrigger({
        gameServerId: ctx.gameServer.id,
        cronjobId: zombieCronId,
        moduleId: moduleId,
      });

      const event = await waitForEvent(client, {
        eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
        gameserverId: ctx.gameServer.id,
        after: cronBefore,
        timeout: 30000,
      });

      assert.ok(event, 'Expected a cronjob-executed event');
      const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
      assert.equal(meta?.result?.success, true, 'Expected cron job to succeed with override');

      // Verify player[1] received exactly 10 (override) not 5 (default)
      const pogAfter = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], playerId: [player.playerId] },
      });
      const balanceAfter = pogAfter.data.data[0]?.currency ?? 0;

      assert.equal(
        balanceAfter - balanceBefore,
        expectedOverrideReward,
        `Expected balance to increase by exactly ${expectedOverrideReward} (override). Before: ${balanceBefore}, After: ${balanceAfter}`,
      );
    } finally {
      await cleanupRole(client, overrideRoleId);
    }
  });
});
