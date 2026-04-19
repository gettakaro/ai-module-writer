import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'node:fs/promises';
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
const LOCK_KEY = 'server_messages_lock';

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

  async function getVariable(key: string): Promise<VariableOutputDTO | null> {
    const res = await client.variable.variableControllerSearch({
      filters: {
        key: [key],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    return res.data.data[0] ?? null;
  }

  async function getStateVariable(): Promise<VariableOutputDTO | null> {
    return getVariable(STATE_KEY);
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

  async function waitForCronEvents(after: Date, expectedCount: number): Promise<EventOutputDTO[]> {
    const deadline = Date.now() + 30000;

    while (Date.now() < deadline) {
      const result = await client.event.eventControllerSearch({
        filters: {
          eventName: [EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted],
          gameserverId: [ctx.gameServer.id],
        },
        greaterThan: {
          createdAt: after.toISOString(),
        },
        sortBy: 'createdAt',
        sortDirection: 'asc',
        limit: expectedCount + 2,
      });

      if (result.data.data.length >= expectedCount) {
        return result.data.data.slice(0, expectedCount);
      }

      await wait(1000);
    }

    throw new Error(`Timed out waiting for ${expectedCount} cronjob-executed events`);
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

  it('serializes overlapping cron triggers so they do not double-send the same sequential message', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Alpha' }, { text: 'Beta' }, { text: 'Gamma' }],
    });

    const before = new Date();
    await Promise.all([
      client.cronjob.cronJobControllerTrigger({ gameServerId: ctx.gameServer.id, cronjobId, moduleId }),
      client.cronjob.cronJobControllerTrigger({ gameServerId: ctx.gameServer.id, cronjobId, moduleId }),
    ]);

    const events = await waitForCronEvents(before, 2);
    await wait(1000);
    const chatMessages = await getChatMessages(before);

    assert.equal(events.length, 2);
    for (const event of events) {
      const meta = event.meta as { result?: { success?: boolean } };
      assert.equal(meta?.result?.success, true, `Expected concurrent cron event to succeed: ${JSON.stringify(event.meta)}`);
    }
    assert.deepEqual(chatMessages, ['Alpha', 'Beta']);

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected state variable to exist after concurrent triggers');
    const storedState = JSON.parse(stateVariable.value) as { sequentialIndex?: number };
    assert.equal(storedState.sequentialIndex, 2, `Expected sequential index to advance twice, got ${stateVariable.value}`);
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

  it('ignores whitespace-only messages instead of broadcasting blank chat lines', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: '   ' }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected whitespace-only run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, []);
    assert.ok(
      result.logs.some((log) => log.includes('no messages configured')),
      `Expected whitespace-only message to be treated as empty config, got: ${JSON.stringify(result.logs)}`,
    );
  });

  it('renders supported placeholders and preserves unknown placeholders with a warning', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Players={playerCount} Server={serverName} Unknown={unknownToken}' }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected placeholder run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, [
      `Players=3 Server=${ctx.gameServer.name} Unknown={unknownToken}`,
    ]);
    assert.ok(
      result.logs.some((log) => log.includes('left unknown placeholders unchanged') && log.includes('unknownToken')),
      `Expected unknown-placeholder warning log, got: ${JSON.stringify(result.logs)}`,
    );
  });

  it('does not turn an unknown-placeholder-only message into a blank broadcast', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: '  {missingToken}  ' }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected unknown-placeholder-only run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, ['{missingToken}']);
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

  it('resets random shuffle state when only weights change', async () => {
    await reinstall({
      order: 'random',
      messages: [{ text: 'A', weight: 1 }, { text: 'B', weight: 1 }],
    });

    await triggerCronjobAndCollectMessages();

    await reinstall(
      {
        order: 'random',
        messages: [{ text: 'A', weight: 1 }, { text: 'B', weight: 3 }],
      },
      { clearState: false },
    );

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected weight-change run to succeed, logs: ${JSON.stringify(result.logs)}`);

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected state variable after weight-change reset');
    const state = JSON.parse(stateVariable.value) as { bag?: number[]; cursor?: number };
    assert.equal(state.bag?.length, 4, `Expected rebuilt weighted bag to reflect new weights, got ${stateVariable.value}`);
    assert.equal(state.cursor, 1, `Expected rebuilt bag cursor to advance from the fresh bag, got ${stateVariable.value}`);
  });

  it('resets persisted rotation state when only order changes', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'A', weight: 1 }, { text: 'B', weight: 3 }],
    });

    const firstSequentialRun = await triggerCronjobAndCollectMessages();
    assert.deepEqual(firstSequentialRun.chatMessages, ['A']);

    await reinstall(
      {
        order: 'random',
        messages: [{ text: 'A', weight: 1 }, { text: 'B', weight: 3 }],
      },
      { clearState: false },
    );

    const randomResult = await triggerCronjobAndCollectMessages();
    assert.equal(randomResult.success, true, `Expected order-change run to succeed, logs: ${JSON.stringify(randomResult.logs)}`);

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected state variable after order-change reset');
    const state = JSON.parse(stateVariable.value) as { bag?: number[]; cursor?: number; sequentialIndex?: number };
    assert.equal(state.bag?.length, 4, `Expected random mode to rebuild a weighted bag after order change, got ${stateVariable.value}`);
    assert.equal(state.cursor, 1, `Expected rebuilt random bag cursor to advance once, got ${stateVariable.value}`);
    assert.equal(state.sequentialIndex, 0, `Expected sequential index reset after switching to random, got ${stateVariable.value}`);
  });

  it('recovers from malformed persisted state without crashing', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'First' }, { text: 'Second' }],
    });

    await client.variable.variableControllerCreate({
      key: STATE_KEY,
      value: 'not-json',
      gameServerId: ctx.gameServer.id,
      moduleId,
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected malformed-state run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, ['First']);

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected malformed state to be rewritten');
    const state = JSON.parse(stateVariable.value) as { sequentialIndex?: number };
    assert.equal(state.sequentialIndex, 1, `Expected malformed state reset to first advance, got ${stateVariable.value}`);
  });

  it('coerces partially corrupt persisted state into a safe sequential state', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'First' }, { text: 'Second' }],
    });

    await triggerCronjobAndCollectMessages();
    const existingState = await getStateVariable();
    assert.ok(existingState, 'Expected a valid state variable before corrupting it');
    const parsedExistingState = JSON.parse(existingState.value) as { fingerprint?: string };

    await client.variable.variableControllerUpdate(existingState.id, {
      value: JSON.stringify({
        fingerprint: parsedExistingState.fingerprint,
        sequentialIndex: 'bad-index',
        bag: [0, -1, 1.5, 2],
        cursor: -10,
      }),
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected corrupt-state run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, ['First']);

    const rewrittenState = await getStateVariable();
    assert.ok(rewrittenState, 'Expected corrupt state to be rewritten');
    const parsedState = JSON.parse(rewrittenState.value) as { sequentialIndex?: number; bag?: number[]; cursor?: number };
    assert.equal(parsedState.sequentialIndex, 1, `Expected coerced sequential index to restart from zero, got ${rewrittenState.value}`);
    assert.deepEqual(parsedState.bag, [], `Expected invalid bag entries to be discarded in sequential mode, got ${rewrittenState.value}`);
    assert.equal(parsedState.cursor, 0, `Expected invalid cursor to coerce to zero, got ${rewrittenState.value}`);
  });

  it('self-heals a stale execution lock before broadcasting', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Alpha' }, { text: 'Beta' }],
    });

    await client.variable.variableControllerCreate({
      key: LOCK_KEY,
      value: JSON.stringify({ acquiredAt: new Date(Date.now() - 60000).toISOString() }),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      gameServerId: ctx.gameServer.id,
      moduleId,
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected stale-lock run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, ['Alpha']);

    const lockVariable = await getVariable(LOCK_KEY);
    assert.equal(lockVariable, null, 'Expected stale execution lock to be cleared after broadcast completes');
  });

  it('accepts install-time configs that runtime normalization clamps or filters', async () => {
    await reinstall({
      order: 'random',
      messages: [{ text: '   ' }, { text: 'Low', weight: 0 }, { text: 'High', weight: 250.9 }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected normalized-config run to succeed, logs: ${JSON.stringify(result.logs)}`);

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected state variable after normalized-config run');
    const state = JSON.parse(stateVariable.value) as { bag?: number[]; cursor?: number };
    const counts = (state.bag ?? []).reduce<Record<number, number>>((acc, index) => {
      acc[index] = (acc[index] ?? 0) + 1;
      return acc;
    }, {});

    assert.equal(state.bag?.length, 101, `Expected bounded weighted bag length 101, got ${stateVariable.value}`);
    assert.equal(counts[0], 1, `Expected low weight to clamp to one slot, got ${stateVariable.value}`);
    assert.equal(counts[1], 100, `Expected high weight to clamp to 100 slots, got ${stateVariable.value}`);
    assert.equal(state.cursor, 1, `Expected normalized weighted bag cursor to advance once, got ${stateVariable.value}`);
  });

  it('builds a bounded weighted bag from normalized message weights', async () => {
    await reinstall({
      order: 'random',
      messages: [{ text: 'Low', weight: 0 }, { text: 'High', weight: 250.9 }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected normalized-weight run to succeed, logs: ${JSON.stringify(result.logs)}`);

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected state variable after normalized-weight run');
    const state = JSON.parse(stateVariable.value) as { bag?: number[]; cursor?: number };
    const counts = (state.bag ?? []).reduce<Record<number, number>>((acc, index) => {
      acc[index] = (acc[index] ?? 0) + 1;
      return acc;
    }, {});

    assert.equal(state.bag?.length, 101, `Expected bounded weighted bag length 101, got ${stateVariable.value}`);
    assert.equal(counts[0], 1, `Expected low weight to clamp to one slot, got ${stateVariable.value}`);
    assert.equal(counts[1], 100, `Expected high weight to clamp to 100 slots, got ${stateVariable.value}`);
    assert.equal(state.cursor, 1, `Expected normalized weighted bag cursor to advance once, got ${stateVariable.value}`);
  });

  it('creates the state variable on first run and updates the same record on later runs', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'State 1' }, { text: 'State 2' }],
    });

    await triggerCronjobAndCollectMessages();
    const created = await getStateVariable();
    assert.ok(created, 'Expected first cron run to create the state variable');

    await triggerCronjobAndCollectMessages();
    const updated = await getStateVariable();
    assert.ok(updated, 'Expected second cron run to keep the state variable');
    assert.equal(updated.id, created.id, 'Expected later cron runs to update the existing state variable');

    const state = JSON.parse(updated.value) as { sequentialIndex?: number };
    assert.equal(state.sequentialIndex, 0, `Expected wrapped sequential index after two sends, got ${updated.value}`);
  });

  it('does not advance persisted rotation state when broadcasting fails', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Fail First' }, { text: 'Fail Second' }],
    });

    await ctx.server.shutdown();
    await wait(500);

    const failed = await triggerCronjob();
    assert.equal(failed.success, false, `Expected failed broadcast run to report failure, logs: ${JSON.stringify(failed.logs)}`);

    const stateAfterFailure = await getStateVariable();
    assert.equal(stateAfterFailure, null, 'Expected no rotation state to be persisted after a failed first broadcast');
  });

  it('removes the execution lock after a failed broadcast', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Recover First' }, { text: 'Recover Second' }],
    });

    await ctx.server.shutdown();
    await wait(500);

    const failed = await triggerCronjob();
    assert.equal(failed.success, false, `Expected failed broadcast run to report failure, logs: ${JSON.stringify(failed.logs)}`);

    const lockAfterFailure = await getVariable(LOCK_KEY);
    assert.equal(lockAfterFailure, null, 'Expected failed run to release its execution lock');
  });

  it('documents placeholder support, normalization behavior, and bounded message lists in module.json', async () => {
    const moduleJson = JSON.parse(await fs.readFile(path.join(MODULE_DIR, 'module.json'), 'utf8')) as {
      config: {
        properties: {
          messages: {
            description?: string;
            maxItems?: number;
            items: { properties: { text: { description?: string }; weight: { type?: string; description?: string } } };
          };
        };
      };
    };

    assert.match(moduleJson.config.properties.messages.description ?? '', /\{playerCount\}.*\{serverName\}/);
    assert.match(moduleJson.config.properties.messages.description ?? '', /Unknown placeholders are left unchanged/);
    assert.equal(moduleJson.config.properties.messages.maxItems, 100);
    assert.match(moduleJson.config.properties.messages.items.properties.text.description ?? '', /Whitespace-only messages are ignored/);
    assert.equal(moduleJson.config.properties.messages.items.properties.weight.type, 'number');
    assert.match(moduleJson.config.properties.messages.items.properties.weight.description ?? '', /clamps weights into the 1-100 range/);
  });
});
