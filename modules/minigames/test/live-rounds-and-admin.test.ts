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

  it('refreshes leaderboard cache and serves top points', async () => {
    const refreshEvent = await triggerCron(refreshCronId);
    const meta = refreshEvent.meta as { result?: { success?: boolean } };
    assert.equal(meta?.result?.success, true, 'refreshLeaderboards should succeed');

    const cache = await readVariable(client, ctx.gameServer.id, moduleId, KEY_CACHE);
    assert.ok(Array.isArray(cache.topPoints));
    assert.ok(cache.topPoints.length >= 1);
    assert.equal(cache.topPoints[0].value, 40);

    const topEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}minigamestop points`);
    const topMeta = topEvent.meta as { result?: { success?: boolean } };
    assert.equal(topMeta?.result?.success, true, 'minigamestop should succeed');
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
    await ctx.server.executeConsoleCommand('disconnectAll');
    const event = await triggerCron(fireCronId);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(meta?.result?.success, true, 'fireLiveRound cron should execute');
    assert.ok(logs.some((msg) => msg.includes('fire skipped due to onlinePlayers=0')), `expected threshold skip log, got ${JSON.stringify(logs)}`);
    const round = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.equal(round, null, 'no active round should be created below threshold');
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

  it('settles trivia and mathrace rounds through /answer and logs read-only report output', async () => {
    const triviaFireEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesfirenow trivia`);
    const triviaFireMeta = triviaFireEvent.meta as { result?: { success?: boolean } };
    assert.equal(triviaFireMeta?.result?.success, true, 'forced trivia round should fire');

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

    const before = new Date();
    (ctx.server as any).emitEvent('chat-message', {
      player: ctx.players[1].gameId,
      msg: '!go',
      channel: 'global',
    });
    const hookEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.HookExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const hookMeta = hookEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const hookLogs = (hookMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(hookMeta?.result?.success, true, 'reactionrace hook should succeed');
    assert.ok(hookLogs.some((msg) => msg.includes('live round settled game=reactionrace')), `expected reaction settlement log, got ${JSON.stringify(hookLogs)}`);

    const cleared = await readVariable(client, ctx.gameServer.id, moduleId, KEY_ACTIVE);
    assert.equal(cleared, null, 'reactionrace round should clear after chat win');
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
