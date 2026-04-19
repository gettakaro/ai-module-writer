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
