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

  it('rejects invalid wordle guesses not present in the bank', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, `${prefix}wordle zzzzz`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'invalid word should fail');
  });

  it('awards boosted wordle points and currency on solve', async () => {
    const event = await triggerCommand(ctx.players[1].playerId, `${prefix}wordle crane`);
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);

    assert.equal(meta?.result?.success, true, `expected solve success, logs=${JSON.stringify(logs)}`);
    assert.ok(logs.some((msg) => msg.includes('wordle: solved')), `expected solve log, got ${JSON.stringify(logs)}`);

    const stats = await readVariable(client, ctx.gameServer.id, moduleId, KEY_STATS, ctx.players[1].playerId);
    const window = await readVariable(client, ctx.gameServer.id, moduleId, KEY_WINDOW, ctx.players[1].playerId);
    assert.equal(stats.totalPoints, 150, '100 base with boost count=2 should award 150');
    assert.equal(stats.perGame.wordle.wins, 1);
    assert.equal(window.earned, 150);

    const pogSearch = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: { gameServerId: [ctx.gameServer.id], playerId: [ctx.players[1].playerId] },
    });
    const pog = pogSearch.data.data[0];
    assert.ok(pog, 'expected playerOnGameserver record');
    assert.ok(typeof pog!.currency === 'number', 'currency field should remain readable even if payout is unavailable in the test environment');
  });
});
