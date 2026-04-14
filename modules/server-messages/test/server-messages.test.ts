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

type CronResult = {
  triggeredAt: Date;
  success: boolean;
  logs: string[];
};

function cronExpressionForTimeZoneNow(timeZone: string) {
  const weekdayMap: Record<string, string> = {
    Sun: '0',
    Mon: '1',
    Tue: '2',
    Wed: '3',
    Thu: '4',
    Fri: '5',
    Sat: '6',
  };

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value;

  return [
    String(Number(get('minute'))),
    String(Number(get('hour'))),
    String(Number(get('day'))),
    String(Number(get('month'))),
    weekdayMap[get('weekday') ?? ''] ?? '0',
  ].join(' ');
}

describe('server-messages integration', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;
  const staleContexts: MockServerContext[] = [];

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
    for (const staleCtx of staleContexts) {
      await stopMockServer(staleCtx.server, client, staleCtx.gameServer.id).catch((err) => {
        console.error('Cleanup: failed to stop stale mock server:', err);
      });
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
    await waitForLockToClear();
    await clearModuleVariables();
    await installModule(client, versionId, ctx.gameServer.id, { userConfig });

    if ((await getOnlineCount()) < 3) {
      await ctx.server.executeConsoleCommand('connectAll');
      await waitForOnlineCount(3);
    }
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

  async function getOnlineCount() {
    const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        online: [true],
      },
      limit: 100,
      page: 0,
    });

    return result.data.meta?.total ?? result.data.data.length;
  }

  async function waitForOnlineCount(expected: number, timeout = 30000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if ((await getOnlineCount()) === expected) return;
      await wait(250);
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
    await wait(250);
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

  it('sends sequential messages, broadcasts to players, renders supported placeholders, and wraps', async () => {
    await reinstall({
      messages: [
        { text: 'Alpha message' },
        { text: 'Players={playerCount}; Server={serverName}' },
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
    assert.equal(parseJsonLogField(second.logs, 'rendered'), `Players=3; Server=${ctx.gameServer.name}`);

    const secondChat = asChatMessage((await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, second.triggeredAt))[0]!);
    assert.equal(secondChat.msg, `Players=3; Server=${ctx.gameServer.name}`);

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

  it('allows empty message lists to install quietly, warns about unknown placeholders, and leaves them unchanged', async () => {
    await reinstall({
      messages: [],
      order: 'sequential',
      interval: '* * * * *',
    });

    const emptyRun = await triggerCronjob();
    assert.equal(emptyRun.success, true, `Expected empty-message cron trigger to succeed, logs: ${JSON.stringify(emptyRun.logs)}`);
    assert.ok(emptyRun.logs.some((log) => log.includes('no messages configured')));
    await assertNoEvent(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, emptyRun.triggeredAt);
    assert.equal(await readModuleVariable(STATE_KEY), null, 'Expected empty-message runs to avoid creating rotation state');

    await reinstall({
      messages: [{ text: 'Unknown={unknown}; Count={playerCount}' }],
      order: 'sequential',
      interval: '* * * * *',
    });

    const unknownPlaceholderRun = await triggerCronjob();
    assert.equal(unknownPlaceholderRun.success, true, `Expected unknown-placeholder cron trigger to succeed, logs: ${JSON.stringify(unknownPlaceholderRun.logs)}`);
    assert.ok(
      unknownPlaceholderRun.logs.some((log) => log.includes('unsupported placeholders') && log.includes('unknown')),
      `Expected unknown-placeholder run to log a warning, logs: ${JSON.stringify(unknownPlaceholderRun.logs)}`,
    );
    assert.equal(parseJsonLogField(unknownPlaceholderRun.logs, 'rendered'), 'Unknown={unknown}; Count=3');

    const chat = asChatMessage((await waitForEvents(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, unknownPlaceholderRun.triggeredAt))[0]!);
    assert.equal(chat.msg, 'Unknown={unknown}; Count=3');

    await safeUninstall();

    await assert.rejects(
      installModule(client, versionId, ctx.gameServer.id, {
        userConfig: {
          messages: [{ text: '   ' }],
          order: 'sequential',
          interval: '* * * * *',
        },
      }),
      /400|pattern|minlength|bad request|validation/i,
    );

    const zeroPaddedNowInterval = cronExpressionForTimeZoneNow('UTC')
      .split(' ')
      .map((segment, index) => (index < 2 ? segment.padStart(2, '0') : segment))
      .join(' ');

    await reinstall({
      messages: [{ text: 'Leading zero cron works' }],
      order: 'sequential',
      interval: zeroPaddedNowInterval,
    });

    const zeroPaddedCronRun = await triggerCronjob();
    assert.equal(zeroPaddedCronRun.success, true, `Expected zero-padded cron trigger to succeed, logs: ${JSON.stringify(zeroPaddedCronRun.logs)}`);
    assert.equal(parseJsonLogField(zeroPaddedCronRun.logs, 'rendered'), 'Leading zero cron works');

    for (const interval of ['not-a-cron', '61 * * * *', '*/99 * * * *', '* * 32 * *', '5-1 * * * *']) {
      await assert.rejects(
        installModule(client, versionId, ctx.gameServer.id, {
          userConfig: {
            messages: [{ text: 'Valid message' }],
            order: 'sequential',
            interval,
          },
        }),
        /400|pattern|bad request|validation/i,
        `Expected install-time validation to reject interval ${interval}`,
      );
    }
  });

  it('evaluates intervals in the configured timezone instead of forcing manual UTC conversion and rejects invalid timezone ids at install time', async () => {
    const timeZone = 'America/New_York';

    await reinstall({
      messages: [{ text: 'Timezone aware message' }],
      order: 'sequential',
      interval: '* * * * *',
      timeZone,
    });

    const result = await triggerCronjob();
    assert.equal(result.success, true, `Expected timezone-aware cron trigger to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.equal(parseJsonLogField(result.logs, 'rendered'), 'Timezone aware message');

    await safeUninstall();

    await assert.rejects(
      installModule(client, versionId, ctx.gameServer.id, {
        userConfig: {
          messages: [{ text: 'Timezone aware message' }],
          order: 'sequential',
          interval: '* * * * *',
          timeZone: 'America/New_Yrok',
        },
      }),
      /400|enum|bad request|validation/i,
    );
  });

  it('skips valid-but-not-due cron ticks without broadcasting or advancing state', async () => {
    await reinstall({
      messages: [{ text: 'First' }, { text: 'Second' }],
      order: 'sequential',
      interval: '* * * * *',
    });

    const first = await triggerCronjob();
    assert.equal(first.success, true);

    await safeUninstall();
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        messages: [{ text: 'First' }, { text: 'Second' }],
        order: 'sequential',
        interval: '0 0 31 2 *',
      },
    });

    const stateBeforeSkip = await readModuleVariable(STATE_KEY);
    assert.deepEqual(JSON.parse(stateBeforeSkip!.value), { order: 'sequential', index: 1 });

    const skipped = await triggerCronjob();
    assert.equal(skipped.success, true, `Expected not-due cron trigger to succeed, logs: ${JSON.stringify(skipped.logs)}`);
    assert.ok(skipped.logs.some((log) => log.includes('not due')));
    await assertNoEvent(EventSearchInputAllowedFiltersEventNameEnum.ChatMessage, skipped.triggeredAt);

    const stateAfterSkip = await readModuleVariable(STATE_KEY);
    assert.deepEqual(JSON.parse(stateAfterSkip!.value), { order: 'sequential', index: 1 });
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

    const baselineSequential = await triggerCronjob();
    assert.equal(baselineSequential.success, true);

    await upsertModuleVariable(STATE_KEY, '{not-json');

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

    const baselineRandom = await triggerCronjob();
    assert.equal(baselineRandom.success, true);

    await upsertModuleVariable(STATE_KEY, JSON.stringify({ order: 'random', bag: [1, 1], cursor: 0 }));

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

  it('releases the execution lock when broadcasting fails after the lock is acquired', async () => {
    await reinstall({
      messages: [{ text: 'This send should fail once the mock server is offline' }],
      order: 'sequential',
      interval: '* * * * *',
    });

    await stopMockServer(ctx.server);

    const failed = await triggerCronjob();
    assert.equal(failed.success, false, `Expected offline cron trigger to fail, logs: ${JSON.stringify(failed.logs)}`);

    const lockAfterFailure = await readModuleVariable(LOCK_KEY);
    assert.equal(lockAfterFailure, null, 'Expected execution lock to be cleared after a failed cron run');

    const stateAfterFailure = await readModuleVariable(STATE_KEY);
    assert.deepEqual(
      JSON.parse(stateAfterFailure!.value),
      { order: 'sequential', index: 0 },
      'Expected failed sends to roll rotation state back so the skipped message is retried later',
    );
  });
});
