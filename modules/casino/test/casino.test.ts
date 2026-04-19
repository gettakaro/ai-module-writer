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
  cleanupTestGameServers,
  assignPermissions,
  cleanupRole,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

describe('casino module', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let playRoleId: string | undefined;
  let manageRoleId: string | undefined;
  let refreshCronjobId: string;

  async function triggerCommand(playerId: string, msg: string) {
    const after = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, { playerId, msg });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((l) => l.msg),
    };
  }

  before(async () => {
    client = await createClient();
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    refreshCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'refresh-leaderboards')!.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        minBet: 1,
        maxBet: 1000,
        cooldownSeconds: 0,
        houseEdgePct: 2,
        jackpotContributionPct: 10,
        bigWinThreshold: 999999,
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    playRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['CASINO_PLAY']);
    manageRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, ['CASINO_PLAY', 'CASINO_MANAGE']);

    for (const player of ctx.players.slice(0, 2)) {
      await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, player.playerId, { currency: 5000 });
    }
  });

  after(async () => {
    await cleanupRole(client, playRoleId);
    await cleanupRole(client, manageRoleId);
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('cleanup uninstall failed', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('cleanup delete failed', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('plays flip and records stats', async () => {
    const player = ctx.players[0]!;
    const result = await triggerCommand(player.playerId, `${prefix}flip 50 heads`);
    assert.equal(result.success, true, `expected flip success, logs=${JSON.stringify(result.logs)}`);

    const stats = await client.variable.variableControllerSearch({
      filters: {
        key: ['casino_stats'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        playerId: [player.playerId],
      },
    });
    assert.equal(stats.data.data.length, 1, 'expected casino_stats variable');
    const parsed = JSON.parse(stats.data.data[0]!.value);
    assert.equal(parsed.gamesPlayed, 1);
    assert.equal(parsed.perGame.flip.plays, 1);
  });

  it('supports hilo start and cashout', async () => {
    const player = ctx.players[0]!;
    const start = await triggerCommand(player.playerId, `${prefix}hilo 25`);
    assert.equal(start.success, true, `expected hilo start success, logs=${JSON.stringify(start.logs)}`);

    const sessionBefore = await client.variable.variableControllerSearch({
      filters: {
        key: ['casino_session_hilo'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        playerId: [player.playerId],
      },
    });
    assert.equal(sessionBefore.data.data.length, 1, 'expected hilo session after start');

    const cashout = await triggerCommand(player.playerId, `${prefix}hilo cashout`);
    assert.equal(cashout.success, true, `expected hilo cashout success, logs=${JSON.stringify(cashout.logs)}`);

    const sessionAfter = await client.variable.variableControllerSearch({
      filters: {
        key: ['casino_session_hilo'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        playerId: [player.playerId],
      },
    });
    assert.equal(sessionAfter.data.data.length, 0, 'expected hilo session to be cleared');
  });

  it('bans and unbans players via admin commands', async () => {
    const admin = ctx.players[1]!;
    const player = ctx.players[0]!;

    const playerName = (await client.player.playerControllerGetOne(player.playerId)).data.data.name;
    const ban = await triggerCommand(admin.playerId, `${prefix}casinoban ${playerName} 1`);
    assert.equal(ban.success, true, `expected ban success, logs=${JSON.stringify(ban.logs)}`);

    const blocked = await triggerCommand(player.playerId, `${prefix}flip 10 heads`);
    assert.equal(blocked.success, false, 'expected banned player to be denied');
    assert.ok(blocked.logs.some((msg) => msg.toLowerCase().includes('banned from the casino')),
      `expected banned message, logs=${JSON.stringify(blocked.logs)}`);

    const unban = await triggerCommand(admin.playerId, `${prefix}casinounban ${playerName}`);
    assert.equal(unban.success, true, `expected unban success, logs=${JSON.stringify(unban.logs)}`);

    const allowed = await triggerCommand(player.playerId, `${prefix}flip 10 heads`);
    assert.equal(allowed.success, true, `expected play after unban, logs=${JSON.stringify(allowed.logs)}`);
  });

  it('sets and reads the jackpot and report commands', async () => {
    const admin = ctx.players[1]!;
    const set = await triggerCommand(admin.playerId, `${prefix}setjackpot 1234`);
    assert.equal(set.success, true, `expected /setjackpot success, logs=${JSON.stringify(set.logs)}`);

    const jackpot = await triggerCommand(ctx.players[0]!.playerId, `${prefix}jackpot`);
    assert.equal(jackpot.success, true, `expected /jackpot success, logs=${JSON.stringify(jackpot.logs)}`);

    const report = await triggerCommand(admin.playerId, `${prefix}casinoreport 7`);
    assert.equal(report.success, true, `expected /casinoreport success, logs=${JSON.stringify(report.logs)}`);
  });

  it('refreshes leaderboard cache and exposes it through /casinotop', async () => {
    const before = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId: refreshCronjobId,
      moduleId,
    });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean } };
    assert.equal(meta?.result?.success, true, 'expected refresh-leaderboards cronjob success');

    const cache = await client.variable.variableControllerSearch({
      filters: {
        key: ['casino_leaderboard_cache'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    assert.equal(cache.data.data.length, 1, 'expected leaderboard cache variable');

    const top = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casinotop wager`);
    assert.equal(top.success, true, `expected /casinotop success, logs=${JSON.stringify(top.logs)}`);
  });
});
