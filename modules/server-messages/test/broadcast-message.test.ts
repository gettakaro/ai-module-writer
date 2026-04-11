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
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
const INDEX_KEY = 'server_messages_index';

describe('server-messages: broadcast-message cronjob', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

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

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected at least one cronjob in server-messages module');
    cronjobId = cronjob.id;
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

  async function clearMessageIndex(): Promise<void> {
    const vars = await client.variable.variableControllerSearch({
      filters: {
        key: [INDEX_KEY],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });

    for (const variable of vars.data.data) {
      await client.variable.variableControllerDelete(variable.id);
    }
  }

  async function reinstallModule(userConfig: Record<string, unknown>): Promise<void> {
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch {
      // Ignore if module was not installed yet.
    }

    await installModule(client, versionId, ctx.gameServer.id, { userConfig });
    await clearMessageIndex();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async function getOnlinePlayerCount(): Promise<number> {
    const res = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        online: [true],
      },
      page: 0,
      limit: 1,
    });

    return res.data.meta.total ?? 0;
  }

  async function waitForOnlinePlayerCount(expectedCount: number): Promise<void> {
    const maxWaitMs = 30000;
    const pollIntervalMs = 2000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const onlineCount = await getOnlinePlayerCount();
      if (onlineCount === expectedCount) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const finalCount = await getOnlinePlayerCount();
    throw new Error(`Timed out waiting for online player count ${expectedCount}; final count was ${finalCount}`);
  }

  async function triggerBroadcast(): Promise<{ success: boolean; logs: string[] }> {
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

    await new Promise((resolve) => setTimeout(resolve, 1000));

    return { success, logs };
  }

  it('sequential cycles in order', async () => {
    await reinstallModule({
      messages: ['Alpha', 'Beta', 'Gamma'],
      mode: 'sequential',
      minPlayers: 0,
    });

    const run1 = await triggerBroadcast();
    const run2 = await triggerBroadcast();
    const run3 = await triggerBroadcast();
    const run4 = await triggerBroadcast();

    for (const run of [run1, run2, run3, run4]) {
      assert.equal(run.success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(run.logs)}`);
    }

    assert.ok(
      run1.logs.some((msg) => msg.includes('index=0') && msg.includes('Alpha')),
      `Expected first run to send Alpha at index=0, got: ${JSON.stringify(run1.logs)}`,
    );
    assert.ok(
      run2.logs.some((msg) => msg.includes('index=1') && msg.includes('Beta')),
      `Expected second run to send Beta at index=1, got: ${JSON.stringify(run2.logs)}`,
    );
    assert.ok(
      run3.logs.some((msg) => msg.includes('index=2') && msg.includes('Gamma')),
      `Expected third run to send Gamma at index=2, got: ${JSON.stringify(run3.logs)}`,
    );
    assert.ok(
      run4.logs.some((msg) => msg.includes('index=0') && msg.includes('Alpha')),
      `Expected fourth run to wrap to Alpha at index=0, got: ${JSON.stringify(run4.logs)}`,
    );
  });

  it('random selects a message', async () => {
    await reinstallModule({
      messages: ['Red', 'Green', 'Amber'],
      mode: 'random',
      minPlayers: 0,
    });

    const { success, logs } = await triggerBroadcast();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) =>
        msg.includes('mode=random') && ['Red', 'Green', 'Amber'].some((candidate) => msg.includes(candidate)),
      ),
      `Expected a random broadcast log containing one configured message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('empty messages skips', async () => {
    await reinstallModule({
      messages: [],
      mode: 'sequential',
      minPlayers: 0,
    });

    const { success, logs } = await triggerBroadcast();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('skipping') && msg.includes('no messages configured')),
      `Expected empty-message skip log, got: ${JSON.stringify(logs)}`,
    );
  });

  it('minPlayers threshold skips', async () => {
    await reinstallModule({
      messages: ['Need a crowd'],
      mode: 'sequential',
      minPlayers: 999,
    });

    const { success, logs } = await triggerBroadcast();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes('below minPlayers 999')),
      `Expected minPlayers skip log, got: ${JSON.stringify(logs)}`,
    );
  });

  it('skips when no players are online', async () => {
    await reinstallModule({
      messages: ['Anyone there?'],
      mode: 'sequential',
      minPlayers: 0,
    });

    await ctx.server.executeConsoleCommand('disconnectAll');
    await waitForOnlinePlayerCount(0);

    try {
      const { success, logs } = await triggerBroadcast();

      assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some((msg) => msg.includes('skipping') && msg.includes('no players online')),
        `Expected no-players-online skip log, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      await ctx.server.executeConsoleCommand('connectAll');
      await waitForOnlinePlayerCount(ctx.players.length);
    }
  });

  it('template variables resolve playerCount using live player data', async () => {
    await reinstallModule({
      messages: ['There are {playerCount} players online'],
      mode: 'sequential',
      minPlayers: 0,
    });

    const expectedOnlineCount = await getOnlinePlayerCount();
    const { success, logs } = await triggerBroadcast();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes(`There are ${expectedOnlineCount} players online`)),
      `Expected playerCount template to resolve to ${expectedOnlineCount}, got: ${JSON.stringify(logs)}`,
    );
  });

  it('template variables resolve serverName', async () => {
    await reinstallModule({
      messages: ['Welcome to {serverName}'],
      mode: 'sequential',
      minPlayers: 0,
    });

    const gameServer = (await client.gameserver.gameServerControllerGetOne(ctx.gameServer.id)).data.data;
    const expectedServerName = gameServer?.name ?? 'Unknown Server';
    const { success, logs } = await triggerBroadcast();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((msg) => msg.includes(`Welcome to ${expectedServerName}`)),
      `Expected serverName template to resolve to ${expectedServerName}, got: ${JSON.stringify(logs)}`,
    );
  });
});
