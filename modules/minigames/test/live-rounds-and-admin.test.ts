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
  getCommandPrefix,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

const KEY_WORDLE = 'minigames_content_wordle';
const KEY_WORDLIST = 'minigames_content_wordlist';
const KEY_TRIVIA = 'minigames_content_trivia';
const KEY_ACTIVE = 'minigames_active_round';
const KEY_CACHE = 'minigames_leaderboard_cache';
const KEY_BAN = 'minigames_ban';
const KEY_STATS = 'minigames_stats';
const KEY_WINDOW = 'minigames_window';
const KEY_HISTORY = 'minigames_daily_history';
const KEY_LAST = 'minigames_last_round_fired_at';

async function upsertVariable(client: Client, gameServerId: string, moduleId: string, key: string, value: unknown, playerId?: string) {
  const res = await client.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
      ...(playerId ? { playerId: [playerId] } : {}),
    },
  });
  const serialized = JSON.stringify(value);
  const existing = res.data.data[0];
  if (existing) {
    await client.variable.variableControllerUpdate(existing.id, { value: serialized });
  } else {
    await client.variable.variableControllerCreate({ key, value: serialized, gameServerId, moduleId, ...(playerId ? { playerId } : {}) });
  }
}

async function readVariable(client: Client, gameServerId: string, moduleId: string, key: string, playerId?: string) {
  const res = await client.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
      ...(playerId ? { playerId: [playerId] } : {}),
    },
  });
  const existing = res.data.data[0];
  return existing ? JSON.parse(existing.value) : null;
}

async function emitChatMessage(client: Client, ctx: MockServerContext, playerId: string, msg: string, moduleId?: string) {
  await client.hook.hookControllerTrigger({
    gameServerId: ctx.gameServer.id,
    playerId,
    moduleId,
    eventType: 'chat-message',
    eventMeta: {
      msg,
      channel: 'global',
      playerId,
    },
  });
}

