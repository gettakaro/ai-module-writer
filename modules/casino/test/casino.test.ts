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
  let playRoleId1: string | undefined;
  let playRoleId2: string | undefined;
  let manageRoleId: string | undefined;
  let refreshCronjobId: string;
  let expireSessionsCronjobId: string;
  let expireWindowsCronjobId: string;
  let expireBansCronjobId: string;
  let drawRaceCronjobId: string;
  let vipRoleId: string | undefined;

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

  async function triggerCronjob(cronjobId: string) {
    const after = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId,
      moduleId,
    });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
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

  async function getPlayerCurrency(playerId: string) {
    const pog = await client.playerOnGameserver.playerOnGameServerControllerGetOne(ctx.gameServer.id, playerId);
    return Number(pog.data.data.currency ?? 0);
  }

  async function getVariable(key: string, playerId?: string) {
    const res = await client.variable.variableControllerSearch({
      filters: {
        key: [key],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        ...(playerId ? { playerId: [playerId] } : {}),
      },
    });
    return res.data.data[0] ?? null;
  }

  async function updateVariable(key: string, playerId: string | undefined, mutator: (value: any) => any) {
    const row = await getVariable(key, playerId);
    assert.ok(row, `Expected variable ${key} to exist`);
    const next = mutator(JSON.parse(row!.value));
    await client.variable.variableControllerUpdate(row!.id, { value: JSON.stringify(next) });
  }

  async function findBigWinEvent(after: Date) {
    const result = await client.event.eventControllerSearch({
      filters: {
        gameserverId: [ctx.gameServer.id],
        eventName: ['chat-message' as any],
      },
      greaterThan: { createdAt: after.toISOString() },
      limit: 20,
    } as any);
    return result.data.data.find((event: any) => event.meta?.type === 'casino-big-win') ?? null;
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
    expireSessionsCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'expire-sessions')!.id;
    expireWindowsCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'expire-windows')!.id;
    expireBansCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'expire-bans')!.id;
    drawRaceCronjobId = mod.latestVersion.cronJobs.find((c) => c.name === 'draw-race')!.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        minBet: 1,
        maxBet: 1000,
        cooldownSeconds: 0,
        houseEdgePct: 2,
        jackpotContributionPct: 10,
        bigWinThreshold: 1,
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    playRoleId1 = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['CASINO_PLAY']);
    manageRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, ['CASINO_PLAY', 'CASINO_MANAGE']);
    playRoleId2 = await assignPermissions(client, ctx.players[2].playerId, ctx.gameServer.id, ['CASINO_PLAY']);
    vipRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, [{ code: 'CASINO_VIP', count: 2 }]);

    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[0].playerId, { currency: 5000 });
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[1].playerId, { currency: 5000 });
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[2].playerId, { currency: 5 });
  });

  after(async () => {
    await cleanupRole(client, playRoleId1);
    await cleanupRole(client, playRoleId2);
    await cleanupRole(client, manageRoleId);
    await cleanupRole(client, vipRoleId);
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

  it('shows runnable help commands for alias-based games', async () => {
    const result = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casino`);
    assert.equal(result.success, true, `expected /casino success, logs=${JSON.stringify(result.logs)}`);
    const joined = result.logs.join('\n');
    assert.match(joined, /roulette \(\/bet\)/i);
    assert.match(joined, /blackjack \(\/bj\)/i);
  });

  it('plays flip and records stats', async () => {
    const player = ctx.players[0]!;
    const result = await triggerCommand(player.playerId, `${prefix}flip 50 heads`);
    assert.equal(result.success, true, `expected flip success, logs=${JSON.stringify(result.logs)}`);

    const stats = await getVariable('casino_stats', player.playerId);
    assert.ok(stats, 'expected casino_stats variable');
    const parsed = JSON.parse(stats!.value);
    assert.equal(parsed.gamesPlayed >= 1, true);
    assert.equal(parsed.perGame.flip.plays >= 1, true);
  });

  it('enforces admin permissions on management commands', async () => {
    const denied = await triggerCommand(ctx.players[0]!.playerId, `${prefix}setjackpot 1234`);
    assert.equal(denied.success, false, 'expected non-admin /setjackpot to fail');
    assert.ok(denied.logs.some((msg) => msg.toLowerCase().includes('permission')),
      `expected permission denial, logs=${JSON.stringify(denied.logs)}`);
  });

  it('rejects bets when the player lacks funds', async () => {
    const result = await triggerCommand(ctx.players[2]!.playerId, `${prefix}slots 50`);
    assert.equal(result.success, false, 'expected insufficient funds failure');
    assert.ok(result.logs.some((msg) => msg.toLowerCase().includes('enough currency')),
      `expected insufficient-funds message, logs=${JSON.stringify(result.logs)}`);
  });

  it('prevents stacked duel challenges on the same target and resolves a full duel flow', async () => {
    const challenger = ctx.players[0]!;
    const target = ctx.players[1]!;
    const third = ctx.players[2]!;
    const targetName = (await client.player.playerControllerGetOne(target.playerId)).data.data.name;

    const challenge = await triggerCommand(challenger.playerId, `${prefix}duel ${targetName} 20`);
    assert.equal(challenge.success, true, `expected duel challenge success, logs=${JSON.stringify(challenge.logs)}`);

    const blocked = await triggerCommand(third.playerId, `${prefix}duel ${targetName} 10`);
    assert.equal(blocked.success, false, 'expected second duel challenge on same target to fail');
    assert.ok(blocked.logs.some((msg) => msg.toLowerCase().includes('already involved in another duel')),
      `expected target-busy message, logs=${JSON.stringify(blocked.logs)}`);

    const accept = await triggerCommand(target.playerId, `${prefix}duel accept`);
    assert.equal(accept.success, true, `expected duel accept success, logs=${JSON.stringify(accept.logs)}`);

    const firstPick = await triggerCommand(challenger.playerId, `${prefix}duel rock`);
    assert.equal(firstPick.success, true, `expected first duel pick success, logs=${JSON.stringify(firstPick.logs)}`);

    const secondPick = await triggerCommand(target.playerId, `${prefix}duel scissors`);
    assert.equal(secondPick.success, true, `expected second duel pick success, logs=${JSON.stringify(secondPick.logs)}`);

    const duelVar = await getVariable('casino_duel', challenger.playerId);
    assert.equal(duelVar, null, 'expected duel state to be cleared after resolution');
  });

  it('supports duel decline and tie refunds', async () => {
    const challenger = ctx.players[0]!;
    const target = ctx.players[1]!;
    const challengerName = (await client.player.playerControllerGetOne(challenger.playerId)).data.data.name;
    const targetName = (await client.player.playerControllerGetOne(target.playerId)).data.data.name;

    const beforeDecline = await getPlayerCurrency(challenger.playerId);
    const challenge = await triggerCommand(challenger.playerId, `${prefix}duel ${targetName} 15`);
    assert.equal(challenge.success, true, `expected duel challenge success, logs=${JSON.stringify(challenge.logs)}`);
    const declined = await triggerCommand(target.playerId, `${prefix}duel decline`);
    assert.equal(declined.success, true, `expected duel decline success, logs=${JSON.stringify(declined.logs)}`);
    assert.equal(await getPlayerCurrency(challenger.playerId), beforeDecline, 'expected challenger refund after duel decline');

    const beforeTie1 = await getPlayerCurrency(challenger.playerId);
    const beforeTie2 = await getPlayerCurrency(target.playerId);
    const challenge2 = await triggerCommand(challenger.playerId, `${prefix}duel ${targetName} 15`);
    assert.equal(challenge2.success, true, `expected second duel challenge success, logs=${JSON.stringify(challenge2.logs)}`);
    const accept = await triggerCommand(target.playerId, `${prefix}duel accept`);
    assert.equal(accept.success, true, `expected duel accept success, logs=${JSON.stringify(accept.logs)}`);
    const rock1 = await triggerCommand(challenger.playerId, `${prefix}duel rock`);
    assert.equal(rock1.success, true, `expected challenger pick success, logs=${JSON.stringify(rock1.logs)}`);
    const rock2 = await triggerCommand(target.playerId, `${prefix}duel rock`);
    assert.equal(rock2.success, true, `expected opponent pick success, logs=${JSON.stringify(rock2.logs)}`);
    assert.equal(await getPlayerCurrency(challenger.playerId), beforeTie1, 'expected challenger refund after duel tie');
    assert.equal(await getPlayerCurrency(target.playerId), beforeTie2, 'expected opponent refund after duel tie');
    assert.equal(await getVariable('casino_duel', challenger.playerId), null, 'expected duel cleanup after tie');
    assert.ok(challengerName && targetName);
  });

  it('uses readable race timing text and resolves the race draw cronjob', async () => {
    const p1 = ctx.players[0]!;
    const p2 = ctx.players[1]!;

    const join1 = await triggerCommand(p1.playerId, `${prefix}race 25`);
    assert.equal(join1.success, true, `expected first /race success, logs=${JSON.stringify(join1.logs)}`);
    assert.ok(join1.logs.some((msg) => msg.includes('Draw in about')),
      `expected friendly time text, logs=${JSON.stringify(join1.logs)}`);
    assert.ok(join1.logs.every((msg) => !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(msg)),
      `expected no raw ISO timestamp in race logs, logs=${JSON.stringify(join1.logs)}`);

    const join2 = await triggerCommand(p2.playerId, `${prefix}race 25`);
    assert.equal(join2.success, true, `expected second /race success, logs=${JSON.stringify(join2.logs)}`);

    await updateVariable('casino_race_pool', undefined, (pool) => ({ ...pool, drawAt: new Date(Date.now() - 1000).toISOString() }));
    const draw = await triggerCronjob(drawRaceCronjobId);
    assert.equal(draw.success, true, `expected draw-race success, logs=${JSON.stringify(draw.logs)}`);
    assert.ok(draw.logs.some((msg) => msg.includes('casino.drawRace: winner=')),
      `expected draw-race winner log, logs=${JSON.stringify(draw.logs)}`);

    const pool = await getVariable('casino_race_pool');
    const parsed = JSON.parse(pool!.value);
    assert.deepEqual(parsed, { participants: [], drawAt: null, status: 'open' });
  });

  it('covers hilo win, cashout, and loss branches', async () => {
    const player = ctx.players[0]!;
    const before = await getPlayerCurrency(player.playerId);

    const start = await triggerCommand(player.playerId, `${prefix}hilo 20`);
    assert.equal(start.success, true, `expected hilo start success, logs=${JSON.stringify(start.logs)}`);
    await updateVariable('casino_session_hilo', player.playerId, (session) => ({
      ...session,
      multiplier: 1.5,
      currentCard: { rank: 5, suit: '♠' },
      deck: [{ rank: 9, suit: '♥' }],
    }));
    const higher = await triggerCommand(player.playerId, `${prefix}hilo higher`);
    assert.equal(higher.success, true, `expected hilo higher success, logs=${JSON.stringify(higher.logs)}`);
    const cashout = await triggerCommand(player.playerId, `${prefix}hilo cashout`);
    assert.equal(cashout.success, true, `expected hilo cashout success, logs=${JSON.stringify(cashout.logs)}`);
    assert.ok(cashout.logs.some((msg) => /Cashed out/i.test(msg)), `expected cashout message, logs=${JSON.stringify(cashout.logs)}`);

    const startLoss = await triggerCommand(player.playerId, `${prefix}hilo 10`);
    assert.equal(startLoss.success, true, `expected second hilo start success, logs=${JSON.stringify(startLoss.logs)}`);
    await updateVariable('casino_session_hilo', player.playerId, (session) => ({
      ...session,
      currentCard: { rank: 10, suit: '♣' },
      deck: [{ rank: 3, suit: '♦' }],
    }));
    const loss = await triggerCommand(player.playerId, `${prefix}hilo higher`);
    assert.equal(loss.success, true, `expected hilo loss resolution success, logs=${JSON.stringify(loss.logs)}`);
    assert.ok(loss.logs.some((msg) => /Wrong|lost/i.test(msg)), `expected hilo loss message, logs=${JSON.stringify(loss.logs)}`);
    assert.equal(await getVariable('casino_session_hilo', player.playerId), null, 'expected hilo session cleanup after loss');
    assert.ok(await getPlayerCurrency(player.playerId) !== before - 30);
  });

  it('expires abandoned hilo sessions through the cleanup cronjob and refunds the stake', async () => {
    const player = ctx.players[0]!;
    const beforeBalance = await getPlayerCurrency(player.playerId);

    const start = await triggerCommand(player.playerId, `${prefix}hilo 25`);
    assert.equal(start.success, true, `expected hilo start success, logs=${JSON.stringify(start.logs)}`);

    const afterStartBalance = await getPlayerCurrency(player.playerId);
    assert.equal(beforeBalance - afterStartBalance, 25, 'expected hilo stake deduction');

    await updateVariable('casino_session_hilo', player.playerId, (session) => ({
      ...session,
      startedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    }));

    const cleanup = await triggerCronjob(expireSessionsCronjobId);
    assert.equal(cleanup.success, true, `expected expire-sessions success, logs=${JSON.stringify(cleanup.logs)}`);

    const afterCleanupBalance = await getPlayerCurrency(player.playerId);
    assert.equal(afterCleanupBalance, beforeBalance, 'expected abandoned hilo stake to be refunded');
    assert.equal(await getVariable('casino_session_hilo', player.playerId), null, 'expected hilo session deletion');
  });

  it('covers blackjack hit, stand, and double branches', async () => {
    const player = ctx.players[0]!;

    const start = await triggerCommand(player.playerId, `${prefix}bj 20`);
    assert.equal(start.success, true, `expected blackjack start success, logs=${JSON.stringify(start.logs)}`);
    await updateVariable('casino_session_blackjack', player.playerId, (session) => ({
      ...session,
      stake: 20,
      playerHand: [{ rank: 8, suit: '♠' }, { rank: 3, suit: '♥' }],
      dealerHand: [{ rank: 6, suit: '♦' }, { rank: 10, suit: '♣' }],
      deck: [{ rank: 9, suit: '♣' }, { rank: 10, suit: '♦' }],
    }));
    const hit = await triggerCommand(player.playerId, `${prefix}bj hit`);
    assert.equal(hit.success, true, `expected blackjack hit success, logs=${JSON.stringify(hit.logs)}`);
    const stand = await triggerCommand(player.playerId, `${prefix}bj stand`);
    assert.equal(stand.success, true, `expected blackjack stand success, logs=${JSON.stringify(stand.logs)}`);
    assert.ok(stand.logs.some((msg) => /Dealer:/i.test(msg)), `expected dealer reveal, logs=${JSON.stringify(stand.logs)}`);

    const startDouble = await triggerCommand(player.playerId, `${prefix}bj 20`);
    assert.equal(startDouble.success, true, `expected blackjack double setup success, logs=${JSON.stringify(startDouble.logs)}`);
    await updateVariable('casino_session_blackjack', player.playerId, (session) => ({
      ...session,
      stake: 20,
      playerHand: [{ rank: 5, suit: '♠' }, { rank: 6, suit: '♥' }],
      dealerHand: [{ rank: 6, suit: '♦' }, { rank: 10, suit: '♣' }],
      deck: [{ rank: 10, suit: '♠' }, { rank: 10, suit: '♥' }],
    }));
    const doubled = await triggerCommand(player.playerId, `${prefix}bj double`);
    assert.equal(doubled.success, true, `expected blackjack double success, logs=${JSON.stringify(doubled.logs)}`);
    assert.equal(await getVariable('casino_session_blackjack', player.playerId), null, 'expected blackjack session cleanup after double resolution');
  });

  it('refunds blackjack sessions when the player disconnects', async () => {
    const player = ctx.players[0]!;
    const beforeBalance = await getPlayerCurrency(player.playerId);

    const start = await triggerCommand(player.playerId, `${prefix}bj 30`);
    assert.equal(start.success, true, `expected blackjack start success, logs=${JSON.stringify(start.logs)}`);

    const afterStartBalance = await getPlayerCurrency(player.playerId);
    assert.equal(beforeBalance - afterStartBalance, 30, 'expected blackjack stake deduction');

    const beforeHook = new Date();
    await ctx.server.executeConsoleCommand('disconnectAll');
    const hookEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      after: beforeHook,
      timeout: 30000,
    });
    const hookMeta = hookEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(hookMeta?.result?.success, true, 'expected disconnect hook success');

    const afterRefundBalance = await getPlayerCurrency(player.playerId);
    assert.equal(afterRefundBalance, beforeBalance, 'expected blackjack session refund on disconnect');
    assert.equal(await getVariable('casino_session_blackjack', player.playerId), null, 'expected blackjack session deletion');

    await ctx.server.executeConsoleCommand('connectAll');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  });

  it('emits a compatible big-win chat-message event for qualifying wins', async () => {
    const player = ctx.players[0]!;
    const after = new Date();
    let event = await findBigWinEvent(after);

    for (let i = 0; i < 12 && !event; i += 1) {
      const attempt = await triggerCommand(player.playerId, `${prefix}flip 10 heads`);
      assert.equal(attempt.success, true, `expected flip attempt to execute, logs=${JSON.stringify(attempt.logs)}`);
      event = await findBigWinEvent(after);
    }

    assert.ok(event, 'expected a compatible big-win event after repeated winning attempts');
    const meta = event!.meta as unknown as Record<string, unknown>;
    assert.equal(meta.type, 'casino-big-win');
    assert.equal(event!.eventName, 'chat-message');
  });

  it('cancels active hilo sessions when the player becomes banned', async () => {
    const admin = ctx.players[1]!;
    const player = ctx.players[0]!;
    const playerName = (await client.player.playerControllerGetOne(player.playerId)).data.data.name;
    const before = await getPlayerCurrency(player.playerId);

    const start = await triggerCommand(player.playerId, `${prefix}hilo 25`);
    assert.equal(start.success, true, `expected hilo start success, logs=${JSON.stringify(start.logs)}`);
    const ban = await triggerCommand(admin.playerId, `${prefix}casinoban ${playerName} 1`);
    assert.equal(ban.success, true, `expected ban success, logs=${JSON.stringify(ban.logs)}`);
    const followup = await triggerCommand(player.playerId, `${prefix}hilo cashout`);
    assert.equal(followup.success, false, 'expected banned hilo follow-up to be cancelled');
    assert.ok(followup.logs.some((msg) => /cancelled/i.test(msg)), `expected cancelled-session message, logs=${JSON.stringify(followup.logs)}`);
    assert.equal(await getPlayerCurrency(player.playerId), before, 'expected active hilo stake refund after ban');
    assert.equal(await getVariable('casino_session_hilo', player.playerId), null, 'expected hilo session cleanup after ban');

    const unban = await triggerCommand(admin.playerId, `${prefix}casinounban ${playerName}`);
    assert.equal(unban.success, true, `expected unban success, logs=${JSON.stringify(unban.logs)}`);
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
    assert.ok(report.logs.some((msg) => /Casino report \(7 days\)/.test(msg)), `expected bounded report window, logs=${JSON.stringify(report.logs)}`);
  });

  it('refreshes leaderboard cache and exposes it through /casinotop', async () => {
    const refresh = await triggerCronjob(refreshCronjobId);
    assert.equal(refresh.success, true, `expected refresh-leaderboards cronjob success, logs=${JSON.stringify(refresh.logs)}`);

    const cache = await getVariable('casino_leaderboard_cache');
    assert.ok(cache, 'expected leaderboard cache variable');

    const top = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casinotop wager`);
    assert.equal(top.success, true, `expected /casinotop success, logs=${JSON.stringify(top.logs)}`);

    const roi = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casinotop roi`);
    assert.equal(roi.success, true, `expected /casinotop roi success, logs=${JSON.stringify(roi.logs)}`);
    assert.ok(roi.logs.some((msg) => /payout ratio/i.test(msg)), `expected payout-ratio wording, logs=${JSON.stringify(roi.logs)}`);
  });

  it('covers roulette, dice, crash, stats, and stat reset commands', async () => {
    const player = ctx.players[0]!;
    const admin = ctx.players[1]!;
    const playerName = (await client.player.playerControllerGetOne(player.playerId)).data.data.name;

    for (const msg of [`${prefix}bet 10 red`, `${prefix}dice 10 over 60`, `${prefix}crash 10 1.5`, `${prefix}casinostats`]) {
      const result = await triggerCommand(player.playerId, msg);
      assert.equal(result.success, true, `expected success for ${msg}, logs=${JSON.stringify(result.logs)}`);
    }

    const reset = await triggerCommand(admin.playerId, `${prefix}casinoresetstats ${playerName}`);
    assert.equal(reset.success, true, `expected casinoresetstats success, logs=${JSON.stringify(reset.logs)}`);
    const statsRow = await getVariable('casino_stats', player.playerId);
    assert.equal(statsRow, null, 'expected casino stats row to be deleted after reset');
  });

  it('enforces disabled games, vip max-bet scaling, and self-service cap feedback', async () => {
    const install = (await client.module.moduleInstallationsControllerGetModuleInstallation(moduleId, ctx.gameServer.id)).data.data;
    await client.module.moduleInstallationsControllerUninstallModule(moduleId, ctx.gameServer.id);
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        ...(install.userConfig as any),
        cooldownSeconds: 0,
        maxBet: 100,
        wagerCap: 120,
        lossCap: 80,
        games: { ...(install.userConfig as any)?.games, dice: false },
      },
    });

    const disabled = await triggerCommand(ctx.players[0]!.playerId, `${prefix}dice 10 over 55`);
    assert.equal(disabled.success, false, 'expected disabled game rejection');
    assert.ok(disabled.logs.some((msg) => /disabled/i.test(msg)), `expected disabled-game message, logs=${JSON.stringify(disabled.logs)}`);

    const vipBet = await triggerCommand(ctx.players[0]!.playerId, `${prefix}flip 150 heads`);
    assert.equal(vipBet.success, true, `expected VIP-scaled max bet to succeed, logs=${JSON.stringify(vipBet.logs)}`);

    const stats = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casinostats`);
    assert.equal(stats.success, true, `expected casinostats success, logs=${JSON.stringify(stats.logs)}`);
    assert.ok(stats.logs.some((msg) => /remaining/i.test(msg)), `expected actionable cap feedback, logs=${JSON.stringify(stats.logs)}`);
  });

  it('expires temporary bans and old windows via cronjobs', async () => {
    const admin = ctx.players[1]!;
    const player = ctx.players[0]!;
    const playerName = (await client.player.playerControllerGetOne(player.playerId)).data.data.name;

    const ban = await triggerCommand(admin.playerId, `${prefix}casinoban ${playerName} 1`);
    assert.equal(ban.success, true, `expected temp ban success, logs=${JSON.stringify(ban.logs)}`);
    await updateVariable('casino_ban', player.playerId, (value) => ({ ...value, expiresAt: new Date(Date.now() - 60_000).toISOString() }));

    const expireBan = await triggerCronjob(expireBansCronjobId);
    assert.equal(expireBan.success, true, `expected expire-bans success, logs=${JSON.stringify(expireBan.logs)}`);
    assert.equal(await getVariable('casino_ban', player.playerId), null, 'expected expired ban deletion');

    await client.variable.variableControllerCreate({
      key: 'casino_window:2000-01-01',
      value: JSON.stringify({ wagered: 10, lost: 5, windowKey: '2000-01-01' }),
      gameServerId: ctx.gameServer.id,
      moduleId,
      playerId: player.playerId,
    });
    const expireWindow = await triggerCronjob(expireWindowsCronjobId);
    assert.equal(expireWindow.success, true, `expected expire-windows success, logs=${JSON.stringify(expireWindow.logs)}`);
    assert.equal(await getVariable('casino_window:2000-01-01', player.playerId), null, 'expected old window deletion');
  });
});
