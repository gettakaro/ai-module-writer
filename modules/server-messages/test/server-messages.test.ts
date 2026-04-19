import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client,
  EventOutputDTO,
  EventSearchInputAllowedFiltersEventNameEnum,
  VariableOutputDTO,
} from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import {
  cleanupTestGameServers,
  cleanupTestModules,
  deleteModule,
  installModule,
  pushModule,
  uninstallModule,
} from '../../../test/helpers/modules.js';
import { MockServerContext, startMockServer, stopMockServer } from '../../../test/helpers/mock-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
const STATE_KEY = 'server_messages_state';

describe('server-messages: broadcast cronjob', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;
  let installed = false;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected server-messages module to expose one cronjob');
    cronjobId = cronjob.id;
  });

  after(async () => {
    if (installed) {
      try {
        await uninstallModule(client, moduleId, ctx.gameServer.id);
      } catch (err) {
        console.error('Cleanup: failed to uninstall module:', err);
      }
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForOnlineCount(expected: number): Promise<void> {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const res = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: {
          gameServerId: [ctx.gameServer.id],
          online: [true],
        },
      });
      if (res.data.data.length === expected) {
        return;
      }
      await wait(1000);
    }
    throw new Error(`Timed out waiting for ${expected} online players`);
  }

  async function getStateVariable(): Promise<VariableOutputDTO | null> {
    const res = await client.variable.variableControllerSearch({
      filters: {
        key: [STATE_KEY],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    return res.data.data[0] ?? null;
  }

  async function deleteStateVariable(): Promise<void> {
    const existing = await getStateVariable();
    if (existing) {
      await client.variable.variableControllerDelete(existing.id);
    }
  }

  async function reinstall(config: Record<string, unknown>, options?: { clearState?: boolean }) {
    if (installed) {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
      installed = false;
      await wait(500);
    }

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: config,
      systemConfig: {
        cronJobs: {
          broadcast: {
            temporalValue: '0 0 1 1 *',
          },
        },
      },
    });
    installed = true;

    if (options?.clearState !== false) {
      await deleteStateVariable();
    }
    await wait(500);
  }

  async function triggerCronjob(): Promise<{ success: boolean; logs: string[]; cronEvent: EventOutputDTO }> {
    const before = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId,
      moduleId,
    });

    const cronEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = cronEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    await wait(1000);

    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((entry) => entry.msg),
      cronEvent,
    };
  }

  async function getChatMessages(after: Date): Promise<string[]> {
    const result = await client.event.eventControllerSearch({
      filters: {
        eventName: [EventSearchInputAllowedFiltersEventNameEnum.ChatMessage],
        gameserverId: [ctx.gameServer.id],
      },
      greaterThan: {
        createdAt: after.toISOString(),
      },
      sortBy: 'createdAt',
      sortDirection: 'asc',
    });

    return result.data.data.map((event) => ((event.meta as { msg?: string }).msg ?? '').trim());
  }

  async function triggerCronjobAndCollectMessages(): Promise<{ success: boolean; logs: string[]; chatMessages: string[] }> {
    const before = new Date();
    const { success, logs } = await triggerCronjob();
    const chatMessages = await getChatMessages(before);
    return { success, logs, chatMessages };
  }

  it('sends sequential messages in order and wraps back to the start', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Alpha' }, { text: 'Beta' }],
    });

    const first = await triggerCronjobAndCollectMessages();
    const second = await triggerCronjobAndCollectMessages();
    const third = await triggerCronjobAndCollectMessages();

    assert.equal(first.success, true, `Expected first cron run to succeed, logs: ${JSON.stringify(first.logs)}`);
    assert.deepEqual(first.chatMessages, ['Alpha']);
    assert.deepEqual(second.chatMessages, ['Beta']);
    assert.deepEqual(third.chatMessages, ['Alpha']);
  });

  it('does not advance sequential state when nobody is online', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'One' }, { text: 'Two' }],
    });

    const first = await triggerCronjobAndCollectMessages();
    assert.deepEqual(first.chatMessages, ['One']);

    await ctx.server.executeConsoleCommand('disconnectAll');
    await waitForOnlineCount(0);

    const skipped = await triggerCronjobAndCollectMessages();
    assert.equal(skipped.success, true, `Expected skip run to succeed, logs: ${JSON.stringify(skipped.logs)}`);
    assert.deepEqual(skipped.chatMessages, []);
    assert.ok(
      skipped.logs.some((log) => log.includes('no online players')),
      `Expected skip log for zero players, got: ${JSON.stringify(skipped.logs)}`,
    );

    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnlineCount(3);

    const resumed = await triggerCronjobAndCollectMessages();
    assert.deepEqual(resumed.chatMessages, ['Two']);
  });

  it('uses weighted shuffle-bag rotation in random mode', async () => {
    await reinstall({
      order: 'random',
      messages: [
        { text: 'Red', weight: 1 },
        { text: 'Green', weight: 2 },
        { text: 'Gold', weight: 3 },
      ],
    });

    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const result = await triggerCronjobAndCollectMessages();
      assert.equal(result.success, true, `Expected random run ${i} to succeed, logs: ${JSON.stringify(result.logs)}`);
      assert.equal(result.chatMessages.length, 1, `Expected exactly one broadcast on run ${i}`);
      seen.push(result.chatMessages[0]!);
    }

    const counts = seen.reduce<Record<string, number>>((acc, message) => {
      acc[message] = (acc[message] ?? 0) + 1;
      return acc;
    }, {});

    assert.deepEqual(counts, { Red: 1, Green: 2, Gold: 3 });
  });

  it('does not immediately repeat within a random bag when each message has weight 1', async () => {
    await reinstall({
      order: 'random',
      messages: [
        { text: 'North', weight: 1 },
        { text: 'South', weight: 1 },
        { text: 'West', weight: 1 },
      ],
    });

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await triggerCronjobAndCollectMessages();
      assert.ok(result.chatMessages.length >= 1, `Expected at least one broadcast, got ${JSON.stringify(result.chatMessages)}`);
      seen.push(result.chatMessages[result.chatMessages.length - 1]!);
    }

    assert.equal(new Set(seen).size, 3, `Expected each weight-1 message exactly once per bag, got: ${JSON.stringify(seen)}`);
    for (let i = 1; i < seen.length; i++) {
      assert.notEqual(seen[i], seen[i - 1], `Expected no adjacent repeats in unique bag, got: ${JSON.stringify(seen)}`);
    }
  });

  it('succeeds quietly when messages is empty', async () => {
    await reinstall({
      order: 'sequential',
      messages: [],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected empty-message run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, []);
    assert.ok(
      result.logs.some((log) => log.includes('no messages configured')),
      `Expected no-messages log, got: ${JSON.stringify(result.logs)}`,
    );
  });

  it('renders playerCount and serverName placeholders and leaves unknown placeholders unchanged', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Players={playerCount} Server={serverName} Unknown={unknownToken}' }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected placeholder run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, [
      `Players=3 Server=${ctx.gameServer.name} Unknown={unknownToken}`,
    ]);
  });

  it('resets rotation cleanly after reinstalling with a changed message list', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Old 1' }, { text: 'Old 2' }],
    });

    const oldFirst = await triggerCronjobAndCollectMessages();
    const oldSecond = await triggerCronjobAndCollectMessages();
    assert.deepEqual(oldFirst.chatMessages, ['Old 1']);
    assert.deepEqual(oldSecond.chatMessages, ['Old 2']);

    await reinstall(
      {
        order: 'sequential',
        messages: [{ text: 'New 1' }, { text: 'New 2' }, { text: 'New 3' }],
      },
      { clearState: false },
    );

    const reset = await triggerCronjobAndCollectMessages();
    assert.equal(reset.success, true, `Expected reset run to succeed, logs: ${JSON.stringify(reset.logs)}`);
    assert.deepEqual(reset.chatMessages, ['New 1']);
  });
});