describe('minigames: live rounds, leaderboards, and admin controls', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let refreshCronId: string;
  let closeCronId: string;
  let fireCronId: string;
  let expireWindowsCronId: string;
  let expireBansCronId: string;
  let adminRoleId: string | undefined;
  let playerRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    refreshCronId = mod.latestVersion.cronJobs.find((c) => c.name === 'refreshLeaderboards')!.id;
    closeCronId = mod.latestVersion.cronJobs.find((c) => c.name === 'closeLiveRound')!.id;
    fireCronId = mod.latestVersion.cronJobs.find((c) => c.name === 'fireLiveRound')!.id;
    expireWindowsCronId = mod.latestVersion.cronJobs.find((c) => c.name === 'expireWindows')!.id;
    expireBansCronId = mod.latestVersion.cronJobs.find((c) => c.name === 'expireBans')!.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        triviaQuestionSource: 'custom',
        games: {
          wordle: true,
          hangman: true,
          hotcold: true,
          trivia: true,
          scramble: true,
          mathrace: true,
          reactionrace: true,
        },
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    adminRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, [
      'MINIGAMES_PLAY',
      'MINIGAMES_MANAGE',
    ]);
    playerRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, ['MINIGAMES_PLAY']);

    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WORDLE, { words: ['crane'] });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WORDLIST, { words: ['takaro', 'module', 'server'] });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_TRIVIA, {
      questions: [{ question: 'Best module platform?', options: ['Takaro', 'Other', 'Maybe', 'None'], answerIndex: 0 }],
    });
  });

  after(async () => {
    await cleanupRole(client, adminRoleId);
    await cleanupRole(client, playerRoleId);
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

  async function triggerCommand(playerId: string, msg: string) {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, { playerId, msg });
    return waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
  }

  async function triggerCron(cronjobId: string) {
    const before = new Date();
    await client.cronjob.cronJobControllerTrigger({ gameServerId: ctx.gameServer.id, cronjobId, moduleId });
    return waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
  }

  it('fires a forced scramble round and awards the winner through /answer', async () => {
    const fireEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesfirenow scramble`);
    const fireMeta = fireEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const fireLogs = (fireMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(fireMeta?.result?.success, true, `fire command should succeed, logs=${JSON.stringify(fireLogs)}`);
    assert.ok(fireLogs.some((msg) => msg.includes('live round fired game=scramble')), `expected scramble fire log, got ${JSON.stringify(fireLogs)}`);

    const round = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.equal(round.game, 'scramble');
    assert.ok(typeof round.answer === 'string' && round.answer.length >= 4);

    const answerEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}answer ${round.answer}`);
    const answerMeta = answerEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const answerLogs = (answerMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(answerMeta?.result?.success, true, `answer command should succeed, logs=${JSON.stringify(answerLogs)}`);
    assert.ok(answerLogs.some((msg) => msg.includes('live round settled game=scramble')), `expected settlement log, got ${JSON.stringify(answerLogs)}`);

    const cleared = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.equal(cleared, null, 'round should be cleared after a correct answer');

    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId);
    assert.equal(stats.perGame.scramble.wins, 1);
    assert.equal(stats.totalPoints, 40);
  });

  it('refreshes leaderboard cache and serves top points through both leaderboard commands', async () => {
    const refreshEvent = await triggerCron(refreshCronId);
    const meta = refreshEvent.meta as { result?: { success?: boolean } };
    assert.equal(meta?.result?.success, true, 'refreshLeaderboards should succeed');

    const cache = await readVariable(client, ctx.gameServer.id, moduleId, KEY_CACHE);
    assert.ok(Array.isArray(cache.topPoints));
    assert.ok(cache.topPoints.length >= 1);
    assert.equal(cache.topPoints[0].value, 40);
    assert.ok(cache.topPoints.every((entry: { value: number }) => entry.value > 0), `expected zero-value leaderboard entries to be filtered, got ${JSON.stringify(cache.topPoints)}`);

    const leaderboardEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}minigamesleaderboard points`);
    const leaderboardMeta = leaderboardEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const leaderboardLogs = (leaderboardMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(leaderboardMeta?.result?.success, true, 'minigamesleaderboard should succeed');
    assert.ok(leaderboardLogs.some((msg) => msg.includes('leaderboard category=points')), `expected canonical leaderboard log, got ${JSON.stringify(leaderboardLogs)}`);

    const topEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}minigamestop points`);
    const topMeta = topEvent.meta as { result?: { success?: boolean } };
    assert.equal(topMeta?.result?.success, true, 'minigamestop should still succeed as a legacy alias');
  });

  it('denies admin-only commands to non-admin players', async () => {
    const deniedEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}minigamesban nope`);
    const deniedMeta = deniedEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const deniedLogs = (deniedMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(deniedMeta?.result?.success, false, 'minigamesban should be denied without MINIGAMES_MANAGE');
    assert.ok(deniedLogs.some((msg) => msg.includes('You do not have permission to manage mini-games.')), `expected permission denial log, got ${JSON.stringify(deniedLogs)}`);
  });

  it('bans and unbans a player through admin commands', async () => {
    const playerRecord = await client.player.playerControllerGetOne(ctx.players[1].playerId);
    const targetName = playerRecord.data.data.name;
    const banEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesban ${targetName} 1`);
    const banMeta = banEvent.meta as { result?: { success?: boolean } };
    assert.equal(banMeta?.result?.success, true, 'minigamesban should succeed');

    const ban = await readVariable(client, ctx.gameServer.id, moduleId, KEY_BAN, ctx.players[1].playerId);
    assert.ok(ban.expiresAt, 'ban variable should contain expiry');

    const deniedEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}puzzle`);
    const deniedMeta = deniedEvent.meta as { result?: { success?: boolean } };
    assert.equal(deniedMeta?.result?.success, false, 'banned player should be denied');

    const unbanEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesunban ${targetName}`);
    const unbanMeta = unbanEvent.meta as { result?: { success?: boolean } };
    assert.equal(unbanMeta?.result?.success, true, 'minigamesunban should succeed');

    const clearedBan = await readVariable(client, ctx.gameServer.id, moduleId, KEY_BAN, ctx.players[1].playerId);
    assert.equal(clearedBan, null, 'ban variable should be removed after unban');
  });

  it('enforces the published MINIGAMES_BANNED permission even without a ban variable', async () => {
    const bannedRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, ['MINIGAMES_BANNED']);
    try {
      const deniedEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}puzzle`);
      const deniedMeta = deniedEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
      const deniedLogs = (deniedMeta?.result?.logs ?? []).map((l) => l.msg);
      assert.equal(deniedMeta?.result?.success, false, 'MINIGAMES_BANNED alone should block play');
      assert.ok(deniedLogs.some((msg) => msg.includes('You are banned from mini-games.')), `expected permission-backed ban denial, got ${JSON.stringify(deniedLogs)}`);
    } finally {
      await cleanupRole(client, bannedRoleId);
    }
  });

  it('does not consume a live round when the first winner cannot acquire the award lock', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'scramble',
      prompt: 'KRAOTA',
      answer: 'takaro',
      answerType: 'text',
      displayedOptions: [],
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await upsertVariable(client, ctx.gameServer.id, moduleId, `minigames_award_lock:${ctx.players[1].playerId}`, {
      token: 'test-lock',
      owner: 'test',
      createdAt: new Date().toISOString(),
    });

    const blockedEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}answer takaro`);
    const blockedMeta = blockedEvent.meta as { result?: { success?: boolean } };
    assert.equal(blockedMeta?.result?.success, false, 'answer should fail while the winner award lock is held');

    const stillActive = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.ok(stillActive, 'round should remain active after the blocked winner attempt');

    await client.variable.variableControllerDelete((await client.variable.variableControllerSearch({
      filters: { key: [`minigames_award_lock:${ctx.players[1].playerId}`], gameServerId: [ctx.gameServer.id], moduleId: [moduleId] },
    })).data.data[0]!.id);

    const recoveryEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}answer takaro`);
    const recoveryMeta = recoveryEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const recoveryLogs = (recoveryMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(recoveryMeta?.result?.success, true, `second player should still be able to win, logs=${JSON.stringify(recoveryLogs)}`);
    assert.ok(recoveryLogs.some((msg) => msg.includes('live round settled game=scramble')), `expected recovery settlement log, got ${JSON.stringify(recoveryLogs)}`);
  });

  it('settles only one winner when two players answer the same live round concurrently', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'trivia',
      prompt: 'Concurrent?',
      answer: 'takaro',
      answerType: 'text',
      displayedOptions: ['takaro', 'other'],
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const beforeA = (await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[0].playerId))?.perGame?.trivia?.wins || 0;
    const beforeB = (await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId))?.perGame?.trivia?.wins || 0;

    const [eventA, eventB] = await Promise.all([
      triggerCommand(ctx.players[0].playerId, `${prefix}answer takaro`),
      triggerCommand(ctx.players[1].playerId, `${prefix}answer takaro`),
    ]);

    const metaA = eventA.meta as { result?: { success?: boolean } };
    const metaB = eventB.meta as { result?: { success?: boolean } };
    assert.equal(metaA?.result?.success === true || metaA?.result?.success === false, true, 'first concurrent answer should complete');
    assert.equal(metaB?.result?.success === true || metaB?.result?.success === false, true, 'second concurrent answer should complete');

    const afterA = (await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[0].playerId))?.perGame?.trivia?.wins || 0;
    const afterB = (await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId))?.perGame?.trivia?.wins || 0;
    assert.equal((afterA - beforeA) + (afterB - beforeB), 1, `expected exactly one trivia win across both players, got before=(${beforeA},${beforeB}) after=(${afterA},${afterB})`);
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE), null, 'round should be cleared after the first successful settlement');
  });

  it('skips the active round through the admin command', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'scramble',
      prompt: 'KRAOTA',
      answer: 'takaro',
      answerType: 'text',
      displayedOptions: [],
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const skipEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesskiproundnow`);
    const skipMeta = skipEvent.meta as { result?: { success?: boolean } };
    assert.equal(skipMeta?.result?.success, true, 'minigamesskiproundnow should succeed');
    const cleared = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.equal(cleared, null, 'active round should be cleared after skip');
  });

  it('does not fire scheduled rounds below the online-player threshold', async () => {
    const staleLast = { firedAt: '2000-01-01T00:00:00.000Z' };
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_LAST, staleLast);
    await ctx.server.executeConsoleCommand('disconnectAll');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const event = await triggerCron(fireCronId);
    const meta = event.meta as { result?: { success?: boolean } };
    assert.equal(meta?.result?.success, true, 'fireLiveRound cron should execute');

    const round = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    const last = await readVariable(client, ctx.gameServer.id, moduleId, KEY_LAST);
    assert.equal(round, null, 'no active round should be created below threshold');
    assert.equal(last.firedAt, staleLast.firedAt, 'last-fired timestamp should remain unchanged when below threshold');

    await ctx.server.executeConsoleCommand('connectAll');
  });

  it('prevents answering an expired round even if cleanup has not run yet', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'trivia',
      prompt: 'Expired?',
      answer: 'takaro',
      answerType: 'text',
      displayedOptions: ['takaro', 'other'],
      startedAt: new Date(Date.now() - 120000).toISOString(),
      expiresAt: new Date(Date.now() - 60000).toISOString(),
    });

    const event = await triggerCommand(ctx.players[1].playerId, `${prefix}answer takaro`);
    const meta = event.meta as { result?: { success?: boolean } };
    assert.equal(meta?.result?.success, false, 'expired round answers should fail');

    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId);
    assert.equal(stats.perGame.trivia.wins, 0, 'expired round should not award a trivia win');
  });

  it('resets player stats, windows, and daily history', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, {
      totalPoints: 99,
      gamesPlayed: 2,
      biggestScore: { points: 99, game: 'scramble', at: new Date().toISOString() },
      perGame: {
        wordle: { points: 0, plays: 0, wins: 0 },
        hangman: { points: 0, plays: 0, wins: 0 },
        hotcold: { points: 0, plays: 0, wins: 0 },
        trivia: { points: 0, plays: 0, wins: 0 },
        scramble: { points: 99, plays: 2, wins: 2 },
        mathrace: { points: 0, plays: 0, wins: 0 },
        reactionrace: { points: 0, plays: 0, wins: 0 }
      },
      streaks: { wordle: { current: 0, best: 0, lastSolvedDate: null } }
    }, ctx.players[1].playerId);
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WINDOW, { date: today(), earned: 99 }, ctx.players[1].playerId);
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_HISTORY, {
      days: {
        [today()]: {
          date: today(),
          totalPoints: 99,
          gamesPlayed: 2,
          perGame: {
            wordle: { points: 0, plays: 0, wins: 0 },
            hangman: { points: 0, plays: 0, wins: 0 },
            hotcold: { points: 0, plays: 0, wins: 0 },
            trivia: { points: 0, plays: 0, wins: 0 },
            scramble: { points: 99, plays: 2, wins: 2 },
            mathrace: { points: 0, plays: 0, wins: 0 },
            reactionrace: { points: 0, plays: 0, wins: 0 }
          }
        }
      }
    }, ctx.players[1].playerId);

    const playerRecord = await client.player.playerControllerGetOne(ctx.players[1].playerId);
    const resetEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesresetstats ${playerRecord.data.data.name}`);
    const resetMeta = resetEvent.meta as { result?: { success?: boolean } };
    assert.equal(resetMeta?.result?.success, true, 'minigamesresetstats should succeed');
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId), null);
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_WINDOW, ctx.players[1].playerId), null);
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_HISTORY, ctx.players[1].playerId), null);
  });

  it('expires stale windows and temporary bans via cronjobs', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WINDOW, { date: '2000-01-01', earned: 10 }, ctx.players[1].playerId);
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_BAN, { expiresAt: '2000-01-01T00:00:00.000Z' }, ctx.players[1].playerId);

    const windowEvent = await triggerCron(expireWindowsCronId);
    const windowMeta = windowEvent.meta as { result?: { success?: boolean } };
    assert.equal(windowMeta?.result?.success, true, 'expireWindows should succeed');
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_WINDOW, ctx.players[1].playerId), null);

    const banEvent = await triggerCron(expireBansCronId);
    const banMeta = banEvent.meta as { result?: { success?: boolean } };
    assert.equal(banMeta?.result?.success, true, 'expireBans should succeed');
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_BAN, ctx.players[1].playerId), null);
  });

  it('runs the disconnect hook when players leave', async () => {
    await ctx.server.executeConsoleCommand('connectAll');
    const disconnectSettleMs = Number(process.env['TEST_DISCONNECT_SETTLE_MS'] ?? 2000);
    await new Promise((resolve) => setTimeout(resolve, disconnectSettleMs));
    const before = new Date();
    await ctx.server.executeConsoleCommand('disconnectAll');
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(meta?.result?.success, true, 'disconnect hook should succeed');
    assert.ok(logs.some((msg) => msg.includes('player disconnected')), `expected disconnect log, got ${JSON.stringify(logs)}`);
    await ctx.server.executeConsoleCommand('connectAll');
  });

  it('requires no optional hours argument for admin bans and clears stale bans after expiry cron', async () => {
    const playerRecord = await client.player.playerControllerGetOne(ctx.players[1].playerId);
    const targetName = playerRecord.data.data.name;

    const permanentBanEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesban ${targetName}`);
    const permanentBanMeta = permanentBanEvent.meta as { result?: { success?: boolean } };
    assert.equal(permanentBanMeta?.result?.success, true, 'minigamesban should succeed without hours');

    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_BAN, { expiresAt: '2000-01-01T00:00:00.000Z' }, ctx.players[1].playerId);
    const expireEvent = await triggerCron(expireBansCronId);
    const expireMeta = expireEvent.meta as { result?: { success?: boolean } };
    assert.equal(expireMeta?.result?.success, true, 'expireBans should succeed after converting to an expired temporary ban');

    const puzzleEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}puzzle`);
    const puzzleMeta = puzzleEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(puzzleMeta?.result?.success, true, 'expired bans should no longer block play');
  });

  it('shows usage errors when admin target arguments are omitted', async () => {
    const banEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesban`);
    const banMeta = banEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const banLogs = (banMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(banMeta?.result?.success, false, 'minigamesban without target should fail');
    assert.ok(banLogs.some((msg) => msg.includes('Usage: /minigamesban <player> [hours]')), `expected usage log, got ${JSON.stringify(banLogs)}`);

    const resetEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesresetstats`);
    const resetMeta = resetEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const resetLogs = (resetMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(resetMeta?.result?.success, false, 'minigamesresetstats without target should fail');
    assert.ok(resetLogs.some((msg) => msg.includes('Usage: /minigamesresetstats <player>')), `expected reset usage log, got ${JSON.stringify(resetLogs)}`);
  });

  it('accepts multi-word /answer responses for trivia rounds', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'trivia',
      prompt: 'Which city never sleeps?',
      answer: 'New York',
      answerType: 'text',
      displayedOptions: ['New York', 'Boston'],
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const event = await triggerCommand(ctx.players[1].playerId, `${prefix}answer New York`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(meta?.result?.success, true, `multi-word answer should succeed, logs=${JSON.stringify(logs)}`);
    assert.ok(logs.some((msg) => msg.includes('live round settled game=trivia')), `expected multi-word settlement log, got ${JSON.stringify(logs)}`);
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE), null, 'multi-word trivia round should clear after settlement');
  });

  it('settles trivia and mathrace rounds through /answer and logs read-only report output', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, null);

    const triviaFireEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesfirenow trivia`);
    const triviaFireMeta = triviaFireEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const triviaFireLogs = (triviaFireMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(triviaFireMeta?.result?.success, true, 'forced trivia round should fire');
    assert.ok(triviaFireLogs.some((msg) => msg.includes('live round fired game=trivia')), `expected forced trivia fire log, got ${JSON.stringify(triviaFireLogs)}`);

    const triviaRound = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.equal(triviaRound.game, 'trivia');
    const triviaAnswerEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}answer ${triviaRound.answer}`);
    const triviaAnswerMeta = triviaAnswerEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const triviaAnswerLogs = (triviaAnswerMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(triviaAnswerMeta?.result?.success, true, 'trivia answer should succeed');
    assert.ok(triviaAnswerLogs.some((msg) => msg.includes('live round settled game=trivia')), `expected trivia settlement log, got ${JSON.stringify(triviaAnswerLogs)}`);

    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'mathrace',
      prompt: '20 + 22 = ?',
      answer: '42',
      answerType: 'number',
      displayedOptions: [],
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const mathAnswerEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}answer 42`);
    const mathAnswerMeta = mathAnswerEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const mathAnswerLogs = (mathAnswerMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(mathAnswerMeta?.result?.success, true, 'mathrace answer should succeed');
    assert.ok(mathAnswerLogs.some((msg) => msg.includes('live round settled game=mathrace')), `expected math settlement log, got ${JSON.stringify(mathAnswerLogs)}`);

    const topEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}minigamestop points`);
    const topMeta = topEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const topLogs = (topMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(topMeta?.result?.success, true, 'minigamestop should succeed');
    assert.ok(topLogs.some((msg) => msg.includes('leaderboard category=points')), `expected leaderboard log, got ${JSON.stringify(topLogs)}`);

    const reportEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesreport`);
    const reportMeta = reportEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const reportLogs = (reportMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(reportMeta?.result?.success, true, 'minigamesreport should succeed without args');
    assert.ok(reportLogs.some((msg) => msg.includes('minigames: report days=7')), `expected report log, got ${JSON.stringify(reportLogs)}`);
    assert.ok(reportLogs.some((msg) => msg.includes('Top 5:')), `expected report content in logs, got ${JSON.stringify(reportLogs)}`);

    const invalidReportEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesreport 0`);
    const invalidReportMeta = invalidReportEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const invalidReportLogs = (invalidReportMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(invalidReportMeta?.result?.success, false, 'minigamesreport should reject invalid day windows');
    assert.ok(invalidReportLogs.some((msg) => msg.includes('Usage: /minigamesreport [days>0]')), `expected invalid-days usage log, got ${JSON.stringify(invalidReportLogs)}`);
  });

  it('settles reaction-race rounds through the chat-message hook and rejects /answer for chat-only rounds', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'reactionrace',
      prompt: '!go',
      answer: '!go',
      answerType: 'rawchat',
      displayedOptions: [],
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const commandEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}answer !go`);
    const commandMeta = commandEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const commandLogs = (commandMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(commandMeta?.result?.success, false, 'reactionrace should reject /answer');
    assert.ok(commandLogs.some((msg) => msg.includes('This round is chat-only')), `expected chat-only rejection, got ${JSON.stringify(commandLogs)}`);

    await emitChatMessage(client, ctx, ctx.players[1].playerId, '!go', moduleId);

    let cleared = undefined;
    let stats = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      cleared = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
      stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId);
      if (cleared === null && stats?.perGame?.reactionrace?.wins === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    assert.equal(cleared, null, `reactionrace round should clear after chat win; stats=${JSON.stringify(stats)}`);
    assert.equal(stats?.perGame?.reactionrace?.wins, 1, `expected reactionrace win to be recorded, stats=${JSON.stringify(stats)}`);
  });

  it('awards reaction-race to only one player when matching chat messages race each other', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'reactionrace',
      prompt: '!grab',
      answer: '!grab',
      answerType: 'rawchat',
      displayedOptions: [],
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const beforeA = (await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[0].playerId))?.perGame?.reactionrace?.wins || 0;
    const beforeB = (await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId))?.perGame?.reactionrace?.wins || 0;

    await Promise.all([
      emitChatMessage(client, ctx, ctx.players[0].playerId, '!grab', moduleId),
      emitChatMessage(client, ctx, ctx.players[1].playerId, '!grab', moduleId),
    ]);

    let afterA = beforeA;
    let afterB = beforeB;
    for (let attempt = 0; attempt < 20; attempt++) {
      afterA = (await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[0].playerId))?.perGame?.reactionrace?.wins || 0;
      afterB = (await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId))?.perGame?.reactionrace?.wins || 0;
      const cleared = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
      if (cleared === null && (afterA - beforeA) + (afterB - beforeB) === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    assert.equal((afterA - beforeA) + (afterB - beforeB), 1, `expected exactly one reaction-race win across both players, got before=(${beforeA},${beforeB}) after=(${afterA},${afterB})`);
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE), null, 'reaction-race round should be cleared after the first matching chat message');
  });

  it('supports offline player lookups for stats and admin reset commands', async () => {
    const playerRecord = await client.player.playerControllerGetOne(ctx.players[1].playerId);
    const targetName = playerRecord.data.data.name;

    await client.playerOnGameserver.playerOnGameServerControllerDelete(ctx.gameServer.id, ctx.players[1].playerId);
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, {
      totalPoints: 12,
      gamesPlayed: 1,
      biggestScore: { points: 12, game: 'scramble', at: new Date().toISOString() },
      perGame: {
        wordle: { points: 0, plays: 0, wins: 0 },
        hangman: { points: 0, plays: 0, wins: 0 },
        hotcold: { points: 0, plays: 0, wins: 0 },
        trivia: { points: 0, plays: 0, wins: 0 },
        scramble: { points: 12, plays: 1, wins: 1 },
        mathrace: { points: 0, plays: 0, wins: 0 },
        reactionrace: { points: 0, plays: 0, wins: 0 }
      },
      streaks: { wordle: { current: 0, best: 0, lastSolvedDate: null } }
    }, ctx.players[1].playerId);

    const statsEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamestats ${targetName}`);
    const statsMeta = statsEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const statsLogs = (statsMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(statsMeta?.result?.success, true, 'offline player stats lookup should succeed');
    assert.ok(statsLogs.some((msg) => msg.includes(`stats player=${targetName}`)), `expected offline-player stats lookup log, got ${JSON.stringify(statsLogs)}`);

    const resetEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesresetstats ${targetName}`);
    const resetMeta = resetEvent.meta as { result?: { success?: boolean } };
    assert.equal(resetMeta?.result?.success, true, 'offline player stat reset should succeed');
    assert.equal(await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId), null, 'offline target stats should be deleted');
  });

  it('closes an expired round via cronjob', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE, {
      game: 'trivia',
      prompt: 'Temporary question?',
      answer: 'takaro',
      answerType: 'text',
      displayedOptions: ['takaro', 'other'],
      startedAt: new Date(Date.now() - 120000).toISOString(),
      expiresAt: new Date(Date.now() - 60000).toISOString(),
    });

    const closeEvent = await triggerCron(closeCronId);
    const meta = closeEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(meta?.result?.success, true, 'closeLiveRound should succeed');
    assert.ok(logs.some((msg) => msg.includes('live round closed game=trivia')), `expected close log, got ${JSON.stringify(logs)}`);

    const cleared = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.equal(cleared, null, 'expired round should be removed');
  });
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

