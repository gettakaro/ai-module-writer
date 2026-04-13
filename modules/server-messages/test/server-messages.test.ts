import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, EventOutputDTO, EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';
import { createClient } from '../../../test/helpers/client.js';
import { waitForEvent } from '../../../test/helpers/events.js';
import { startMockServer, stopMockServer, MockServerContext } from '../../../test/helpers/mock-server.js';
import {
  cleanupTestGameServers,
  cleanupTestModules,
  deleteModule,
  installModule,
  uninstallModule,
  pushModule,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');
const STATE_KEY = 'server_messages_state';
const FINGERPRINT_KEY = 'server_messages_fingerprint';
const LOCK_KEY = 'server_messages_lock';

function computeFingerprint(order: string, messages: Array<{ text: string; weight: number }>) {
  return hashString(JSON.stringify({ order, messages }));
}

function hashString(input: string) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

type CronResult = {
  triggeredAt: Date;
  success: boolean;
  logs: string[];
};

describe('server-messages integration', () => {
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
    cronjobId = mod.latestVersion.cronJobs[0]!.id;

    await client.cronjob.cronJobControllerUpdate(cronjobId, {
      temporalValue: '0 0 31 2 *',
    });
  });

  after(async () => {
    await safeUninstall();
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete server-messages test module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function safeUninstall() {
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch {
      // ignore when not installed
    }
  }

  async function reinstall(userConfig: Record<string, unknown>) {
    await safeUninstall();
    await wait(2000);
    await waitForLockToClear();
    await clearModuleVariables();
    await installModule(client, versionId, ctx.gameServer.id, { userConfig });
    await wait(2000);
    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnlineCount(3);
  }

  async function clearModuleVariables() {
    const result = await client.variable.variableControllerSearch({
      filters: {
        key: [STATE_KEY, FINGERPRINT_KEY, LOCK_KEY],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
      limit: 100,
      page: 0,
    });

    await Promise.all(
      result.data.data.map(async (variable) => {
        try {
          await client.variable.variableControllerDelete(variable.id);
        } catch (err) {
          if ((err as { response?: { status?: number } }).response?.status !== 404) throw err;
        }
      }),
    );
  }

  async function wait(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForOnlineCount(expected: number, timeout = 30000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
        filters: {
          gameServerId: [ctx.gameServer.id],
          online: [true],
        },
        limit: 100,
        page: 0,
      });

      if (result.data.data.length === expected) return;
      await wait(1000);
    }

    throw new Error(`Timed out waiting for ${expected} online players`);
  }

  async function readModuleVariable(key: string) {
    const result = await client.variable.variableControllerSearch({
      filters: {
        key: [key],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });

    return result.data.data[0] ?? null;
  }

  async function upsertModuleVariable(key: string, value: string) {
    const existing = await readModuleVariable(key);
    if (existing) {
      await client.variable.variableControllerUpdate(existing.id, { value });
      return;
    }

    await client.variable.variableControllerCreate({
      key,
      value,
      gameServerId: ctx.gameServer.id,
      moduleId,
    });
  }

  async function waitForLockToClear(timeout = 15000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const lock = await readModuleVariable(LOCK_KEY);
      if (!lock) return;
      await wait(250);
    }

    throw new Error('Timed out waiting for server-messages lock to clear');
  }

  async function triggerCronjob(): Promise<CronResult> {
    const triggeredAt = new Date();

    await client.cronjob.cronJobControllerTrigger({
      gameServerId: ctx.gameServer.id,
      cronjobId,
      moduleId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: ctx.gameServer.id,
      after: triggeredAt,
      timeout: 30000,
      pollInterval: 500,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };

    await waitForLockToClear();

    return {
      triggeredAt,
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((log) => log.msg),
    };
  }

  async function waitForEvents(eventName: EventSearchInputAllowedFiltersEventNameEnum, after: Date, count = 1, timeout = 15000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const result = await client.event.eventControllerSearch({
        filters: {
          eventName: [eventName],
          gameserverId: [ctx.gameServer.id],
        },
        greaterThan: {
          createdAt: after.toISOString(),
        },
        limit: 100,
        page: 0,
      });

      if (result.data.data.length >= count) {
        return [...result.data.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }

      await wait(300);
    }

    throw new Error(`Timed out waiting for ${count} '${eventName}' events after ${after.toISOString()}`);
  }

  async function assertNoEvent(eventName: EventSearchInputAllowedFiltersEventNameEnum, after: Date) {
    await wait(1500);
    const result = await client.event.eventControllerSearch({
      filters: {
        eventName: [eventName],
        gameserverId: [ctx.gameServer.id],
      },
      greaterThan: {
        createdAt: after.toISOString(),
      },
      limit: 20,
      page: 0,
    });

    assert.equal(
      result.data.data.length,
      0,
      `Expected no '${eventName}' events after ${after.toISOString()}, got ${JSON.stringify(result.data.data)}`,
    );
  }

  function parseJsonLogField(logs: string[], field: string) {
    const line = logs.find((entry) => entry.includes(`${field}=`));
    if (!line) return null;

    const match = line.match(new RegExp(`${field}=(.+)$`));
    if (!match) return null;
    return JSON.parse(match[1]);
  }

  function parseNumericLogField(logs: string[], field: string) {
    const line = logs.find((entry) => entry.includes(`${field}=`));
    if (!line) return null;

    const match = line.match(new RegExp(`${field}=(-?\\d+)`));
    return match ? Number(match[1]) : null;
  }

  function asChatMessage(event: EventOutputDTO) {
    return event.meta as { msg?: string; channel?: string };
  }

  it('sends sequential messages, broadcasts to players, renders placeholders, and wraps', async () => {
    await reinstall({
      messages: [
        { text: 'Alpha message' },
        { text: 'Players={playerCount}; Server={serverName}; Unknown={unknown}' },
      ],
      order: 'sequential',
      interval: '* * * * *',
    });

    const first = await triggerCronjob();
    assert.equal(first.success, true, `Expected first cron trigger to succeed, logs: ${JSON.stringify(first.logs)}`);
    assert.equal(parseJsonLogField(first.logs, 'rendered'), 'Alpha message');

    const firstChat = asChatMessage((await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, first.triggeredAt))[0]!);
    assert.equal(firstChat.msg, 'Alpha message');
    assert.equal(firstChat.channel, 'global');

    const stateAfterFirst = await readModuleVariable(STATE_KEY);
    assert.deepEqual(JSON.parse(stateAfterFirst!.value), { order: 'sequential', index: 1 });

    const second = await triggerCronjob();
    assert.equal(second.success, true, `Expected second cron trigger to succeed, logs: ${JSON.stringify(second.logs)}`);
    assert.equal(
      parseJsonLogField(second.logs, 'rendered'),
      `Players=3; Server=${ctx.gameServer.name}; Unknown={unknown}`,
    );

    const secondChat = asChatMessage((await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, second.triggeredAt))[0]!);
    assert.equal(secondChat.msg, `Players=3; Server=${ctx.gameServer.name}; Unknown={unknown}`);

    const stateAfterSecond = await readModuleVariable(STATE_KEY);
    assert.deepEqual(JSON.parse(stateAfterSecond!.value), { order: 'sequential', index: 0 });
  });

  it('does not advance sequential state when nobody is online', async () => {
    await reinstall({
      messages: [{ text: 'Alpha message' }],
      order: 'sequential',
      interval: '* * * * *',
    });

    await ctx.server.executeConsoleCommand('disconnectAll');
    await waitForOnlineCount(0);

    const skipped = await triggerCronjob();
    assert.equal(skipped.success, true, `Expected zero-player cron trigger to succeed, logs: ${JSON.stringify(skipped.logs)}`);
    assert.ok(skipped.logs.some((log) => log.includes('no players online')));
    await assertNoEvent(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, skipped.triggeredAt);

    const stateAfterSkip = await readModuleVariable(STATE_KEY);
    assert.deepEqual(JSON.parse(stateAfterSkip!.value), { order: 'sequential', index: 0 });

    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnlineCount(3);

    const resumed = await triggerCronjob();
    assert.equal(resumed.success, true, `Expected resumed cron trigger to succeed, logs: ${JSON.stringify(resumed.logs)}`);
    assert.equal(parseJsonLogField(resumed.logs, 'rendered'), 'Alpha message');
  });

  it('handles empty message lists quietly', async () => {
    await reinstall({
      messages: [],
      order: 'sequential',
      interval: '* * * * *',
    });

    const result = await triggerCronjob();
    assert.equal(result.success, true, `Expected empty-message cron trigger to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(result.logs.some((log) => log.includes('no messages configured')));
    await assertNoEvent(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, result.triggeredAt);
  });

  it('uses the configured interval to decide whether a trigger should broadcast', async () => {
    const matchingInterval = '* * * * *';
    const nonMatchingInterval = '0 0 31 2 *';

    await reinstall({
      messages: [{ text: 'Scheduled message' }],
      order: 'sequential',
      interval: nonMatchingInterval,
    });

    const skipped = await triggerCronjob();
    assert.equal(skipped.success, true, `Expected off-schedule trigger to succeed, logs: ${JSON.stringify(skipped.logs)}`);
    assert.equal(parseJsonLogField(skipped.logs, 'rendered'), null, `Expected no rendered payload, got: ${JSON.stringify(skipped.logs)}`);
    await assertNoEvent(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, skipped.triggeredAt);

    await reinstall({
      messages: [{ text: 'Scheduled message' }],
      order: 'sequential',
      interval: matchingInterval,
    });

    const sent = await triggerCronjob();
    assert.equal(sent.success, true, `Expected matching trigger to succeed, logs: ${JSON.stringify(sent.logs)}`);
    assert.equal(parseJsonLogField(sent.logs, 'rendered'), 'Scheduled message');
  });

  it('serializes overlapping executions so overlapping triggers do not duplicate the same broadcast', async () => {
    await reinstall({
      messages: [{ text: 'One' }, { text: 'Two' }],
      order: 'sequential',
      interval: '* * * * *',
    });

    const startedAt = new Date();
    await Promise.all([
      client.cronjob.cronJobControllerTrigger({ gameServerId: ctx.gameServer.id, cronjobId, moduleId }),
      client.cronjob.cronJobControllerTrigger({ gameServerId: ctx.gameServer.id, cronjobId, moduleId }),
    ]);

    const cronEvents = await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted, startedAt, 2, 30000);
    const chatEvents = await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, startedAt, 1, 30000);

    const cronLogs = cronEvents.map(
      (event) => (event.meta as { result?: { logs?: Array<{ msg: string }> } }).result?.logs?.map((log) => log.msg) ?? [],
    );
    assert.equal(
      cronLogs.filter((logs) => logs.some((log) => log.includes('another execution already holds the rotation lock'))).length,
      1,
    );
    assert.equal(cronLogs.filter((logs) => parseNumericLogField(logs, 'messageIndex') === 0).length, 1);

    const deliveredMessages = chatEvents.map((event) => asChatMessage(event).msg);
    assert.deepEqual(deliveredMessages, ['One']);

    const finalState = await readModuleVariable(STATE_KEY);
    assert.deepEqual(JSON.parse(finalState!.value), { order: 'sequential', index: 1 });
  });

  it('consumes each weighted bag slot exactly once before rebuilding and no longer logs the full bag', async () => {
    await reinstall({
      messages: [
        { text: 'Red', weight: 1 },
        { text: 'Gold', weight: 2 },
      ],
      order: 'random',
      interval: '* * * * *',
    });

    const first = await triggerCronjob();
    assert.equal(first.success, true, `Expected first random trigger to succeed, logs: ${JSON.stringify(first.logs)}`);
    assert.ok(first.logs.every((log) => !log.includes('bag=[')), `Expected logs to avoid full bag dumps, got ${JSON.stringify(first.logs)}`);

    const stateAfterFirst = JSON.parse((await readModuleVariable(STATE_KEY))!.value) as {
      order: string;
      bag: number[];
      cursor: number;
    };
    assert.equal(stateAfterFirst.order, 'random');
    assert.equal(stateAfterFirst.bag.length, 3);

    const bag = [...stateAfterFirst.bag];
    const second = await triggerCronjob();
    const third = await triggerCronjob();
    const sentMessages = [
      asChatMessage((await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, first.triggeredAt))[0]!).msg,
      asChatMessage((await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, second.triggeredAt))[0]!).msg,
      asChatMessage((await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, third.triggeredAt))[0]!).msg,
    ];
    const sentIndices = sentMessages.map((message) => (message === 'Red' ? 0 : message === 'Gold' ? 1 : null));

    assert.deepEqual(sentIndices, bag, `Expected one full bag cycle to consume bag slots in order, bag=${JSON.stringify(bag)} sent=${JSON.stringify(sentIndices)}`);
    assert.equal(
      sentIndices.filter((entry) => entry === 0).length,
      1,
      `Expected exactly one Red slot per bag, got sentIndices=${JSON.stringify(sentIndices)} bag=${JSON.stringify(bag)}`,
    );
    assert.equal(
      sentIndices.filter((entry) => entry === 1).length,
      2,
      `Expected exactly two Gold slots per bag, got sentIndices=${JSON.stringify(sentIndices)} bag=${JSON.stringify(bag)}`,
    );

    const fourth = await triggerCronjob();
    assert.equal(fourth.success, true);

    const stateAfterFourth = JSON.parse((await readModuleVariable(STATE_KEY))!.value) as { bag: number[]; cursor: number };
    assert.equal(stateAfterFourth.bag.length, 3);
    assert.equal(stateAfterFourth.cursor, 1);
  });

  it('recovers from malformed persisted state for sequential and random rotation paths', async () => {
    await reinstall({
      messages: [{ text: 'Recovery message' }],
      order: 'sequential',
      interval: '* * * * *',
    });

    await upsertModuleVariable(STATE_KEY, '{not-json');
    await upsertModuleVariable(FINGERPRINT_KEY, computeFingerprint('sequential', [{ text: 'Recovery message', weight: 1 }]));

    const sequentialRecovery = await triggerCronjob();
    assert.equal(sequentialRecovery.success, true);
    assert.equal(parseJsonLogField(sequentialRecovery.logs, 'rendered'), 'Recovery message');
    assert.deepEqual(JSON.parse((await readModuleVariable(STATE_KEY))!.value), { order: 'sequential', index: 0 });

    await reinstall({
      messages: [
        { text: 'Red', weight: 1 },
        { text: 'Gold', weight: 2 },
      ],
      order: 'random',
      interval: '* * * * *',
    });

    await upsertModuleVariable(STATE_KEY, JSON.stringify({ order: 'random', bag: [999], cursor: 0 }));
    await upsertModuleVariable(
      FINGERPRINT_KEY,
      computeFingerprint('random', [
        { text: 'Red', weight: 1 },
        { text: 'Gold', weight: 2 },
      ]),
    );

    const randomRecovery = await triggerCronjob();
    assert.equal(randomRecovery.success, true, `Expected random recovery trigger to succeed, logs: ${JSON.stringify(randomRecovery.logs)}`);

    const recoveredState = JSON.parse((await readModuleVariable(STATE_KEY))!.value) as { order: string; bag: number[]; cursor: number };
    assert.equal(recoveredState.order, 'random');
    assert.equal(recoveredState.bag.length, 3);
    assert.equal(recoveredState.cursor, 1);
    assert.ok(recoveredState.bag.every((entry) => entry === 0 || entry === 1));
  });

  it('restarts rotation cleanly after config changes', async () => {
    await reinstall({
      messages: [
        { text: 'Old one' },
        { text: 'Old two' },
      ],
      order: 'sequential',
      interval: '* * * * *',
    });

    const beforeChange = await triggerCronjob();
    assert.equal(beforeChange.success, true, `Expected initial trigger to succeed, logs: ${JSON.stringify(beforeChange.logs)}`);
    assert.equal(
      parseJsonLogField(beforeChange.logs, 'rendered'),
      'Old one',
      `Expected initial render log to be Old one, got: ${JSON.stringify(beforeChange.logs)}`,
    );

    await safeUninstall();
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        messages: [
          { text: 'New first' },
          { text: 'New second' },
        ],
        order: 'sequential',
        interval: '* * * * *',
      },
    });

    await upsertModuleVariable(STATE_KEY, JSON.stringify({ order: 'sequential', index: 1 }));
    await upsertModuleVariable(FINGERPRINT_KEY, 'stale-fingerprint');

    const afterChange = await triggerCronjob();
    assert.equal(afterChange.success, true, `Expected post-change trigger to succeed, logs: ${JSON.stringify(afterChange.logs)}`);
    assert.ok(afterChange.logs.some((log) => log.includes('config fingerprint changed')));
    assert.equal(parseJsonLogField(afterChange.logs, 'rendered'), 'New first');

    const stateAfterChange = await readModuleVariable(STATE_KEY);
    assert.deepEqual(JSON.parse(stateAfterChange!.value), { order: 'sequential', index: 1 });
  });
});
