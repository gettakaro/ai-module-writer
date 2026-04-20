import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
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

  async function listPlayerVariables(playerId: string, keyPrefix: string) {
    const res = await client.variable.variableControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        playerId: [playerId],
      },
      search: { key: [keyPrefix] },
      limit: 100,
    });
    return res.data.data.filter((row) => row.key.startsWith(keyPrefix));
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
      },
      greaterThan: { createdAt: after.toISOString() },
      limit: 50,
      sortBy: 'createdAt',
      sortDirection: 'desc',
    } as any);
    const event = result.data.data.find((row: any) => String(row.eventName) === 'casino-big-win' || row.meta?.type === 'casino-big-win') ?? null;
    if (event) return event;

    const fallback = await getVariable('casino_big_win_event');
    if (!fallback) return null;
    const parsed = JSON.parse(fallback.value);
    const occurredAt = parsed?.meta?.occurredAt ? new Date(parsed.meta.occurredAt) : null;
    if (occurredAt && occurredAt > after) {
      return parsed;
    }
    return null;
  }

  async function installDefaultCasino() {
    const existing = await client.module.moduleInstallationsControllerGetModuleInstallation(moduleId, ctx.gameServer.id).catch(() => null);
    if (existing) {
      await client.module.moduleInstallationsControllerUninstallModule(moduleId, ctx.gameServer.id);
    }
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
  }

  async function setExactCurrency(playerId: string, target: number) {
    const current = await getPlayerCurrency(playerId);
    const diff = target - current;
    if (diff > 0) {
      await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, playerId, { currency: diff });
    } else if (diff < 0) {
      await client.playerOnGameserver.playerOnGameServerControllerDeductCurrency(ctx.gameServer.id, playerId, { currency: Math.abs(diff) });
    }
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

    await installDefaultCasino();

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    playRoleId1 = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['CASINO_PLAY']);
    manageRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, ['CASINO_PLAY', 'CASINO_MANAGE']);
    playRoleId2 = await assignPermissions(client, ctx.players[2].playerId, ctx.gameServer.id, ['CASINO_PLAY']);
    vipRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, [{ code: 'CASINO_VIP', count: 2 }]);

    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[0].playerId, { currency: 5000 });
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[1].playerId, { currency: 5000 });
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[2].playerId, { currency: 5 });
  });

  beforeEach(async () => {
    await ctx.server.executeConsoleCommand('connectAll');
    await installDefaultCasino();
    const variables = await client.variable.variableControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
      limit: 500,
    });
    await Promise.all(variables.data.data.map((row) => client.variable.variableControllerDelete(row.id).catch(() => undefined)));
    await setExactCurrency(ctx.players[0].playerId, 5000);
    await setExactCurrency(ctx.players[1].playerId, 5000);
    await setExactCurrency(ctx.players[2].playerId, 5);
    prefix = await getCommandPrefix(client, ctx.gameServer.id);
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

  it('covers slots loss, pair, triple, and jackpot branches', async () => {
    const player = ctx.players[0]!;

    const setSlotsOverride = async (reels: string[]) => {
      const existing = await getVariable('casino_slots_override', player.playerId);
      if (existing) {
        await client.variable.variableControllerUpdate(existing.id, { value: JSON.stringify({ reels }) });
      } else {
        await client.variable.variableControllerCreate({
          key: 'casino_slots_override',
          value: JSON.stringify({ reels }),
          gameServerId: ctx.gameServer.id,
          moduleId,
          playerId: player.playerId,
        });
      }
    };

    await setSlotsOverride(['🍒', '🔔', '🍇']);
    const loss = await triggerCommand(player.playerId, `${prefix}slots 10`);
    assert.equal(loss.success, true, `expected slots loss success, logs=${JSON.stringify(loss.logs)}`);
    assert.ok(loss.logs.some((msg) => /No luck/i.test(msg)), `expected loss wording, logs=${JSON.stringify(loss.logs)}`);

    await setSlotsOverride(['🍒', '🍒', '🍋']);
    const pair = await triggerCommand(player.playerId, `${prefix}slots 10`);
    assert.equal(pair.success, true, `expected slots pair success, logs=${JSON.stringify(pair.logs)}`);
    assert.ok(pair.logs.some((msg) => /Pair!/i.test(msg)), `expected pair wording, logs=${JSON.stringify(pair.logs)}`);

    await setSlotsOverride(['⭐', '⭐', '⭐']);
    const triple = await triggerCommand(player.playerId, `${prefix}slots 10`);
    assert.equal(triple.success, true, `expected slots triple success, logs=${JSON.stringify(triple.logs)}`);
    assert.ok(triple.logs.some((msg) => /Triple!/i.test(msg)), `expected triple wording, logs=${JSON.stringify(triple.logs)}`);

    const jackpotRow = await getVariable('casino_jackpot');
    if (jackpotRow) {
      await client.variable.variableControllerUpdate(jackpotRow.id, {
        value: JSON.stringify({ amount: 4321, lastWinner: null, lastWinAt: null, lastWinGame: null }),
      });
    } else {
      await client.variable.variableControllerCreate({
        key: 'casino_jackpot',
        value: JSON.stringify({ amount: 4321, lastWinner: null, lastWinAt: null, lastWinGame: null }),
        gameServerId: ctx.gameServer.id,
        moduleId,
      });
    }

    await setSlotsOverride(['7️⃣', '7️⃣', '7️⃣']);
    const jackpot = await triggerCommand(player.playerId, `${prefix}slots 10`);
    assert.equal(jackpot.success, true, `expected slots jackpot success, logs=${JSON.stringify(jackpot.logs)}`);
    assert.ok(jackpot.logs.some((msg) => /JACKPOT!/i.test(msg)), `expected jackpot wording, logs=${JSON.stringify(jackpot.logs)}`);

    const jackpotAfter = await getVariable('casino_jackpot');
    assert.ok(jackpotAfter, 'expected casino_jackpot variable after jackpot win');
    const parsedJackpot = JSON.parse(jackpotAfter!.value);
    assert.equal(parsedJackpot.amount, 0, 'expected jackpot pot reset after triple sevens');
    assert.equal(parsedJackpot.lastWinGame, 'slots', 'expected slots jackpot history update');
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

  it('cancels an underfilled race and refunds the lone entry', async () => {
    const player = ctx.players[0]!;
    const before = await getPlayerCurrency(player.playerId);

    const join = await triggerCommand(player.playerId, `${prefix}race 14`);
    assert.equal(join.success, true, `expected solo /race join success, logs=${JSON.stringify(join.logs)}`);

    await updateVariable('casino_race_pool', undefined, (pool) => ({ ...pool, drawAt: new Date(Date.now() - 1000).toISOString() }));
    const draw = await triggerCronjob(drawRaceCronjobId);
    assert.equal(draw.success, true, `expected underfilled draw-race success, logs=${JSON.stringify(draw.logs)}`);
    assert.ok(draw.logs.some((msg) => /refunded undersized race pool/i.test(msg)), `expected cancelled-race log, logs=${JSON.stringify(draw.logs)}`);
    assert.equal(await getPlayerCurrency(player.playerId), before, 'expected lone race stake refund after cancellation');
  });

  it('settles every race entry even when the same player joins multiple times', async () => {
    const p1 = ctx.players[0]!;
    const p2 = ctx.players[1]!;
    const before1 = await getPlayerCurrency(p1.playerId);
    const before2 = await getPlayerCurrency(p2.playerId);

    const join1 = await triggerCommand(p1.playerId, `${prefix}race 11`);
    const join2 = await triggerCommand(p1.playerId, `${prefix}race 13`);
    const join3 = await triggerCommand(p2.playerId, `${prefix}race 17`);
    assert.equal(join1.success && join2.success && join3.success, true, `expected race joins to succeed, logs=${JSON.stringify([join1.logs, join2.logs, join3.logs])}`);

    await updateVariable('casino_race_pool', undefined, (pool) => ({ ...pool, drawAt: new Date(Date.now() - 1000).toISOString() }));
    const draw = await triggerCronjob(drawRaceCronjobId);
    assert.equal(draw.success, true, `expected draw-race success for duplicate entries, logs=${JSON.stringify(draw.logs)}`);

    const stats1 = JSON.parse((await getVariable('casino_stats', p1.playerId))!.value);
    const stats2 = JSON.parse((await getVariable('casino_stats', p2.playerId))!.value);
    assert.ok((stats1.perGame.race?.plays ?? 0) >= 2, `expected both of player one's race tickets to settle, stats=${JSON.stringify(stats1.perGame.race)}`);
    assert.ok((stats2.perGame.race?.plays ?? 0) >= 1, `expected player two race ticket to settle, stats=${JSON.stringify(stats2.perGame.race)}`);

    const after1 = await getPlayerCurrency(p1.playerId);
    const after2 = await getPlayerCurrency(p2.playerId);
    assert.ok(after1 !== before1 - 24 || after2 !== before2 - 17, 'expected race settlement to resolve the pot instead of leaving raw deductions behind');
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

  it('accepts direct /roulette and /blackjack aliases', async () => {
    const player = ctx.players[0]!;

    const roulette = await triggerCommand(player.playerId, `${prefix}roulette 10 red`);
    assert.equal(roulette.success, true, `expected /roulette alias success, logs=${JSON.stringify(roulette.logs)}`);
    assert.ok(roulette.logs.some((msg) => /Spun/i.test(msg)), `expected roulette alias wording, logs=${JSON.stringify(roulette.logs)}`);

    const blackjack = await triggerCommand(player.playerId, `${prefix}blackjack 10`);
    assert.equal(blackjack.success, true, `expected /blackjack alias success, logs=${JSON.stringify(blackjack.logs)}`);
    assert.ok(blackjack.logs.some((msg) => /Dealer shows/i.test(msg) || /Blackjack!/i.test(msg)), `expected blackjack alias wording, logs=${JSON.stringify(blackjack.logs)}`);
    const session = await getVariable('casino_session_blackjack', player.playerId);
    if (session) {
      const stand = await triggerCommand(player.playerId, `${prefix}blackjack stand`);
      assert.equal(stand.success, true, `expected /blackjack stand alias success, logs=${JSON.stringify(stand.logs)}`);
    }
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

  it('refunds hilo sessions when the player disconnects', async () => {
    const player = ctx.players[0]!;
    const beforeBalance = await getPlayerCurrency(player.playerId);

    const start = await triggerCommand(player.playerId, `${prefix}hilo 19`);
    assert.equal(start.success, true, `expected hilo start success, logs=${JSON.stringify(start.logs)}`);
    assert.equal(beforeBalance - await getPlayerCurrency(player.playerId), 19, 'expected hilo stake deduction');

    const beforeHook = new Date();
    await ctx.server.executeConsoleCommand('disconnectAll');
    const hookEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      after: beforeHook,
      timeout: 30000,
    });
    const hookMeta = hookEvent.meta as { result?: { success?: boolean } };
    assert.equal(hookMeta?.result?.success, true, 'expected disconnect hook success for hilo');

    assert.equal(await getPlayerCurrency(player.playerId), beforeBalance, 'expected hilo session refund on disconnect');
    assert.equal(await getVariable('casino_session_hilo', player.playerId), null, 'expected hilo session deletion on disconnect');

    await ctx.server.executeConsoleCommand('connectAll');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  });

  it('refunds pending and accepted duels when players disconnect', async () => {
    const challenger = ctx.players[0]!;
    const target = ctx.players[1]!;
    const targetName = (await client.player.playerControllerGetOne(target.playerId)).data.data.name;

    const beforePending = await getPlayerCurrency(challenger.playerId);
    const pending = await triggerCommand(challenger.playerId, `${prefix}duel ${targetName} 17`);
    assert.equal(pending.success, true, `expected pending duel success, logs=${JSON.stringify(pending.logs)}`);

    let beforeHook = new Date();
    await ctx.server.executeConsoleCommand('disconnectAll');
    let hookEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      after: beforeHook,
      timeout: 30000,
    });
    let hookMeta = hookEvent.meta as { result?: { success?: boolean } };
    assert.equal(hookMeta?.result?.success, true, 'expected disconnect hook success for pending duel');
    assert.equal(await getVariable('casino_duel', challenger.playerId), null, 'expected pending duel deletion on disconnect');
    assert.equal(await getPlayerCurrency(challenger.playerId), beforePending, 'expected pending duel refund on disconnect');

    await ctx.server.executeConsoleCommand('connectAll');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const beforeAccepted1 = await getPlayerCurrency(challenger.playerId);
    const beforeAccepted2 = await getPlayerCurrency(target.playerId);
    const challenge = await triggerCommand(challenger.playerId, `${prefix}duel ${targetName} 21`);
    assert.equal(challenge.success, true, `expected accepted duel challenge success, logs=${JSON.stringify(challenge.logs)}`);
    const accept = await triggerCommand(target.playerId, `${prefix}duel accept`);
    assert.equal(accept.success, true, `expected accepted duel acceptance success, logs=${JSON.stringify(accept.logs)}`);

    beforeHook = new Date();
    await ctx.server.executeConsoleCommand('disconnectAll');
    hookEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      after: beforeHook,
      timeout: 30000,
    });
    hookMeta = hookEvent.meta as { result?: { success?: boolean } };
    assert.equal(hookMeta?.result?.success, true, 'expected disconnect hook success for accepted duel');
    assert.equal(await getVariable('casino_duel', challenger.playerId), null, 'expected accepted duel deletion on disconnect');
    assert.equal(await getPlayerCurrency(challenger.playerId), beforeAccepted1, 'expected challenger refund on accepted-duel disconnect');
    assert.equal(await getPlayerCurrency(target.playerId), beforeAccepted2, 'expected opponent refund on accepted-duel disconnect');

    await ctx.server.executeConsoleCommand('connectAll');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  });

  it('expires abandoned blackjack sessions through the cleanup cronjob and refunds doubled stakes', async () => {
    const player = ctx.players[0]!;
    const beforeBalance = await getPlayerCurrency(player.playerId);

    const start = await triggerCommand(player.playerId, `${prefix}bj 20`);
    assert.equal(start.success, true, `expected blackjack start success, logs=${JSON.stringify(start.logs)}`);

    await client.playerOnGameserver.playerOnGameServerControllerDeductCurrency(ctx.gameServer.id, player.playerId, { currency: 20 });
    await updateVariable('casino_session_blackjack', player.playerId, (session) => ({
      ...session,
      stake: 40,
      doubled: true,
      startedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    }));

    const cleanup = await triggerCronjob(expireSessionsCronjobId);
    assert.equal(cleanup.success, true, `expected blackjack cleanup success, logs=${JSON.stringify(cleanup.logs)}`);
    assert.equal(await getVariable('casino_session_blackjack', player.playerId), null, 'expected blackjack session deletion after expiry');
    assert.equal(await getPlayerCurrency(player.playerId), beforeBalance, 'expected doubled blackjack stake refund to restore balance');
  });

  it('emits a custom casino-big-win event for qualifying wins', async () => {
    const player = ctx.players[0]!;
    const after = new Date();
    let event = await findBigWinEvent(after);

    for (let i = 0; i < 12 && !event; i += 1) {
      const attempt = await triggerCommand(player.playerId, `${prefix}flip 10 heads`);
      assert.equal(attempt.success, true, `expected flip attempt to execute, logs=${JSON.stringify(attempt.logs)}`);
      event = await findBigWinEvent(after);
    }

    assert.ok(event, 'expected a casino-big-win event after repeated winning attempts');
    const meta = event!.meta as unknown as Record<string, unknown>;
    assert.equal(meta.type, 'casino-big-win');
    assert.ok(['casino-big-win', 'chat-message'].includes(String((event as any).eventName)), `expected big-win marker event, got ${JSON.stringify(event)}`);
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

  it('denies play when the explicit CASINO_BANNED permission is assigned', async () => {
    const player = ctx.players[2]!;
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, player.playerId, { currency: 100 });
    const bannedRoleId = await assignPermissions(client, player.playerId, ctx.gameServer.id, ['CASINO_BANNED']);
    try {
      const blocked = await triggerCommand(player.playerId, `${prefix}flip 10 heads`);
      assert.equal(blocked.success, false, 'expected CASINO_BANNED permission to deny play');
      assert.ok(blocked.logs.some((msg) => /banned from the casino/i.test(msg)), `expected banned wording, logs=${JSON.stringify(blocked.logs)}`);
    } finally {
      await cleanupRole(client, bannedRoleId);
    }
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

    const roulette = await triggerCommand(player.playerId, `${prefix}bet 10 red`);
    assert.equal(roulette.success, true, `expected roulette success, logs=${JSON.stringify(roulette.logs)}`);
    assert.ok(roulette.logs.some((msg) => /Spun/i.test(msg)), `expected roulette result wording, logs=${JSON.stringify(roulette.logs)}`);

    const dice = await triggerCommand(player.playerId, `${prefix}dice 10 over 60`);
    assert.equal(dice.success, true, `expected dice success, logs=${JSON.stringify(dice.logs)}`);
    assert.ok(dice.logs.some((msg) => /Rolled/i.test(msg)), `expected dice roll wording, logs=${JSON.stringify(dice.logs)}`);

    const crash = await triggerCommand(player.playerId, `${prefix}crash 10 1.5`);
    assert.equal(crash.success, true, `expected crash success, logs=${JSON.stringify(crash.logs)}`);
    assert.ok(crash.logs.some((msg) => /Crashed at/i.test(msg)), `expected crash result wording, logs=${JSON.stringify(crash.logs)}`);

    const stats = await triggerCommand(player.playerId, `${prefix}casinostats`);
    assert.equal(stats.success, true, `expected casinostats success, logs=${JSON.stringify(stats.logs)}`);
    assert.ok(stats.logs.some((msg) => /Lifetime wagered/i.test(msg)), `expected lifetime stats wording, logs=${JSON.stringify(stats.logs)}`);

    const statsBeforeReset = JSON.parse((await getVariable('casino_stats', player.playerId))!.value);
    assert.ok((statsBeforeReset.perGame.roulette?.plays ?? 0) >= 1, `expected roulette stats to record plays, stats=${JSON.stringify(statsBeforeReset.perGame)}`);
    assert.ok((statsBeforeReset.perGame.dice?.plays ?? 0) >= 1, `expected dice stats to record plays, stats=${JSON.stringify(statsBeforeReset.perGame)}`);
    assert.ok((statsBeforeReset.perGame.crash?.plays ?? 0) >= 1, `expected crash stats to record plays, stats=${JSON.stringify(statsBeforeReset.perGame)}`);

    const reset = await triggerCommand(admin.playerId, `${prefix}casinoresetstats ${playerName}`);
    assert.equal(reset.success, true, `expected casinoresetstats success, logs=${JSON.stringify(reset.logs)}`);
    const statsRow = await getVariable('casino_stats', player.playerId);
    assert.equal(statsRow, null, 'expected casino stats row to be deleted after reset');
    const currentWindowKey = new Date().toISOString().slice(0, 10);
    const currentWindowRow = await getVariable(`casino_window:${currentWindowKey}`, player.playerId);
    assert.equal(currentWindowRow, null, 'expected active cap window rows to be cleared after reset');

    const reportAfterReset = await triggerCommand(admin.playerId, `${prefix}casinoreport 7`);
    assert.equal(reportAfterReset.success, true, `expected casinoreport after reset success, logs=${JSON.stringify(reportAfterReset.logs)}`);
    assert.ok(reportAfterReset.logs.every((msg) => !msg.includes(playerName)), `expected reset player to disappear from report output, logs=${JSON.stringify(reportAfterReset.logs)}`);
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
        games: { ...(install.userConfig as any)?.games, dice: false, blackjack: false },
      },
    });

    const overview = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casino`);
    assert.equal(overview.success, true, `expected /casino overview success, logs=${JSON.stringify(overview.logs)}`);

    const disabled = await triggerCommand(ctx.players[0]!.playerId, `${prefix}dice 10 over 55`);
    assert.equal(disabled.success, false, 'expected disabled game rejection');
    assert.ok(disabled.logs.some((msg) => /disabled/i.test(msg)), `expected disabled-game message, logs=${JSON.stringify(disabled.logs)}`);

    const disabledHelp = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casino blackjack`);
    assert.equal(disabledHelp.success, false, 'expected focused help for disabled game to fail');
    assert.ok(disabledHelp.logs.some((msg) => /disabled/i.test(msg)), `expected disabled-focused-help message, logs=${JSON.stringify(disabledHelp.logs)}`);

    const vipBet = await triggerCommand(ctx.players[0]!.playerId, `${prefix}flip 150 heads`);
    assert.equal(vipBet.success, true, `expected VIP-scaled max bet to succeed, logs=${JSON.stringify(vipBet.logs)}`);

    const stats = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casinostats`);
    assert.equal(stats.success, true, `expected casinostats success, logs=${JSON.stringify(stats.logs)}`);
    assert.ok(stats.logs.some((msg) => /remaining/i.test(msg)), `expected actionable cap feedback, logs=${JSON.stringify(stats.logs)}`);
  });

  it('shows a clear overview when every casino game is disabled', async () => {
    const install = (await client.module.moduleInstallationsControllerGetModuleInstallation(moduleId, ctx.gameServer.id)).data.data;
    await client.module.moduleInstallationsControllerUninstallModule(moduleId, ctx.gameServer.id);
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        ...(install.userConfig as any),
        cooldownSeconds: 0,
        games: {
          flip: false,
          dice: false,
          hilo: false,
          roulette: false,
          slots: false,
          blackjack: false,
          crash: false,
          duel: false,
          race: false,
        },
      },
    });

    const overview = await triggerCommand(ctx.players[0]!.playerId, `${prefix}casino`);
    assert.equal(overview.success, true, `expected /casino overview success with all games disabled, logs=${JSON.stringify(overview.logs)}`);
    assert.ok(overview.logs.some((msg) => /no games are currently enabled/i.test(msg)), `expected disabled-overview wording, logs=${JSON.stringify(overview.logs)}`);
  });

  it('covers core validation failures across casino commands', async () => {
    const install = (await client.module.moduleInstallationsControllerGetModuleInstallation(moduleId, ctx.gameServer.id)).data.data;
    await client.module.moduleInstallationsControllerUninstallModule(moduleId, ctx.gameServer.id);
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        ...(install.userConfig as any),
        cooldownSeconds: 0,
        games: { ...(install.userConfig as any)?.games, dice: true, blackjack: true },
      },
    });

    const player = ctx.players[0]!;
    const admin = ctx.players[1]!;

    const invalidCrash = await triggerCommand(player.playerId, `${prefix}crash 10 1.0`);
    assert.equal(invalidCrash.success, false, 'expected invalid crash target to fail');
    assert.ok(invalidCrash.logs.some((msg) => /cashout target must be between 1\.01 and 1000/i.test(msg)), `expected crash validation message, logs=${JSON.stringify(invalidCrash.logs)}`);

    const invalidDiceDirection = await triggerCommand(player.playerId, `${prefix}dice 10 sideways 50`);
    assert.equal(invalidDiceDirection.success, false, 'expected invalid dice direction to fail');
    assert.ok(invalidDiceDirection.logs.some((msg) => /over or under/i.test(msg)), `expected dice direction message, logs=${JSON.stringify(invalidDiceDirection.logs)}`);

    const unknownGame = await triggerCommand(player.playerId, `${prefix}casino baccarat`);
    assert.equal(unknownGame.success, false, 'expected unknown /casino game to fail');
    assert.ok(unknownGame.logs.some((msg) => /unknown casino game/i.test(msg)), `expected unknown-game message, logs=${JSON.stringify(unknownGame.logs)}`);

    const invalidTop = await triggerCommand(player.playerId, `${prefix}casinotop bananas`);
    assert.equal(invalidTop.success, false, 'expected invalid leaderboard category to fail');
    assert.ok(invalidTop.logs.some((msg) => /choose wager, won, winrate, roi, or biggest/i.test(msg)), `expected invalid-category message, logs=${JSON.stringify(invalidTop.logs)}`);

    const missingAdminTarget = await triggerCommand(admin.playerId, `${prefix}casinoresetstats MissingPlayer`);
    assert.equal(missingAdminTarget.success, false, 'expected missing admin target to fail');
    assert.ok(missingAdminTarget.logs.some((msg) => /not found/i.test(msg)), `expected missing-target message, logs=${JSON.stringify(missingAdminTarget.logs)}`);

    const duelWithoutInvite = await triggerCommand(player.playerId, `${prefix}duel accept`);
    assert.equal(duelWithoutInvite.success, false, 'expected misuse of /duel accept to fail');
    assert.ok(duelWithoutInvite.logs.some((msg) => /not part of an active duel/i.test(msg)), `expected duel misuse message, logs=${JSON.stringify(duelWithoutInvite.logs)}`);
  });

  it('rejects play while a legacy gambling module is installed', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'casino-legacy-module-'));
    let legacyModuleId: string | undefined;
    try {
      await fs.writeFile(path.join(tempDir, 'module.json'), JSON.stringify({
        name: 'blackjack',
        author: 'test',
        description: 'Legacy conflict fixture',
        version: 'latest',
        supportedGames: ['all'],
        config: { type: 'object', properties: {}, additionalProperties: false },
        systemConfig: { type: 'object', properties: {}, additionalProperties: true },
        uiSchema: {},
        permissions: [],
        commands: {},
        hooks: {},
        cronJobs: {},
        functions: {},
      }, null, 2));

      const legacyModule = await pushModule(client, tempDir);
      legacyModuleId = legacyModule.id;
      await installModule(client, legacyModule.latestVersion.id, ctx.gameServer.id, {});

      const blocked = await triggerCommand(ctx.players[0]!.playerId, `${prefix}flip 10 heads`);
      assert.equal(blocked.success, false, 'expected legacy conflict to block play');
      assert.ok(blocked.logs.some((msg) => /old gambling modules are still installed/i.test(msg)), `expected legacy-conflict message, logs=${JSON.stringify(blocked.logs)}`);
    } finally {
      if (legacyModuleId) {
        try {
          await uninstallModule(client, legacyModuleId, ctx.gameServer.id);
        } catch {}
        try {
          await deleteModule(client, legacyModuleId);
        } catch {}
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects play when the player lacks CASINO_PLAY permission', async () => {
    const player = ctx.players[2]!;
    await cleanupRole(client, playRoleId2);
    playRoleId2 = undefined;
    try {
      const blocked = await triggerCommand(player.playerId, `${prefix}flip 10 heads`);
      assert.equal(blocked.success, false, 'expected missing CASINO_PLAY to deny play');
      assert.ok(blocked.logs.some((msg) => /permission to play casino games/i.test(msg)), `expected CASINO_PLAY denial wording, logs=${JSON.stringify(blocked.logs)}`);
    } finally {
      playRoleId2 = await assignPermissions(client, player.playerId, ctx.gameServer.id, ['CASINO_PLAY']);
    }
  });

  it('uninstalls casino immediately when a legacy gambling module is already installed', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'casino-install-conflict-'));
    let legacyModuleId: string | undefined;
    try {
      await fs.writeFile(path.join(tempDir, 'module.json'), JSON.stringify({
        name: 'roulette',
        author: 'test',
        description: 'Legacy install-conflict fixture',
        version: 'latest',
        supportedGames: ['all'],
        config: { type: 'object', properties: {}, additionalProperties: false },
        systemConfig: { type: 'object', properties: {}, additionalProperties: true },
        uiSchema: {},
        permissions: [],
        commands: {},
        hooks: {},
        cronJobs: {},
        functions: {},
      }, null, 2));

      const legacyModule = await pushModule(client, tempDir);
      legacyModuleId = legacyModule.id;
      await installModule(client, legacyModule.latestVersion.id, ctx.gameServer.id, {});

      await uninstallModule(client, moduleId, ctx.gameServer.id);
      const hookAfter = new Date();
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
      const hookEvent = await waitForEvent(client, {
        eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
        gameserverId: ctx.gameServer.id,
        after: hookAfter,
        timeout: 30000,
      });
      const hookMeta = hookEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
      assert.equal(hookMeta?.result?.success, true, `expected install hook success, logs=${JSON.stringify(hookMeta?.result?.logs ?? [])}`);
      assert.ok((hookMeta?.result?.logs ?? []).some((log) => /install blocked/i.test(log.msg) || /legacy casino module conflict/i.test(log.msg)), `expected conflict logs, logs=${JSON.stringify(hookMeta?.result?.logs ?? [])}`);

      const installation = await client.module.moduleInstallationsControllerGetModuleInstallation(moduleId, ctx.gameServer.id).catch(() => null);
      assert.equal(installation, null, 'expected casino installation to be removed during conflicting install');

      await uninstallModule(client, legacyModuleId, ctx.gameServer.id);
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
    } finally {
      if (legacyModuleId) {
        try {
          await uninstallModule(client, legacyModuleId, ctx.gameServer.id);
        } catch {}
        try {
          await deleteModule(client, legacyModuleId);
        } catch {}
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('validates new admin guardrails and ban cleanup paths', async () => {
    const admin = ctx.players[1]!;
    const player = ctx.players[0]!;
    const playerName = (await client.player.playerControllerGetOne(player.playerId)).data.data.name;

    const invalidBanDuration = await triggerCommand(admin.playerId, `${prefix}casinoban ${playerName} -1`);
    assert.equal(invalidBanDuration.success, false, 'expected negative ban duration to fail');
    assert.ok(invalidBanDuration.logs.some((msg) => /positive number of hours/i.test(msg)), `expected ban-duration validation, logs=${JSON.stringify(invalidBanDuration.logs)}`);

    const invalidReportDays = await triggerCommand(admin.playerId, `${prefix}casinoreport 0`);
    assert.equal(invalidReportDays.success, false, 'expected invalid report days to fail');
    assert.ok(invalidReportDays.logs.some((msg) => /between 1 and 365/i.test(msg)), `expected report-day validation, logs=${JSON.stringify(invalidReportDays.logs)}`);

    const invalidJackpot = await triggerCommand(admin.playerId, `${prefix}setjackpot -5`);
    assert.equal(invalidJackpot.success, false, 'expected negative jackpot to fail');
    assert.ok(invalidJackpot.logs.some((msg) => /number >= 0/i.test(msg)), `expected jackpot validation, logs=${JSON.stringify(invalidJackpot.logs)}`);

    const race = await triggerCommand(player.playerId, `${prefix}race 11`);
    assert.equal(race.success, true, `expected race join success, logs=${JSON.stringify(race.logs)}`);
    const ban = await triggerCommand(admin.playerId, `${prefix}casinoban ${playerName} 1`);
    assert.equal(ban.success, true, `expected ban success, logs=${JSON.stringify(ban.logs)}`);
    assert.ok(ban.logs.some((msg) => /race entr/i.test(msg)), `expected race cleanup note, logs=${JSON.stringify(ban.logs)}`);
    const racePool = JSON.parse((await getVariable('casino_race_pool'))!.value);
    assert.ok((racePool.participants ?? []).every((entry: any) => entry.playerId !== player.playerId), `expected banned player removed from race pool, pool=${JSON.stringify(racePool)}`);

    const unban = await triggerCommand(admin.playerId, `${prefix}casinounban ${playerName}`);
    assert.equal(unban.success, true, `expected unban success, logs=${JSON.stringify(unban.logs)}`);
  });

  it('expires pending and accepted duels through the cleanup cronjob with full refunds', async () => {
    const challenger = ctx.players[0]!;
    const target = ctx.players[1]!;
    const targetName = (await client.player.playerControllerGetOne(target.playerId)).data.data.name;

    const beforePending = await getPlayerCurrency(challenger.playerId);
    const pending = await triggerCommand(challenger.playerId, `${prefix}duel ${targetName} 12`);
    assert.equal(pending.success, true, `expected pending duel success, logs=${JSON.stringify(pending.logs)}`);
    await updateVariable('casino_duel', challenger.playerId, (duel) => ({
      ...duel,
      startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    }));
    const cleanupPending = await triggerCronjob(expireSessionsCronjobId);
    assert.equal(cleanupPending.success, true, `expected pending duel cleanup success, logs=${JSON.stringify(cleanupPending.logs)}`);
    assert.equal(await getVariable('casino_duel', challenger.playerId), null, 'expected pending duel deletion after expiry');
    assert.equal(await getPlayerCurrency(challenger.playerId), beforePending, 'expected pending duel refund for challenger');

    const beforeAccepted1 = await getPlayerCurrency(challenger.playerId);
    const beforeAccepted2 = await getPlayerCurrency(target.playerId);
    const accepted = await triggerCommand(challenger.playerId, `${prefix}duel ${targetName} 14`);
    assert.equal(accepted.success, true, `expected accepted duel challenge success, logs=${JSON.stringify(accepted.logs)}`);
    const accept = await triggerCommand(target.playerId, `${prefix}duel accept`);
    assert.equal(accept.success, true, `expected duel accept success, logs=${JSON.stringify(accept.logs)}`);
    await updateVariable('casino_duel', challenger.playerId, (duel) => ({
      ...duel,
      state: 'accepted',
      acceptedStakePlaced: true,
      startedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    }));
    const cleanupAccepted = await triggerCronjob(expireSessionsCronjobId);
    assert.equal(cleanupAccepted.success, true, `expected accepted duel cleanup success, logs=${JSON.stringify(cleanupAccepted.logs)}`);
    assert.equal(await getVariable('casino_duel', challenger.playerId), null, 'expected accepted duel deletion after expiry');
    assert.equal(await getPlayerCurrency(challenger.playerId), beforeAccepted1, 'expected accepted duel refund for challenger');
    assert.equal(await getPlayerCurrency(target.playerId), beforeAccepted2, 'expected accepted duel refund for opponent');
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

  it('blocks bets that would exceed the remaining loss-cap room before settlement', async () => {
    const player = ctx.players[0]!;
    const install = (await client.module.moduleInstallationsControllerGetModuleInstallation(moduleId, ctx.gameServer.id)).data.data;
    await client.module.moduleInstallationsControllerUninstallModule(moduleId, ctx.gameServer.id);
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        ...(install.userConfig as any),
        cooldownSeconds: 0,
        lossCap: 20,
        wagerCap: 0,
      },
    });

    const windowKey = new Date().toISOString().slice(0, 10);
    const existingWindow = await getVariable(`casino_window:${windowKey}`, player.playerId);
    if (existingWindow) {
      await client.variable.variableControllerUpdate(existingWindow.id, {
        value: JSON.stringify({ ...(JSON.parse(existingWindow.value)), lost: 15, wagered: 15, windowKey }),
      });
    } else {
      await client.variable.variableControllerCreate({
        key: `casino_window:${windowKey}`,
        value: JSON.stringify({ wagered: 15, lost: 15, windowKey }),
        gameServerId: ctx.gameServer.id,
        moduleId,
        playerId: player.playerId,
      });
    }

    const blocked = await triggerCommand(player.playerId, `${prefix}flip 6 heads`);
    assert.equal(blocked.success, false, 'expected oversized bet to be rejected before it can exceed loss cap');
    assert.ok(blocked.logs.some((msg) => /loss cap/i.test(msg) && /remaining/i.test(msg)), `expected actionable loss-cap message, logs=${JSON.stringify(blocked.logs)}`);
  });

  it('uses weekly cap windows and cleans up stale weekly rows', async () => {
    const player = ctx.players[0]!;
    const install = (await client.module.moduleInstallationsControllerGetModuleInstallation(moduleId, ctx.gameServer.id)).data.data;
    await client.module.moduleInstallationsControllerUninstallModule(moduleId, ctx.gameServer.id);
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        ...(install.userConfig as any),
        cooldownSeconds: 0,
        capWindow: 'weekly',
      },
    });

    const play = await triggerCommand(player.playerId, `${prefix}flip 5 heads`);
    assert.equal(play.success, true, `expected weekly-window flip success, logs=${JSON.stringify(play.logs)}`);

    const weeklyRows = await listPlayerVariables(player.playerId, 'casino_window:');
    assert.ok(weeklyRows.some((row) => /casino_window:\d{4}-W\d{2}$/.test(row.key)), `expected weekly window key, got ${JSON.stringify(weeklyRows.map((row) => row.key))}`);

    await client.variable.variableControllerCreate({
      key: 'casino_window:1999-W01',
      value: JSON.stringify({ wagered: 10, lost: 5, windowKey: '1999-W01' }),
      gameServerId: ctx.gameServer.id,
      moduleId,
      playerId: player.playerId,
    });

    const expireWeekly = await triggerCronjob(expireWindowsCronjobId);
    assert.equal(expireWeekly.success, true, `expected weekly expire-windows success, logs=${JSON.stringify(expireWeekly.logs)}`);
    assert.equal(await getVariable('casino_window:1999-W01', player.playerId), null, 'expected stale weekly row deletion');
  });
});
