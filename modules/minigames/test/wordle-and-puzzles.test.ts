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
const KEY_PUZZLE = 'minigames_puzzle_today';
const KEY_STATS = 'minigames_stats';
const KEY_WINDOW = 'minigames_window';
const KEY_HISTORY = 'minigames_daily_history';

function newestVariable<T extends { id: string; createdAt?: string; updatedAt?: string }>(records: T[]) {
  return [...records].sort((left, right) => {
    const leftTs = new Date(left.updatedAt || left.createdAt || 0).getTime();
    const rightTs = new Date(right.updatedAt || right.createdAt || 0).getTime();
    if (leftTs !== rightTs) return rightTs - leftTs;
    return String(right.id).localeCompare(String(left.id));
  })[0];
}

async function upsertVariable(client: Client, gameServerId: string, moduleId: string, key: string, value: unknown, playerId?: string) {
  const res = await client.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
      ...(playerId ? { playerId: [playerId] } : {}),
    },
    limit: 100,
  });
  const serialized = JSON.stringify(value);
  const existing = newestVariable(res.data.data);
  if (existing) {
    try {
      await client.variable.variableControllerUpdate(existing.id, { value: serialized });
      await Promise.allSettled(res.data.data.filter((entry) => entry.id !== existing.id).map((entry) => client.variable.variableControllerDelete(entry.id)));
      return;
    } catch {
      await Promise.allSettled(res.data.data.map((entry) => client.variable.variableControllerDelete(entry.id)));
    }
  }
  await client.variable.variableControllerCreate({ key, value: serialized, gameServerId, moduleId, ...(playerId ? { playerId } : {}) });
}

async function readVariable(client: Client, gameServerId: string, moduleId: string, key: string, playerId?: string) {
  const res = await client.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
      ...(playerId ? { playerId: [playerId] } : {}),
    },
    limit: 100,
  });
  const existing = newestVariable(res.data.data);
  return existing ? JSON.parse(existing.value) : null;
}

