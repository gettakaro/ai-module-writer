import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'node:fs/promises';
import os from 'node:os';
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
import {
  buildConfigFingerprint,
  normalizeMessages,
  SERVER_MESSAGES_DELIVERY_RECEIPT_KEY,
} from '../src/functions/server-message-helpers.shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_MODULE_DIR = path.resolve(__dirname, '..');
const TEST_MODULE_NAME = 'test-server-messages';
const STATE_KEY = 'server_messages_state';
const LOCK_KEY = 'server_messages_lock';
const FORCE_STATE_WRITE_FAILURE_KEY = 'server_messages_test_force_state_write_failure';
const FORCE_RECEIPT_WRITE_FAILURE_KEY = 'server_messages_test_force_receipt_write_failure';

describe('server-messages: broadcast cronjob', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleDir: string;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;
  let installed = false;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    moduleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takaro-server-messages-'));
    await fs.cp(SOURCE_MODULE_DIR, moduleDir, { recursive: true });

    const moduleJsonPath = path.join(moduleDir, 'module.json');
    const moduleJson = JSON.parse(await fs.readFile(moduleJsonPath, 'utf8')) as { name: string };
    moduleJson.name = TEST_MODULE_NAME;
    await fs.writeFile(moduleJsonPath, JSON.stringify(moduleJson, null, 2));

    const mod = await pushModule(client, moduleDir);
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
    if (moduleId) {
      try {
        await deleteModule(client, moduleId);
      } catch (err) {
        console.error('Cleanup: failed to delete module:', err);
      }
    }
    if (moduleDir) {
      await fs.rm(moduleDir, { recursive: true, force: true });
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

  async function waitForVariable(
    key: string,
    predicate?: (variable: VariableOutputDTO) => boolean,
    timeoutMs = 30000,
  ): Promise<VariableOutputDTO> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const variable = await getVariable(key);
      if (variable && (!predicate || predicate(variable))) {
        return variable;
      }
      await wait(100);
    }

    throw new Error(`Timed out waiting for variable ${key}`);
  }

  async function deleteVariableByKey(key: string): Promise<void> {
    const existing = await getVariable(key);
    if (existing) {
      await client.variable.variableControllerDelete(existing.id);
    }
  }

  async function upsertModuleVariable(input: {
    key: string;
    value: string;
    expiresAt?: string;
  }): Promise<void> {
    const existing = await getVariable(input.key);
    if (existing) {
      await client.variable.variableControllerUpdate(existing.id, {
        value: input.value,
        expiresAt: input.expiresAt,
      });
      return;
    }

    await client.variable.variableControllerCreate({
      key: input.key,
      value: input.value,
      expiresAt: input.expiresAt,
      gameServerId: ctx.gameServer.id,
      moduleId,
    });
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
      await Promise.all([
        deleteVariableByKey(STATE_KEY),
        deleteVariableByKey(LOCK_KEY),
        deleteVariableByKey(SERVER_MESSAGES_DELIVERY_RECEIPT_KEY),
      ]);
    }
    await wait(500);
  }

  async function setGameServerAvailability(enabled: boolean, reachable: boolean): Promise<void> {
    await client.gameserver.gameServerControllerUpdate(ctx.gameServer.id, {
      name: ctx.gameServer.name,
      connectionInfo: JSON.stringify(ctx.gameServer.connectionInfo),
      type: ctx.gameServer.type,
      enabled,
      reachable,
    });
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

  it('succeeds quietly when messages is empty or omitted', async () => {
    await reinstall({
      order: 'sequential',
      messages: [],
    });

    const explicitEmpty = await triggerCronjobAndCollectMessages();
    assert.equal(explicitEmpty.success, true, `Expected empty-message run to succeed, logs: ${JSON.stringify(explicitEmpty.logs)}`);
    assert.deepEqual(explicitEmpty.chatMessages, []);
    assert.ok(
      explicitEmpty.logs.some((log) => log.includes('no messages configured')),
      `Expected no-messages log, got: ${JSON.stringify(explicitEmpty.logs)}`,
    );

    await reinstall({
      order: 'sequential',
    });

    const omittedMessages = await triggerCronjobAndCollectMessages();
    assert.equal(omittedMessages.success, true, `Expected omitted-messages run to succeed, logs: ${JSON.stringify(omittedMessages.logs)}`);
    assert.deepEqual(omittedMessages.chatMessages, []);
    assert.ok(
      omittedMessages.logs.some((log) => log.includes('no messages configured')),
      `Expected no-messages log when messages is omitted, got: ${JSON.stringify(omittedMessages.logs)}`,
    );
  });

  it('rejects whitespace-only messages at install time so invalid configs fail loudly', async () => {
    await assert.rejects(
      reinstall({
        order: 'sequential',
        messages: [{ text: '   ' }],
      }),
      /pattern|validation|config|userConfig/i,
    );
  });

  it('renders supported placeholders in broadcast output', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Players={playerCount} Server={serverName}' }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected placeholder run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, [
      `Players=3 Server=${ctx.gameServer.name}`,
    ]);
  });

  it('uses a readable fallback when the runtime server name is unavailable', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Server={serverName}' }],
    });

    const originalName = ctx.gameServer.name;
    await client.gameserver.gameServerControllerUpdate(ctx.gameServer.id, {
      name: '   ',
      connectionInfo: JSON.stringify(ctx.gameServer.connectionInfo),
      type: ctx.gameServer.type,
      enabled: ctx.gameServer.enabled,
      reachable: ctx.gameServer.reachable,
    });

    try {
      const result = await triggerCronjobAndCollectMessages();
      assert.equal(result.success, true, `Expected unavailable-server-name run to succeed, logs: ${JSON.stringify(result.logs)}`);
      assert.deepEqual(result.chatMessages, ['Server=this server']);
      assert.ok(
        result.logs.some((log) => log.includes("using fallback 'this server'")),
        `Expected server-name fallback warning log, got: ${JSON.stringify(result.logs)}`,
      );
    } finally {
      await client.gameserver.gameServerControllerUpdate(ctx.gameServer.id, {
        name: originalName,
        connectionInfo: JSON.stringify(ctx.gameServer.connectionInfo),
        type: ctx.gameServer.type,
        enabled: ctx.gameServer.enabled,
        reachable: ctx.gameServer.reachable,
      });
    }
  });

  it('rejects unknown placeholders at install time so typoed configs fail loudly', async () => {
    await assert.rejects(
      reinstall({
        order: 'sequential',
        messages: [{ text: 'Server={serverNmae}' }],
      }),
      /pattern|validation|config|userConfig/i,
    );
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

    await upsertModuleVariable({
      key: STATE_KEY,
      value: 'not-json',
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

    await upsertModuleVariable({
      key: LOCK_KEY,
      value: JSON.stringify({ acquiredAt: new Date(Date.now() - 60000).toISOString() }),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected stale-lock run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, ['Alpha']);

    const lockVariable = await getVariable(LOCK_KEY);
    assert.equal(lockVariable, null, 'Expected stale execution lock to be cleared after broadcast completes');
  });

  it('waits for a healthy execution lock to expire instead of failing early under contention', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Alpha' }, { text: 'Beta' }],
    });

    await upsertModuleVariable({
      key: LOCK_KEY,
      value: JSON.stringify({
        token: 'held-by-other-run',
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
      expiresAt: new Date(Date.now() + 2000).toISOString(),
    });

    const startedAt = Date.now();
    const before = new Date();
    const result = await triggerCronjob();
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.success, true, `Expected lock-contention run to succeed after waiting, logs: ${JSON.stringify(result.logs)}`);

    const chatMessages = await getChatMessages(before);
    assert.deepEqual(chatMessages, ['Alpha'], `Expected broadcast after foreign lock expired, got ${JSON.stringify(chatMessages)}`);
    assert.ok(
      elapsedMs >= 1500,
      `Expected cronjob to wait for the healthy lock to expire before broadcasting, but it finished in ${elapsedMs}ms. Logs: ${JSON.stringify(result.logs)}`,
    );
    assert.ok(
      result.logs.some((log) => log.includes('cleared stale execution lock'))
        || result.logs.some((log) => log.includes('refreshed execution lock heartbeat at before-broadcast')),
      `Expected evidence that the run waited out the foreign lock and then acquired its own lock, got: ${JSON.stringify(result.logs)}`,
    );
  });

  it('rejects out-of-range weights at install time instead of silently coercing them', async () => {
    await assert.rejects(
      reinstall({
        order: 'random',
        messages: [{ text: 'Low', weight: 0 }, { text: 'High', weight: 101 }],
      }),
      /minimum|maximum|validation|config|userConfig/i,
    );
  });

  it('rejects installs with more than 100 configured messages', async () => {
    await assert.rejects(
      reinstall({
        order: 'sequential',
        messages: Array.from({ length: 101 }, (_, index) => ({ text: `Message ${index + 1}` })),
      }),
      /maxItems|validation|config|userConfig/i,
    );
  });

  it('builds a bounded weighted bag from valid message weights', async () => {
    await reinstall({
      order: 'random',
      messages: [{ text: 'Low', weight: 1 }, { text: 'High', weight: 100 }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected valid-weight run to succeed, logs: ${JSON.stringify(result.logs)}`);

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected state variable after valid-weight run');
    const state = JSON.parse(stateVariable.value) as { bag?: number[]; cursor?: number };
    const counts = (state.bag ?? []).reduce<Record<number, number>>((acc, index) => {
      acc[index] = (acc[index] ?? 0) + 1;
      return acc;
    }, {});

    assert.equal(state.bag?.length, 101, `Expected bounded weighted bag length 101, got ${stateVariable.value}`);
    assert.equal(counts[0], 1, `Expected low weight to occupy one slot, got ${stateVariable.value}`);
    assert.equal(counts[1], 100, `Expected high weight to occupy 100 slots, got ${stateVariable.value}`);
    assert.equal(state.cursor, 1, `Expected weighted bag cursor to advance once, got ${stateVariable.value}`);
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

  it('refreshes the execution lock heartbeat at broadcast checkpoints', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Heartbeat check' }],
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected heartbeat run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(
      result.logs.some((log) => log.includes('refreshed execution lock heartbeat at before-broadcast')),
      `Expected before-broadcast heartbeat refresh log, got: ${JSON.stringify(result.logs)}`,
    );
    assert.ok(
      result.logs.some((log) => log.includes('refreshed execution lock heartbeat at before-state-persist')),
      `Expected before-state-persist heartbeat refresh log, got: ${JSON.stringify(result.logs)}`,
    );
  });

  it('fails cleanly when lock ownership changes before a heartbeat checkpoint', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Ownership check' }],
    });

    const before = new Date();
    const pendingRun = triggerCronjob();

    await waitForVariable(LOCK_KEY, undefined, 5000);
    let stoleLock = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const currentLock = await getVariable(LOCK_KEY);
      if (!currentLock) {
        await wait(50);
        continue;
      }

      const payload = JSON.parse(currentLock.value) as { acquiredAt?: string; heartbeatAt?: string };
      try {
        await client.variable.variableControllerUpdate(currentLock.id, {
          value: JSON.stringify({
            ...payload,
            token: 'stolen-lock-token',
          }),
          expiresAt: currentLock.expiresAt,
        });
        stoleLock = true;
        break;
      } catch (err) {
        if ((err as { response?: { status?: number } })?.response?.status !== 404) {
          throw err;
        }
      }

      await wait(50);
    }

    assert.equal(stoleLock, true, 'Expected to steal the lock before the cronjob finished');

    const failed = await pendingRun;
    assert.equal(failed.success, false, `Expected ownership-loss run to fail, logs: ${JSON.stringify(failed.logs)}`);
    assert.ok(
      failed.logs.some((log) => log.includes('ownership changed during heartbeat')),
      `Expected heartbeat ownership-loss log, got: ${JSON.stringify(failed.logs)}`,
    );

    const chatMessages = await getChatMessages(before);
    assert.deepEqual(chatMessages, [], `Expected no broadcast after lock ownership loss, got ${JSON.stringify(chatMessages)}`);

    const lockVariable = await getVariable(LOCK_KEY);
    if (lockVariable) {
      await client.variable.variableControllerDelete(lockVariable.id);
    }
  });

  it('does not advance persisted rotation state when a later broadcast fails', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Fail First' }, { text: 'Fail Second' }],
    });

    const first = await triggerCronjobAndCollectMessages();
    assert.equal(first.success, true, `Expected setup run to succeed, logs: ${JSON.stringify(first.logs)}`);
    assert.deepEqual(first.chatMessages, ['Fail First']);

    const stateBeforeFailure = await getStateVariable();
    assert.ok(stateBeforeFailure, 'Expected state variable after first successful broadcast');
    assert.equal(JSON.parse(stateBeforeFailure.value).sequentialIndex, 1);

    await setGameServerAvailability(false, false);

    try {
      const failed = await triggerCronjob();
      assert.equal(failed.success, false, `Expected failed broadcast run to report failure, logs: ${JSON.stringify(failed.logs)}`);
      assert.ok(
        !failed.logs.some((log) => log.includes('no online players')),
        `Expected failure to happen after lock acquisition and player counting, got logs: ${JSON.stringify(failed.logs)}`,
      );

      const stateAfterFailure = await getStateVariable();
      assert.ok(stateAfterFailure, 'Expected prior rotation state to remain after failed later broadcast');
      assert.equal(
        JSON.parse(stateAfterFailure.value).sequentialIndex,
        1,
        `Expected failed later broadcast to preserve sequential index, got ${stateAfterFailure.value}`,
      );
    } finally {
      await setGameServerAvailability(ctx.gameServer.enabled, ctx.gameServer.reachable);
    }

    const retried = await triggerCronjobAndCollectMessages();
    assert.equal(retried.success, true, `Expected retry after restoring server availability to succeed, logs: ${JSON.stringify(retried.logs)}`);
    assert.deepEqual(retried.chatMessages, ['Fail Second']);
  });

  it('discards malformed delivery receipts and continues with a normal broadcast', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Malformed receipt fallback' }],
    });

    await upsertModuleVariable({
      key: SERVER_MESSAGES_DELIVERY_RECEIPT_KEY,
      value: '{not-json',
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected malformed-receipt run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, ['Malformed receipt fallback']);

    const receiptVariable = await getVariable(SERVER_MESSAGES_DELIVERY_RECEIPT_KEY);
    assert.equal(receiptVariable, null, 'Expected malformed delivery receipt to be discarded during recovery');
  });

  it('discards stale delivery receipts whose fingerprint no longer matches the config', async () => {
    const oldMessages = [{ text: 'Old receipt message' }];
    await reinstall({
      order: 'sequential',
      messages: oldMessages,
    });

    const oldFingerprint = buildConfigFingerprint('sequential', normalizeMessages(oldMessages));
    await upsertModuleVariable({
      key: SERVER_MESSAGES_DELIVERY_RECEIPT_KEY,
      value: JSON.stringify({
        fingerprint: oldFingerprint,
        nextState: {
          fingerprint: oldFingerprint,
          sequentialIndex: 1,
          bag: [],
          cursor: 0,
        },
        messageIndex: 0,
        renderedMessage: 'Old receipt message',
        sentAt: new Date().toISOString(),
      }),
    });

    await reinstall(
      {
        order: 'sequential',
        messages: [{ text: 'New config first' }, { text: 'New config second' }],
      },
      { clearState: false },
    );

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected stale-receipt run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, ['New config first']);
    assert.ok(
      result.logs.some((log) => log.includes('discarded stale delivery receipt')),
      `Expected stale receipt discard log, got: ${JSON.stringify(result.logs)}`,
    );

    const receiptVariable = await getVariable(SERVER_MESSAGES_DELIVERY_RECEIPT_KEY);
    assert.equal(receiptVariable, null, 'Expected stale delivery receipt to be cleared before broadcasting the new config');
  });

  it('recovers persisted next-state from a delivery receipt without rebroadcasting', async () => {
    const messages = [{ text: 'Receipt First' }, { text: 'Receipt Second' }];
    const order = 'sequential';
    await reinstall({
      order,
      messages,
    });

    const fingerprint = buildConfigFingerprint(order, normalizeMessages(messages));
    await upsertModuleVariable({
      key: SERVER_MESSAGES_DELIVERY_RECEIPT_KEY,
      value: JSON.stringify({
        fingerprint,
        nextState: {
          fingerprint,
          sequentialIndex: 1,
          bag: [],
          cursor: 0,
        },
        messageIndex: 0,
        renderedMessage: 'Receipt First',
        sentAt: new Date().toISOString(),
      }),
    });

    const result = await triggerCronjobAndCollectMessages();
    assert.equal(result.success, true, `Expected receipt-recovery run to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.deepEqual(result.chatMessages, [], `Expected receipt recovery to avoid duplicate rebroadcasts, got ${JSON.stringify(result.chatMessages)}`);
    assert.ok(
      result.logs.some((log) => log.includes('recovered rotation state from prior successful broadcast without rebroadcasting')),
      `Expected receipt recovery log, got: ${JSON.stringify(result.logs)}`,
    );

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected receipt recovery to persist the next state');
    assert.equal(JSON.parse(stateVariable.value).sequentialIndex, 1, `Expected recovered next state to be written, got ${stateVariable.value}`);

    const receiptVariable = await getVariable(SERVER_MESSAGES_DELIVERY_RECEIPT_KEY);
    assert.equal(receiptVariable, null, 'Expected delivery receipt to be cleared after successful recovery');
  });

  it('writes a delivery receipt when state persistence fails after a successful send, then resumes without duplicate chat', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Persist First' }, { text: 'Persist Second' }],
    });

    const setupRun = await triggerCronjobAndCollectMessages();
    assert.equal(setupRun.success, true, `Expected setup run to succeed, logs: ${JSON.stringify(setupRun.logs)}`);
    assert.deepEqual(setupRun.chatMessages, ['Persist First']);

    await upsertModuleVariable({
      key: FORCE_STATE_WRITE_FAILURE_KEY,
      value: JSON.stringify({ reason: 'exercise receipt fallback' }),
    });

    const failedAfterSend = await triggerCronjobAndCollectMessages();
    assert.equal(failedAfterSend.success, false, `Expected persistence-failure run to report failure, logs: ${JSON.stringify(failedAfterSend.logs)}`);
    assert.deepEqual(failedAfterSend.chatMessages, ['Persist Second']);
    assert.ok(
      failedAfterSend.logs.some((log) => log.includes('A recovery marker was stored')),
      `Expected operator guidance about stored recovery marker, got: ${JSON.stringify(failedAfterSend.logs)}`,
    );

    const receiptVariable = await getVariable(SERVER_MESSAGES_DELIVERY_RECEIPT_KEY);
    assert.ok(receiptVariable, 'Expected persistence-failure run to store a delivery receipt');
    const receipt = JSON.parse(receiptVariable.value) as { messageIndex?: number; renderedMessage?: string; nextState?: { sequentialIndex?: number } };
    assert.equal(receipt.messageIndex, 1, `Expected receipt to point at the already-sent second message, got ${receiptVariable.value}`);
    assert.equal(receipt.renderedMessage, 'Persist Second', `Expected receipt to preserve the sent message, got ${receiptVariable.value}`);
    assert.equal(receipt.nextState?.sequentialIndex, 0, `Expected receipt to store the next wrapped state, got ${receiptVariable.value}`);

    const recoveryRun = await triggerCronjobAndCollectMessages();
    assert.equal(recoveryRun.success, true, `Expected recovery run to succeed, logs: ${JSON.stringify(recoveryRun.logs)}`);
    assert.deepEqual(recoveryRun.chatMessages, [], `Expected recovery run to avoid duplicate rebroadcasts, got ${JSON.stringify(recoveryRun.chatMessages)}`);

    const stateVariable = await getStateVariable();
    assert.ok(stateVariable, 'Expected recovery run to restore persisted state');
    assert.equal(JSON.parse(stateVariable.value).sequentialIndex, 0, `Expected recovery run to persist the receipt next-state, got ${stateVariable.value}`);
    assert.equal(await getVariable(SERVER_MESSAGES_DELIVERY_RECEIPT_KEY), null, 'Expected receipt to be cleared after recovery');

    const nextBroadcast = await triggerCronjobAndCollectMessages();
    assert.equal(nextBroadcast.success, true, `Expected post-recovery broadcast to succeed, logs: ${JSON.stringify(nextBroadcast.logs)}`);
    assert.deepEqual(nextBroadcast.chatMessages, ['Persist First']);
  });

  it('surfaces operator-focused guidance when both state persistence and receipt persistence fail after send', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Guide First' }, { text: 'Guide Second' }],
    });

    const setupRun = await triggerCronjobAndCollectMessages();
    assert.equal(setupRun.success, true, `Expected setup run to succeed, logs: ${JSON.stringify(setupRun.logs)}`);

    await upsertModuleVariable({
      key: FORCE_STATE_WRITE_FAILURE_KEY,
      value: JSON.stringify({ reason: 'exercise nested fallback failure' }),
    });
    await upsertModuleVariable({
      key: FORCE_RECEIPT_WRITE_FAILURE_KEY,
      value: JSON.stringify({ reason: 'exercise nested fallback failure' }),
    });

    const failedAfterSend = await triggerCronjobAndCollectMessages();
    assert.equal(failedAfterSend.success, false, `Expected nested persistence-failure run to report failure, logs: ${JSON.stringify(failedAfterSend.logs)}`);
    assert.deepEqual(failedAfterSend.chatMessages, ['Guide Second']);
    assert.ok(
      failedAfterSend.logs.some((log) => log.includes('Do not blindly retry this cronjob')),
      `Expected operator guidance not to retry blindly, got: ${JSON.stringify(failedAfterSend.logs)}`,
    );
    assert.ok(
      failedAfterSend.logs.some((log) => log.includes('Check module variables or Takaro storage health before retrying')),
      `Expected operator guidance about what to inspect next, got: ${JSON.stringify(failedAfterSend.logs)}`,
    );
  });

  it('removes the execution lock after a failed broadcast send attempt', async () => {
    await reinstall({
      order: 'sequential',
      messages: [{ text: 'Recover First' }, { text: 'Recover Second' }],
    });

    await setGameServerAvailability(false, false);

    try {
      const failed = await triggerCronjob();
      assert.equal(failed.success, false, `Expected failed broadcast run to report failure, logs: ${JSON.stringify(failed.logs)}`);
      assert.ok(
        !failed.logs.some((log) => log.includes('no online players')),
        `Expected send failure path instead of the zero-player fast path, got logs: ${JSON.stringify(failed.logs)}`,
      );

      const lockAfterFailure = await getVariable(LOCK_KEY);
      assert.equal(lockAfterFailure, null, 'Expected failed run to release its execution lock');
    } finally {
      await setGameServerAvailability(ctx.gameServer.enabled, ctx.gameServer.reachable);
    }
  });

  it('documents placeholder support, preservation behavior, and bounded message lists in module.json', async () => {
    const moduleJson = JSON.parse(await fs.readFile(path.join(SOURCE_MODULE_DIR, 'module.json'), 'utf8')) as {
      config: {
        required?: string[];
        properties: {
          messages: {
            description?: string;
            maxItems?: number;
            items: {
              properties: {
                text: { description?: string; pattern?: string; allOf?: Array<{ pattern?: string }> };
                weight: { type?: string; minimum?: number; maximum?: number; description?: string };
              };
            };
          };
        };
      };
    };

    assert.match(moduleJson.config.properties.messages.description ?? '', /\{playerCount\}.*\{serverName\}/);
    assert.match(moduleJson.config.properties.messages.description ?? '', /Unsupported placeholder typos are rejected at install time/);
    assert.match(moduleJson.config.properties.messages.description ?? '', /at least one non-whitespace character/);
    assert.deepEqual(moduleJson.config.required ?? [], []);
    assert.equal(moduleJson.config.properties.messages.maxItems, 100);
    const textSchema = moduleJson.config.properties.messages.items.properties.text;
    assert.equal(textSchema.allOf?.[0]?.pattern, '\\S');
    assert.equal(textSchema.allOf?.[1]?.pattern, '^(?!.*\\{(?!playerCount\\}|serverName\\})[^{}]*\\}).*$');
    assert.match(moduleJson.config.properties.messages.items.properties.text.description ?? '', /Unsupported placeholder typos are rejected at install time/);
    assert.match(moduleJson.config.properties.messages.items.properties.text.description ?? '', /Whitespace-only messages are rejected at install time/);
    assert.equal(moduleJson.config.properties.messages.items.properties.weight.type, 'integer');
    assert.equal(moduleJson.config.properties.messages.items.properties.weight.minimum, 1);
    assert.equal(moduleJson.config.properties.messages.items.properties.weight.maximum, 100);
    assert.match(moduleJson.config.properties.messages.items.properties.weight.description ?? '', /rejected at install time/i);
  });
});
