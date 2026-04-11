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
const MESSAGE_INDEX_KEY = 'server_messages_index';

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

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected at least one cronjob in server-messages module');
    cronjobId = cronjob.id;

    await reinstallModule({
      messages: ['Welcome!', 'Join our Discord!', 'Type /help for commands'],
      mode: 'sequential',
      minPlayers: 0,
    });
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
    const existing = await client.variable.variableControllerSearch({
      filters: {
        key: [MESSAGE_INDEX_KEY],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });

    await Promise.all(existing.data.data.map((variable) => client.variable.variableControllerDelete(variable.id)));
  }

  async function reinstallModule(userConfig: Record<string, unknown>): Promise<void> {
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      const status = (err as { status?: number; response?: { status?: number } })?.response?.status
        ?? (err as { status?: number })?.status;
      if (status !== 404) {
        throw err;
      }
    }

    await clearMessageIndex();

    await installModule(client, versionId, ctx.gameServer.id, { userConfig });
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
      messages: ['Alpha', 'Bravo', 'Charlie'],
      mode: 'sequential',
      minPlayers: 0,
    });

    const first = await triggerBroadcast();
    const second = await triggerBroadcast();
    const third = await triggerBroadcast();
    const fourth = await triggerBroadcast();

    for (const result of [first, second, third, fourth]) {
      assert.equal(result.success, true, `Expected cronjob success, logs: ${JSON.stringify(result.logs)}`);
    }

    assert.ok(
      first.logs.some((msg) => msg.includes('sequential index=0 nextIndex=1')),
      `Expected first trigger to use index 0, got: ${JSON.stringify(first.logs)}`,
    );
    assert.ok(
      second.logs.some((msg) => msg.includes('sequential index=1 nextIndex=2')),
      `Expected second trigger to use index 1, got: ${JSON.stringify(second.logs)}`,
    );
    assert.ok(
      third.logs.some((msg) => msg.includes('sequential index=2 nextIndex=0')),
      `Expected third trigger to use index 2, got: ${JSON.stringify(third.logs)}`,
    );
    assert.ok(
      fourth.logs.some((msg) => msg.includes('sequential index=0 nextIndex=1')),
      `Expected fourth trigger to wrap to index 0, got: ${JSON.stringify(fourth.logs)}`,
    );
  });

  it('random selects a message', async () => {
    const randomMessages = ['Random one', 'Random two', 'Random three'];
    await reinstallModule({
      messages: randomMessages,
      mode: 'random',
      minPlayers: 0,
    });

    const result = await triggerBroadcast();

    assert.equal(result.success, true, `Expected cronjob success, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(
      result.logs.some((msg) => msg.includes('random index=')),
      `Expected a random index log, got: ${JSON.stringify(result.logs)}`,
    );
    assert.ok(
      result.logs.some((msg) => randomMessages.some((message) => msg.includes(`sent message: ${message}`))),
      `Expected one of the configured messages to be sent, got: ${JSON.stringify(result.logs)}`,
    );
  });

  it('empty messages skips', async () => {
    await reinstallModule({
      messages: [],
      mode: 'sequential',
      minPlayers: 0,
    });

    const result = await triggerBroadcast();

    assert.equal(result.success, true, `Expected cronjob success, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(
      result.logs.some((msg) => msg.includes('skipping broadcast because no messages are configured')),
      `Expected empty-messages skip log, got: ${JSON.stringify(result.logs)}`,
    );
  });

  it('minPlayers threshold skips broadcast', async () => {
    await reinstallModule({
      messages: ['Needs more players'],
      mode: 'sequential',
      minPlayers: 999,
    });

    const result = await triggerBroadcast();

    assert.equal(result.success, true, `Expected cronjob success, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(
      result.logs.some((msg) => msg.includes('below minPlayers 999')),
      `Expected minPlayers skip log, got: ${JSON.stringify(result.logs)}`,
    );
  });

  it('template variables resolve', async () => {
    await reinstallModule({
      messages: ['Players online: {playerCount}'],
      mode: 'sequential',
      minPlayers: 0,
    });

    const result = await triggerBroadcast();

    assert.equal(result.success, true, `Expected cronjob success, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(
      result.logs.some((msg) => msg.includes('sent message: Players online: 3')),
      `Expected resolved playerCount in logs, got: ${JSON.stringify(result.logs)}`,
    );
  });
});