describe('minigames: daily puzzles and wordle scoring', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let cronRolloverId: string;
  let playRoleId: string | undefined;
  let boostRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    cronRolloverId = mod.latestVersion.cronJobs.find((c) => c.name === 'rolloverDailyPuzzles')!.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        pointsToCurrencyRate: 0.5,
        bigScoreThreshold: 100,
        liveRoundIntervalMinutes: 5,
        minPlayersForLiveRound: 2,
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    playRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['MINIGAMES_PLAY']);
    boostRoleId = await assignPermissions(client, ctx.players[1].playerId, ctx.gameServer.id, [
      { code: 'MINIGAMES_PLAY' },
      { code: 'MINIGAMES_BOOST', count: 2 },
    ]);

    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WORDLE, { words: ['crane'] });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WORDLIST, { words: ['takaro', 'module', 'server'] });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_TRIVIA, { questions: [{ question: '2+2?', answer: '4' }] });
  });

  after(async () => {
    await cleanupRole(client, playRoleId);
    await cleanupRole(client, boostRoleId);
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

  it('rolloverDailyPuzzles seeds today\'s puzzle state', async () => {
    const event = await triggerCron(cronRolloverId);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'expected rolloverDailyPuzzles to succeed');

    const puzzle = await readVariable(client, ctx.gameServer.id, moduleId, KEY_PUZZLE);
    assert.equal(puzzle.wordle, 'crane');
    assert.ok(typeof puzzle.hangman === 'string');
    assert.ok(Number.isInteger(puzzle.hotcold));
  });

  it('shows top-level help without requiring a game argument', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, `${prefix}minigames`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(meta?.result?.success, true, 'minigames help should succeed without args');
    assert.ok(logs.some((msg) => msg.includes('minigames: help overview=')), `expected help overview log, got ${JSON.stringify(logs)}`);
    assert.ok(logs.some((msg) => msg.includes('Daily puzzles: /wordle, /hangman, /hotcold, /puzzle')), `expected help content in logs, got ${JSON.stringify(logs)}`);
  });

  it('rejects play commands for players without MINIGAMES_PLAY', async () => {
    const event = await triggerCommand(ctx.players[2].playerId, `${prefix}wordle crane`);
    const meta = event.meta as { result?: { success?: boolean } };
    assert.equal(meta?.result?.success, false, 'wordle should be denied without MINIGAMES_PLAY');
  });

  it('rejects invalid wordle guesses not present in the bank', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle zzzzz`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'invalid word should fail');
  });

  it('covers daily-puzzle validation branches for malformed, duplicate, and exhausted submissions', async () => {
    const malformedWordle = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle toolong`);
    const malformedWordleMeta = malformedWordle.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(malformedWordleMeta?.result?.success, false, 'malformed wordle guess should fail');
    assert.ok((malformedWordleMeta?.result?.logs ?? []).some((entry) => entry.msg.includes('exactly 5 letters')), 'expected exact-length guidance for malformed wordle');

    await upsertVariable(client, ctx.gameServer.id, moduleId, 'minigames_session_wordle', {
      guesses: ['crane'],
      solved: false,
      completedAt: null,
      lastPoints: 0,
    }, ctx.players[0].playerId);
    const duplicateWordle = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle crane`);
    const duplicateWordleMeta = duplicateWordle.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(duplicateWordleMeta?.result?.success, false, 'duplicate wordle guess should fail');
    assert.ok((duplicateWordleMeta?.result?.logs ?? []).some((entry) => entry.msg.includes('already guessed that word')), 'expected duplicate-wordle guidance');

    await upsertVariable(client, ctx.gameServer.id, moduleId, 'minigames_session_wordle', {
      guesses: ['aaaaa', 'bbbbb', 'ccccc', 'ddddd', 'eeeee', 'fffff'],
      solved: false,
      completedAt: null,
      lastPoints: 0,
    }, ctx.players[0].playerId);
    const exhaustedWordle = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle crane`);
    const exhaustedWordleMeta = exhaustedWordle.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(exhaustedWordleMeta?.result?.success, false, 'exhausted wordle should fail');
    assert.ok((exhaustedWordleMeta?.result?.logs ?? []).some((entry) => entry.msg.includes('used all 6 Wordle guesses')), 'expected exhausted-wordle guidance');

    await upsertVariable(client, ctx.gameServer.id, moduleId, 'minigames_session_hangman', {
      lettersTried: [],
      wrongCount: 0,
      solved: false,
      completedAt: null,
      lastPoints: 0,
    }, ctx.players[0].playerId);
    const invalidHangman = await triggerCommand(ctx.players[0].playerId, `${prefix}hangman 7`);
    const invalidHangmanMeta = invalidHangman.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(invalidHangmanMeta?.result?.success, false, 'non-letter hangman guess should fail');
    assert.ok((invalidHangmanMeta?.result?.logs ?? []).some((entry) => entry.msg.includes('letters only')), 'expected non-letter hangman guidance');

    await upsertVariable(client, ctx.gameServer.id, moduleId, 'minigames_session_hangman', {
      lettersTried: ['t'],
      wrongCount: 0,
      solved: false,
      completedAt: null,
      lastPoints: 0,
    }, ctx.players[0].playerId);
    const duplicateHangman = await triggerCommand(ctx.players[0].playerId, `${prefix}hangman t`);
    const duplicateHangmanMeta = duplicateHangman.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(duplicateHangmanMeta?.result?.success, false, 'duplicate hangman letter should fail');
    assert.ok((duplicateHangmanMeta?.result?.logs ?? []).some((entry) => entry.msg.includes('already tried that letter')), 'expected duplicate-letter hangman guidance');

    const invalidHotCold = await triggerCommand(ctx.players[0].playerId, `${prefix}hotcold 1001`);
    const invalidHotColdMeta = invalidHotCold.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(invalidHotColdMeta?.result?.success, false, 'out-of-range hotcold guess should fail');
    assert.ok((invalidHotColdMeta?.result?.logs ?? []).some((entry) => entry.msg.includes('integer from 1 to 1000')), 'expected hotcold range guidance');

    await client.variable.variableControllerSearch({
      filters: {
        key: ['minigames_session_wordle', 'minigames_session_hangman'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        playerId: [ctx.players[0].playerId],
      },
    }).then(async (res) => Promise.all(res.data.data.map((entry) => client.variable.variableControllerDelete(entry.id))));
  });

  it('awards boosted wordle points, history, announces the big score, and pays currency on solve', async () => {
    const beforePogSearch = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[1].playerId] },
    });
    const beforeCurrency = Number(beforePogSearch.data.data[0]?.currency || 0);

    const event = await triggerCommand(ctx.players[1].playerId, `${prefix}wordle crane`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);

    assert.equal(meta?.result?.success, true, `expected solve success, logs=${JSON.stringify(logs)}`);
    assert.ok(logs.some((msg) => msg.includes('wordle: solved')), `expected solve log, got ${JSON.stringify(logs)}`);
    assert.ok(logs.some((msg) => msg.includes('minigames: award game=wordle') && msg.includes('actual=150') && msg.includes('currency=75')), `expected structured award log, got ${JSON.stringify(logs)}`);

    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId);
    const window = await readVariable(client, ctx.gameServer.id, moduleId, KEY_WINDOW, ctx.players[1].playerId);
    const history = await readVariable(client, ctx.gameServer.id, moduleId, KEY_HISTORY, ctx.players[1].playerId);
    assert.equal(stats.totalPoints, 150, '100 base with boost count=2 should award 150');
    assert.equal(stats.perGame.wordle.wins, 1);
    assert.equal(window.earned, 150);
    assert.equal(history.days[puzzleDate()].totalPoints, 150);
    assert.equal(history.days[puzzleDate()].perGame.wordle.wins, 1);

    let foundBigScoreAnnouncement = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const recentEvents = await client.event.eventControllerSearch({
        filters: {
          gameserverId: [ctx.gameServer.id],
        },
        greaterThan: {
          createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        },
        limit: 50,
        sortDirection: 'desc',
        sortBy: 'createdAt',
      });
      foundBigScoreAnnouncement = recentEvents.data.data.some((entry) => {
        const entryMeta = entry.meta as { msg?: string } | undefined;
        return String(entry.eventName) === 'chat-message' && String(entryMeta?.msg || '').includes('BIG SCORE!');
      });
      if (foundBigScoreAnnouncement) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(foundBigScoreAnnouncement, true, 'expected a big-score chat announcement event');

    const afterPogSearch = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[1].playerId] },
    });
    const pog = afterPogSearch.data.data[0];
    assert.ok(pog, 'expected playerOnGameserver record');
    assert.equal(Number(pog!.currency || 0) - beforeCurrency, 75, 'expected the 0.5 currency conversion to pay out 75 currency for a 150-point solve');
  });

  it('awards hangman success points and persists completion state', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_PUZZLE, { date: puzzleDate(), wordle: 'crane', hangman: 'takaro', hotcold: 321 });
    const solveEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}hangman takaro`);
    const solveMeta = solveEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const solveLogs = (solveMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(solveMeta?.result?.success, true, `hangman solve should succeed, logs=${JSON.stringify(solveLogs)}`);

    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId);
    const history = await readVariable(client, ctx.gameServer.id, moduleId, KEY_HISTORY, ctx.players[1].playerId);
    const hangmanSession = await readVariable(client, ctx.gameServer.id, moduleId, 'minigames_session_hangman', ctx.players[1].playerId);
    assert.equal(stats.perGame.hangman.wins, 1);
    assert.ok(stats.perGame.hangman.points > 0, 'hangman solve should award points');
    assert.equal(history.days[puzzleDate()].perGame.hangman.wins, 1);
    assert.equal(hangmanSession.solved, true);
    assert.ok(hangmanSession.completedAt, 'hangman session should be marked completed');
  });

  it('tracks hangman failures in lifetime stats and daily history', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_PUZZLE, { date: puzzleDate(), wordle: 'crane', hangman: 'takaro', hotcold: 321 });
    for (const guess of ['x', 'y', 'z', 'q', 'w', 'p']) {
      const event = await triggerCommand(ctx.players[0].playerId, `${prefix}hangman ${guess}`);
      const meta = event.meta as { result?: { success?: boolean } };
      assert.equal(meta?.result?.success, true, `hangman guess ${guess} should execute`);
    }
    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[0].playerId);
    const history = await readVariable(client, ctx.gameServer.id, moduleId, KEY_HISTORY, ctx.players[0].playerId);
    assert.equal(stats.perGame.hangman.plays, 1);
    assert.equal(stats.perGame.hangman.wins, 0);
    assert.equal(history.days[puzzleDate()].perGame.hangman.plays, 1);
    assert.equal(history.days[puzzleDate()].perGame.hangman.wins, 0);
  });

  it('awards hotcold success points and persists completion state', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_PUZZLE, { date: puzzleDate(), wordle: 'crane', hangman: 'takaro', hotcold: 321 });
    const solveEvent = await triggerCommand(ctx.players[1].playerId, `${prefix}hotcold 321`);
    const solveMeta = solveEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const solveLogs = (solveMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(solveMeta?.result?.success, true, `hotcold solve should succeed, logs=${JSON.stringify(solveLogs)}`);

    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId);
    const history = await readVariable(client, ctx.gameServer.id, moduleId, KEY_HISTORY, ctx.players[1].playerId);
    const hotcoldSession = await readVariable(client, ctx.gameServer.id, moduleId, 'minigames_session_hotcold', ctx.players[1].playerId);
    assert.equal(stats.perGame.hotcold.wins, 1);
    assert.ok(stats.perGame.hotcold.points > 0, 'hotcold solve should award points');
    assert.equal(history.days[puzzleDate()].perGame.hotcold.wins, 1);
    assert.equal(hotcoldSession.solved, true);
    assert.ok(hotcoldSession.completedAt, 'hotcold session should be marked completed');
  });

  it('tracks hotcold failures in lifetime stats and daily history', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_PUZZLE, { date: puzzleDate(), wordle: 'crane', hangman: 'takaro', hotcold: 321 });
    for (const guess of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const event = await triggerCommand(ctx.players[0].playerId, `${prefix}hotcold ${guess}`);
      const meta = event.meta as { result?: { success?: boolean } };
      assert.equal(meta?.result?.success, true, `hotcold guess ${guess} should execute`);
    }
    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[0].playerId);
    const history = await readVariable(client, ctx.gameServer.id, moduleId, KEY_HISTORY, ctx.players[0].playerId);
    assert.equal(stats.perGame.hotcold.plays, 1);
    assert.equal(stats.perGame.hotcold.wins, 0);
    assert.equal(history.days[puzzleDate()].perGame.hotcold.plays, 1);
    assert.equal(history.days[puzzleDate()].perGame.hotcold.wins, 0);
  });

  it('preserves an in-progress wordle session across disconnect and reconnect', async () => {
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WORDLE, { words: ['crane', 'slate'] });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_PUZZLE, { date: puzzleDate(), wordle: 'crane', hangman: 'takaro', hotcold: 321 });
    const guessEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle slate`);
    const guessMeta = guessEvent.meta as { result?: { success?: boolean } };
    assert.equal(guessMeta?.result?.success, true, 'wordle guess should succeed before reconnect');

    await ctx.server.executeConsoleCommand('disconnectAll');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await ctx.server.executeConsoleCommand('connectAll');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const statusEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle`);
    const statusMeta = statusEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const statusLogs = (statusMeta?.result?.logs ?? []).map((l) => l.msg);
    const wordleSession = await readVariable(client, ctx.gameServer.id, moduleId, 'minigames_session_wordle', ctx.players[0].playerId);
    assert.equal(statusMeta?.result?.success, true, 'wordle status should succeed after reconnect');
    assert.ok(statusLogs.some((msg) => msg.includes('wordle: status player=') && msg.includes('guesses=1') && msg.includes('solved=false')), `expected wordle status log, got ${JSON.stringify(statusLogs)}`);
    assert.deepEqual(wordleSession.guesses, ['slate'], `expected in-progress session to persist across reconnect, got ${JSON.stringify(wordleSession)}`);
    assert.equal(wordleSession.solved, false, 'session should remain unsolved after reconnect');
  });

  it('shows puzzle and minigamestats without optional arguments', async () => {
    const puzzleEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}puzzle`);
    const puzzleMeta = puzzleEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const puzzleLogs = (puzzleMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(puzzleMeta?.result?.success, true, 'puzzle should succeed without args');
    assert.ok(puzzleLogs.some((msg) => msg.includes('minigames: puzzle status=')), `expected puzzle status log, got ${JSON.stringify(puzzleLogs)}`);
    assert.ok(puzzleLogs.some((msg) => msg.includes('Wordle:')), `expected puzzle status content, got ${JSON.stringify(puzzleLogs)}`);
    assert.ok(puzzleLogs.some((msg) => msg.includes('completed') || msg.includes('failed')), `expected explicit completed/failed wording, got ${JSON.stringify(puzzleLogs)}`);

    const statsEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamestats`);
    const statsMeta = statsEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const statsLogs = (statsMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(statsMeta?.result?.success, true, 'minigamestats should succeed without args');
    assert.ok(statsLogs.some((msg) => msg.includes('minigames: stats player=')), `expected stats log, got ${JSON.stringify(statsLogs)}`);
    assert.ok(statsLogs.some((msg) => msg.includes('Total points:')), `expected stats content in logs, got ${JSON.stringify(statsLogs)}`);
  });

  it('reports helpful lookup and argument errors for player, help, and leaderboard branches', async () => {
    const missingStatsEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamestats definitely-not-a-player`);
    const missingStatsMeta = missingStatsEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const missingStatsLogs = (missingStatsMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(missingStatsMeta?.result?.success, true, 'minigamestats missing-player branch should return a friendly PM');
    assert.ok(missingStatsLogs.some((msg) => msg.includes('Player "definitely-not-a-player" not found.')), `expected missing-player message, got ${JSON.stringify(missingStatsLogs)}`);

    const helpTopicEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigames reactionrace`);
    const helpTopicMeta = helpTopicEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const helpTopicLogs = (helpTopicMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(helpTopicMeta?.result?.success, true, 'game-specific help should succeed');
    assert.ok(helpTopicLogs.some((msg) => msg.includes('type the token directly in chat')), `expected reactionrace help branch, got ${JSON.stringify(helpTopicLogs)}`);

    const unknownHelpEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigames mysterygame`);
    const unknownHelpMeta = unknownHelpEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const unknownHelpLogs = (unknownHelpMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(unknownHelpMeta?.result?.success, true, 'unknown help topics should still respond');
    assert.ok(unknownHelpLogs.some((msg) => msg.includes('Unknown game "mysterygame"')), `expected unknown-game message, got ${JSON.stringify(unknownHelpLogs)}`);

    const invalidLeaderboardEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}minigamesleaderboard bananas`);
    const invalidLeaderboardMeta = invalidLeaderboardEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const invalidLeaderboardLogs = (invalidLeaderboardMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(invalidLeaderboardMeta?.result?.success, false, 'invalid leaderboard categories should fail');
    assert.ok(invalidLeaderboardLogs.some((msg) => msg.includes('Category must be one of: points, wordle, hangman, streak.')), `expected invalid-category message, got ${JSON.stringify(invalidLeaderboardLogs)}`);
  });
});

function puzzleDate() {
  return new Date().toISOString().slice(0, 10);
}

describe('minigames: daily puzzle feature flags', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let playRoleId: string | undefined;

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
        games: {
          wordle: false,
          hangman: false,
          hotcold: false,
          trivia: true,
          scramble: true,
          mathrace: true,
          reactionrace: true,
        },
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);
    playRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['MINIGAMES_PLAY']);
  });

  after(async () => {
    await cleanupRole(client, playRoleId);
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

  it('blocks disabled daily puzzle commands and reports disabled status', async () => {
    const wordleEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle crane`);
    const wordleMeta = wordleEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const wordleLogs = (wordleMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(wordleMeta?.result?.success, false, 'disabled wordle should fail');
    assert.ok(wordleLogs.some((msg) => msg.includes('Wordle is disabled on this server.')), `expected disabled wordle log, got ${JSON.stringify(wordleLogs)}`);

    const hangmanEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}hangman t`);
    const hangmanMeta = hangmanEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const hangmanLogs = (hangmanMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(hangmanMeta?.result?.success, false, 'disabled hangman should fail');
    assert.ok(hangmanLogs.some((msg) => msg.includes('Hangman is disabled on this server.')), `expected disabled hangman log, got ${JSON.stringify(hangmanLogs)}`);

    const hotcoldEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}hotcold 5`);
    const hotcoldMeta = hotcoldEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const hotcoldLogs = (hotcoldMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(hotcoldMeta?.result?.success, false, 'disabled hotcold should fail');
    assert.ok(hotcoldLogs.some((msg) => msg.includes('Hot/Cold is disabled on this server.')), `expected disabled hotcold log, got ${JSON.stringify(hotcoldLogs)}`);

    const puzzleEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}puzzle`);
    const puzzleMeta = puzzleEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const puzzleLogs = (puzzleMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(puzzleMeta?.result?.success, true, 'puzzle should still succeed');
    assert.ok(puzzleLogs.some((msg) => msg.includes('Wordle: disabled')), `expected disabled wordle status, got ${JSON.stringify(puzzleLogs)}`);
    assert.ok(puzzleLogs.some((msg) => msg.includes('Hangman: disabled')), `expected disabled hangman status, got ${JSON.stringify(puzzleLogs)}`);
    assert.ok(puzzleLogs.some((msg) => msg.includes('Hot/Cold: disabled')), `expected disabled hotcold status, got ${JSON.stringify(puzzleLogs)}`);
  });
});

describe('minigames: daily point cap enforcement', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let cronRolloverId: string;
  let playRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    cronRolloverId = mod.latestVersion.cronJobs.find((c) => c.name === 'rolloverDailyPuzzles')!.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        dailyPointsCapPerPlayer: 50,
        pointsWordleBase: 100,
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);
    playRoleId = await assignPermissions(client, ctx.players[0].playerId, ctx.gameServer.id, ['MINIGAMES_PLAY']);

    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WORDLE, { words: ['crane'] });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_WORDLIST, { words: ['takaro'] });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_TRIVIA, { questions: [{ question: '2+2?', answer: '4' }] });

    const before = new Date();
    await client.cronjob.cronJobControllerTrigger({ gameServerId: ctx.gameServer.id, cronjobId: cronRolloverId, moduleId });
    await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    await upsertVariable(client, ctx.gameServer.id, moduleId, KEY_PUZZLE, { date: puzzleDate(), wordle: 'crane', hangman: 'takaro', hotcold: 321 });
  });

  after(async () => {
    await cleanupRole(client, playRoleId);
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

  it('clips awards to the remaining cap and still allows further puzzle attempts that day', async () => {
    const solveEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle crane`);
    const solveMeta = solveEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const solveLogs = (solveMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(solveMeta?.result?.success, true, `wordle solve should succeed, logs=${JSON.stringify(solveLogs)}`);

    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[0].playerId);
    const window = await readVariable(client, ctx.gameServer.id, moduleId, KEY_WINDOW, ctx.players[0].playerId);
    assert.equal(stats.totalPoints, 50, 'wordle reward should be clipped to the configured daily cap');
    assert.equal(window.earned, 50, 'daily window should stop at the cap');

    const followupEvent = await triggerCommand(ctx.players[0].playerId, `${prefix}hangman t`);
    const followupMeta = followupEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const followupLogs = (followupMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.equal(followupMeta?.result?.success, true, `further puzzle attempts should still run after cap exhaustion, logs=${JSON.stringify(followupLogs)}`);

    const updatedStats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[0].playerId);
    const updatedWindow = await readVariable(client, ctx.gameServer.id, moduleId, KEY_WINDOW, ctx.players[0].playerId);
    assert.equal(updatedStats.totalPoints, 50, 'follow-up attempts should not award points beyond the cap');
    assert.equal(updatedWindow.earned, 50, 'daily window should remain capped after follow-up attempts');
  });
});
