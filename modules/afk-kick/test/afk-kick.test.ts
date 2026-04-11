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

// Tests run sequentially and share state within the suite.
// Players stay at static positions in the mock server so idle counts accumulate.
// Config: checksBeforeWarning=2, checksBeforeKick=3, positionThreshold=5
// player[2] has IMMUNE_TO_AFK_KICK permission.

describe('afk-kick: check-afk cronjob', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;
  let immuneRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    // Wait until all 3 players are online in Takaro before proceeding.
    const maxWaitForAll = 30000;
    const pollIntervalMs = 2000;
    const setupStart = Date.now();
    while (ctx.players.length < 3 && Date.now() - setupStart < maxWaitForAll) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const res = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], online: [true] },
      });
      if (res.data.data.length >= 3) {
        ctx.players = res.data.data;
        break;
      }
    }

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    // Use low thresholds so tests don't require many triggers
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        checksBeforeWarning: 2,
        checksBeforeKick: 3,
        warningMessage: 'You will be kicked for being AFK!',
        kickMessage: 'Kicked for being AFK',
        positionThreshold: 5,
      },
    });

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected at least one cronjob in afk-kick module');
    cronjobId = cronjob.id;

    assert.ok(ctx.players[2], 'Expected at least 3 players in mock server (players[2] must exist)');

    immuneRoleId = await assignPermissions(
      client,
      ctx.players[2].playerId,
      ctx.gameServer.id,
      ['IMMUNE_TO_AFK_KICK'],
    );

    // The cron runs on a 1-minute schedule. If it auto-fired during setup, the tracking
    // variable would already have idleCount=1 for all players, causing the sequential
    // idle-count tests to fail. Delete any stale tracking state so tests start clean.
    const staleVars = await client.variable.variableControllerSearch({
      filters: {
        key: ['afk_tracking'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    for (const v of staleVars.data.data) {
      await client.variable.variableControllerDelete(v.id);
    }
  });

  after(async () => {
    await cleanupRole(client, immuneRoleId);
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

  async function triggerCronjob(): Promise<{ success: boolean; logs: string[] }> {
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

    // Give Takaro time to fully commit the variable update before the next trigger reads it
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return { success, logs };
  }

  it('first check stores positions without warnings', async () => {
    const { success, logs } = await triggerCronjob();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      !logs.some((msg) => msg.toLowerCase().includes('warned')),
      `Expected no warnings on first check, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      !logs.some((msg) => msg.toLowerCase().includes('kicked')),
      `Expected no kicks on first check, got: ${JSON.stringify(logs)}`,
    );
  });

  it('second check increments idle count, no warning yet', async () => {
    // checksBeforeWarning=2, so idleCount=1 after this trigger — below threshold
    const { success, logs } = await triggerCronjob();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      !logs.some((msg) => msg.toLowerCase().includes('warned')),
      `Expected no warnings on second check (idleCount=1 < checksBeforeWarning=2), got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      !logs.some((msg) => msg.toLowerCase().includes('kicked')),
      `Expected no kicks on second check, got: ${JSON.stringify(logs)}`,
    );
  });

  it('warns after checksBeforeWarning checks', async () => {
    // checksBeforeWarning=2, idleCount will hit 2 on this trigger
    const { success, logs } = await triggerCronjob();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.toLowerCase().includes('warned')),
      `Expected a warning log on third check (idleCount=2 >= checksBeforeWarning=2), got: ${JSON.stringify(logs)}`,
    );
  });

  it('kicks after checksBeforeKick checks', async () => {
    // checksBeforeKick=3, idleCount will hit 3 on this trigger
    const { success, logs } = await triggerCronjob();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.toLowerCase().includes('kicked')),
      `Expected a kick log on fourth check (idleCount=3 >= checksBeforeKick=3), got: ${JSON.stringify(logs)}`,
    );

    // Verify kicked player is no longer online
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const nonImmunePlayers = ctx.players.filter((p) => p.playerId !== ctx.players[2].playerId);
    let atLeastOneKicked = false;
    for (const player of nonImmunePlayers) {
      const searchResult = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: {
          gameServerId: [ctx.gameServer.id],
          playerId: [player.playerId],
        },
      });
      const pog = searchResult.data.data[0];
      if (pog && pog.online === false) {
        atLeastOneKicked = true;
        break;
      }
    }
    assert.ok(
      atLeastOneKicked,
      'Expected at least one non-immune player to be offline after kick trigger',
    );
  });

  it('immune player is not kicked', async () => {
    // player[2] has IMMUNE_TO_AFK_KICK — after multiple triggers they should be skipped.
    // Reset state: disconnect everyone, trigger once to prune tracking, then reconnect fresh.
    await ctx.server.executeConsoleCommand('disconnectAll');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Trigger once with all players offline — prunes all tracking entries
    await triggerCronjob();

    // Reconnect all players
    await ctx.server.executeConsoleCommand('connectAll');

    // Wait for all 3 players (including the immune player[2]) to be online in Takaro
    const immunePlayerId = ctx.players[2].playerId;
    const allPlayerIds = ctx.players.map((p) => p.playerId);
    const maxWaitMs = 30000;
    const pollInterval = 2000;
    const startWait = Date.now();
    let allOnline = false;
    while (Date.now() - startWait < maxWaitMs) {
      const res = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: { gameServerId: [ctx.gameServer.id], online: [true] },
      });
      const onlineIds = new Set(res.data.data.map((p) => p.playerId));
      if (allPlayerIds.every((id) => onlineIds.has(id))) {
        allOnline = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    assert.ok(allOnline, `Not all players came online within ${maxWaitMs}ms`);

    // With all players fresh in tracking (empty), run 3 triggers:
    // Trigger 1: first seen — idleCount=0 for all
    await triggerCronjob();
    // Trigger 2: idleCount=1 for all (below warning threshold=2)
    await triggerCronjob();
    // Trigger 3: idleCount=2 for all → hits warning threshold=2
    //   - non-immune players get warned
    //   - player[2] (immune) → logs "immune" and resets idleCount
    const { success, logs } = await triggerCronjob();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);

    assert.ok(
      logs.some((msg) => msg.toLowerCase().includes('immune')),
      `Expected a log mentioning "immune" for player[2], got: ${JSON.stringify(logs)}`,
    );

    // Verify player[2] is still online after the kick trigger
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const searchResult = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [immunePlayerId],
      },
    });
    const pog = searchResult.data.data[0];
    assert.ok(pog, `Expected to find player[2] (${immunePlayerId}) in Takaro`);
    assert.equal(
      pog.online,
      true,
      `Expected immune player[2] to still be online after kick trigger, but online=${pog.online}`,
    );
  });
});
