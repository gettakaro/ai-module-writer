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
  cleanupTestModules,
  cleanupTestGameServers,
} from '../../../test/helpers/modules.js';
import { collapsePlayersById, collectPaginatedResults, formatOnlinePlayersLine } from '../src/functions/utils-pure.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

describe('utils: public commands', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;

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
        discordLink: 'https://discord.gg/takaro',
        rules: ['No griefing', '   ', 'Be respectful', 'No cheating'],
        serverInfoMessage: 'No griefing outside claim areas. Join Discord with /discord',
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);
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

  async function trigger(playerId: string, msg: string) {
    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, { msg, playerId });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((l) => l.msg),
    };
  }

  async function getPlayerName(playerId: string) {
    const result = await client.player.playerControllerGetOne(playerId);
    return result.data.data.name;
  }

  async function waitForOnlineCount(expectedCount: number) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: {
          gameServerId: [ctx.gameServer.id],
          online: [true],
        },
      });
      if (result.data.data.length >= expectedCount) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${expectedCount} online players`);
  }

  it('serverinfo shows server name, online count, and configured info', async () => {
    const res = await trigger(ctx.players[0].playerId, `${prefix}serverinfo`);

    assert.equal(res.success, true, `Expected command to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes('Server: test-')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes('Players online: 3')), JSON.stringify(res.logs));
    assert.ok(
      res.logs.some((msg) => msg.includes('Info: No griefing outside claim areas. Join Discord with /discord')),
      JSON.stringify(res.logs),
    );
  });

  it('online shows empty message when nobody is online', async () => {
    await ctx.server.executeConsoleCommand('disconnectAll');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const res = await trigger(ctx.players[0].playerId, `${prefix}online`);

    assert.equal(res.success, true, `Expected command to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes('No players are currently online.')), JSON.stringify(res.logs));

    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnlineCount(3);
  });

  it('online lists online player names in alphabetical order with a pluralized count', async () => {
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnlineCount(3);

    const expectedNames = (await Promise.all(ctx.players.map((player) => getPlayerName(player.playerId))))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const res = await trigger(ctx.players[0].playerId, `${prefix}online`);

    assert.equal(res.success, true, `Expected command to succeed, logs: ${JSON.stringify(res.logs)}`);
    const expectedLine = `3 players online: ${expectedNames.join(', ')}`;
    assert.ok(res.logs.some((msg) => msg.includes(expectedLine)), JSON.stringify(res.logs));
  });

  it('online pagination helper walks multiple pages until the reported total is reached', async () => {
    const requestedPages: number[] = [];
    const players = await collectPaginatedResults(async ({ page, limit }: { page: number; limit: number }) => {
      requestedPages.push(page);
      assert.equal(limit, 2);

      const pages = [
        [
          { playerId: '1', playerName: 'Amy' },
          { playerId: '2', playerName: 'Bea' },
        ],
        [
          { playerId: '3', playerName: 'Cal' },
        ],
      ];

      return {
        data: pages[page] ?? [],
        total: 3,
      };
    }, { limit: 2 });

    assert.deepEqual(requestedPages, [0, 1]);
    assert.equal(players.length, 3);
  });

  it('online duplicate-collapse helper keeps the first record for each playerId', () => {
    const unique = collapsePlayersById([
      { playerId: '1', playerName: 'Amy', gameId: 'game-1' },
      { playerId: '1', playerName: 'Amy Duplicate', gameId: 'game-1b' },
      { playerId: '2', playerName: 'Bea', gameId: 'game-2' },
      { playerId: '2', playerName: 'Bea Duplicate', gameId: 'game-2b' },
      { playerId: '3', playerName: 'Cal', gameId: 'game-3' },
    ]);

    assert.deepEqual(
      unique.map((player: { playerId?: string; playerName?: string; gameId?: string }) => ({ playerId: player.playerId, playerName: player.playerName, gameId: player.gameId })),
      [
        { playerId: '1', playerName: 'Amy', gameId: 'game-1' },
        { playerId: '2', playerName: 'Bea', gameId: 'game-2' },
        { playerId: '3', playerName: 'Cal', gameId: 'game-3' },
      ],
    );
  });

  it('online formatter truncates after 10 visible names', () => {
    const line = formatOnlinePlayersLine([
      { playerName: 'Zed' },
      { playerName: 'Amy' },
      { playerName: 'Bea' },
      { playerName: 'Cal' },
      { playerName: 'Dex' },
      { playerName: 'Eli' },
      { playerName: 'Fox' },
      { playerName: 'Gia' },
      { playerName: 'Hal' },
      { playerName: 'Ivy' },
      { playerName: 'Jae' },
      { playerName: 'Kai' },
    ]);

    assert.equal(line, '12 players online: Amy, Bea, Cal, Dex, Eli, Fox, Gia, Hal, Ivy, Jae, ...');
  });

  it('discord shows the configured link', async () => {
    const res = await trigger(ctx.players[0].playerId, `${prefix}discord`);

    assert.equal(res.success, true, `Expected command to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes('Join our Discord: https://discord.gg/takaro')), JSON.stringify(res.logs));
  });

  it('rules shows numbered non-blank rules', async () => {
    const res = await trigger(ctx.players[0].playerId, `${prefix}rules`);

    assert.equal(res.success, true, `Expected command to succeed, logs: ${JSON.stringify(res.logs)}`);
    assert.ok(res.logs.some((msg) => msg.includes('Server rules:')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes('1. No griefing')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes('2. Be respectful')), JSON.stringify(res.logs));
    assert.ok(res.logs.some((msg) => msg.includes('3. No cheating')), JSON.stringify(res.logs));
  });
});