describe('minigames: trivia sources and live-round gating branches', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let adminRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        triviaQuestionSource: 'api',
        liveRoundIntervalMinutes: 5,
        minPlayersForLiveRound: 1,
        games: {
          wordle: true,
          hangman: true,
          hotcold: true,
          trivia: true,
          scramble: true,
          mathrace: true,
          reactionrace: false,
        },
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);
    adminRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, [
      'MINIGAMES_PLAY',
      'MINIGAMES_MANAGE',
    ]);

    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WORDLIST, { words: [] });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_TRIVIA, {
      questions: [{ question: 'Fallback question?', answer: 'fallback' }],
    });
  });

  after(async () => {
    await cleanupRole(client, adminRoleId);
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

  async function triggerCommand(playerId: string, msg: string) {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, { playerId, msg });
    return waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
  }

  it('fires an OpenTDB-backed trivia round when api mode is enabled', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_LAST, { firedAt: '2000-01-01T00:00:00.000Z' });
    const event = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesfirenow trivia`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(meta?.result?.success, true, `forced trivia round should fire, logs=${JSON.stringify(logs)}`);

    const round = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.equal(round.game, 'trivia');
    assert.ok(typeof round.prompt === 'string' && round.prompt.length > 0, 'trivia round should have a prompt');
    assert.ok(typeof round.answer === 'string' && round.answer.length > 0, 'trivia round should have an answer');

    const existing = await client.variable.variableControllerSearch({
      filters: { key: [KEY_ACTIVE], gameServerId: [ctx.gameServer.id], moduleId: [moduleId] },
    });
    if (existing.data.data[0]) {
      await client.variable.variableControllerDelete(existing.data.data[0].id);
    }
  });

  it('refuses forced rounds for disabled games', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_LAST, { firedAt: '2000-01-01T00:00:00.000Z' });
    const event = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesfirenow reactionrace`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(meta?.result?.success, true, 'disabled forced round command should still complete with feedback');
    assert.ok(logs.some((msg) => msg.includes('reactionrace is disabled on this server.')), `expected disabled-game guidance, got ${JSON.stringify(logs)}`);
  });

  it('refuses unknown forced round names with actionable guidance', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesfirenow typooooo`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(meta?.result?.success, true, 'unknown forced round command should complete with feedback');
    assert.ok(logs.some((msg) => msg.includes('Unknown live game "typooooo".')), `expected unknown-game guidance, got ${JSON.stringify(logs)}`);
  });

  it('returns no scramble round when the word bank is empty', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_LAST, { firedAt: '2000-01-01T00:00:00.000Z' });
    const event = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesfirenow scramble`);
    const meta = event.meta as { result?: { success?: boolean } };
    assert.equal(meta?.result?.success, true, 'empty-bank fire command should complete with feedback');
    const round = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    const warnings = await readVariable(client, ctx.gameServer.id, moduleId, 'minigames_admin_warned_empty_bank');
    assert.ok(!round || round.game !== 'scramble', 'scramble should not become active when the bank is empty');
    assert.ok(Array.isArray(warnings?.keys) && warnings.keys.includes(KEY_WORDLIST), `expected empty-bank warning to mention ${KEY_WORDLIST}, got ${JSON.stringify(warnings)}`);
  });
});
