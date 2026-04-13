import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, EventSearchInputAllowedFiltersEventNameEnum } from '@takaro/apiclient';
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

type CronResult = { success: boolean; logs: string[] };

function makeCronjobHelper(
  getClient: () => Client,
  getGameServerId: () => string,
  getCronjobId: () => string,
  getModuleId: () => string,
) {
  return async function triggerCronjob(): Promise<CronResult> {
    const client = getClient();
    const triggerTime = new Date();

    await client.cronjob.cronJobControllerTrigger({
      gameServerId: getGameServerId(),
      cronjobId: getCronjobId(),
      moduleId: getModuleId(),
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: getGameServerId(),
      after: triggerTime,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    await wait(1000);

    return {
      success: meta?.result?.success ?? false,
      logs: (meta?.result?.logs ?? []).map((log) => log.msg),
    };
  };
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOnlineCount(client: Client, gameServerId: string, expected: number, timeout = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [gameServerId],
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

async function readModuleVariable(client: Client, gameServerId: string, moduleId: string, key: string) {
  const result = await client.variable.variableControllerSearch({
    filters: {
      key: [key],
      gameServerId: [gameServerId],
      moduleId: [moduleId],
    },
  });

  return result.data.data[0] ?? null;
}

async function upsertModuleVariable(
  client: Client,
  gameServerId: string,
  moduleId: string,
  key: string,
  value: string,
) {
  const existing = await readModuleVariable(client, gameServerId, moduleId, key);
  if (existing) {
    await client.variable.variableControllerUpdate(existing.id, { value });
    return;
  }

  await client.variable.variableControllerCreate({
    key,
    value,
    gameServerId,
    moduleId,
  });
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

describe('server-messages: sequential rotation and quiet skips', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;

  const triggerCronjob = makeCronjobHelper(
    () => client,
    () => ctx.gameServer.id,
    () => cronjobId,
    () => moduleId,
  );

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    cronjobId = mod.latestVersion.cronJobs[0]!.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        messages: [
          { text: 'Alpha message' },
          { text: 'Players={playerCount}; Server={serverName}; Unknown={unknown}' },
        ],
        order: 'sequential',
        interval: '*/15 * * * *',
      },
    });
  });

  after(async () => {
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall sequential test module:', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete sequential test module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('sends sequential messages, renders placeholders, and wraps', async () => {
    const first = await triggerCronjob();
    assert.equal(first.success, true, `Expected first cron trigger to succeed, logs: ${JSON.stringify(first.logs)}`);
    assert.ok(
      first.logs.some((log) => log.includes('order=sequential') && log.includes('messageIndex=0')),
      `Expected first log to mention sequential messageIndex=0, got: ${JSON.stringify(first.logs)}`,
    );
    assert.equal(parseJsonLogField(first.logs, 'rendered'), 'Alpha message');

    const stateAfterFirst = await readModuleVariable(client, ctx.gameServer.id, moduleId, STATE_KEY);
    assert.ok(stateAfterFirst, 'Expected sequential state variable to exist after first send');
    assert.deepEqual(JSON.parse(stateAfterFirst!.value), { order: 'sequential', index: 1 });

    const second = await triggerCronjob();
    assert.equal(second.success, true, `Expected second cron trigger to succeed, logs: ${JSON.stringify(second.logs)}`);
    assert.ok(
      second.logs.some((log) => log.includes('messageIndex=1')),
      `Expected second log to mention messageIndex=1, got: ${JSON.stringify(second.logs)}`,
    );
    assert.equal(
      parseJsonLogField(second.logs, 'rendered'),
      `Players=3; Server=${ctx.gameServer.name}; Unknown={unknown}`,
    );

    const stateAfterSecond = await readModuleVariable(client, ctx.gameServer.id, moduleId, STATE_KEY);
    assert.deepEqual(JSON.parse(stateAfterSecond!.value), { order: 'sequential', index: 0 });
  });

  it('does not advance sequential state when nobody is online', async () => {
    await ctx.server.executeConsoleCommand('disconnectAll');
    await waitForOnlineCount(client, ctx.gameServer.id, 0);

    const skipped = await triggerCronjob();
    assert.equal(skipped.success, true, `Expected zero-player cron trigger to succeed, logs: ${JSON.stringify(skipped.logs)}`);
    assert.ok(
      skipped.logs.some((log) => log.includes('no players online')),
      `Expected skip log for zero online players, got: ${JSON.stringify(skipped.logs)}`,
    );

    const stateAfterSkip = await readModuleVariable(client, ctx.gameServer.id, moduleId, STATE_KEY);
    assert.deepEqual(JSON.parse(stateAfterSkip!.value), { order: 'sequential', index: 0 });

    await ctx.server.executeConsoleCommand('connectAll');
    await waitForOnlineCount(client, ctx.gameServer.id, 3);

    const resumed = await triggerCronjob();
    assert.equal(resumed.success, true, `Expected resumed cron trigger to succeed, logs: ${JSON.stringify(resumed.logs)}`);
    assert.equal(parseJsonLogField(resumed.logs, 'rendered'), 'Alpha message');
  });

  it('handles empty message lists quietly', async () => {
    await uninstallModule(client, moduleId, ctx.gameServer.id);
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        messages: [],
        order: 'sequential',
      },
    });

    const result = await triggerCronjob();
    assert.equal(result.success, true, `Expected empty-message cron trigger to succeed, logs: ${JSON.stringify(result.logs)}`);
    assert.ok(
      result.logs.some((log) => log.includes('no messages configured')),
      `Expected quiet empty-message log, got: ${JSON.stringify(result.logs)}`,
    );
  });
});

describe('server-messages: weighted shuffle-bag random rotation', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let cronjobId: string;

  const triggerCronjob = makeCronjobHelper(
    () => client,
    () => ctx.gameServer.id,
    () => cronjobId,
    () => moduleId,
  );

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    cronjobId = mod.latestVersion.cronJobs[0]!.id;

    await installModule(client, mod.latestVersion.id, ctx.gameServer.id, {
      userConfig: {
        messages: [
          { text: 'Red', weight: 1 },
          { text: 'Gold', weight: 2 },
        ],
        order: 'random',
      },
    });
  });

  after(async () => {
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall random test module:', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete random test module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('consumes each weighted bag slot exactly once before rebuilding', async () => {
    const first = await triggerCronjob();
    assert.equal(first.success, true, `Expected first random trigger to succeed, logs: ${JSON.stringify(first.logs)}`);

    const stateAfterFirst = JSON.parse((await readModuleVariable(client, ctx.gameServer.id, moduleId, STATE_KEY))!.value) as {
      order: string;
      bag: number[];
      cursor: number;
    };

    assert.equal(stateAfterFirst.order, 'random');
    assert.equal(stateAfterFirst.bag.length, 3, `Expected weighted bag length of 3, got ${JSON.stringify(stateAfterFirst)}`);

    const bag = [...stateAfterFirst.bag];
    const sentIndices = [
      parseNumericLogField(first.logs, 'messageIndex'),
      parseNumericLogField((await triggerCronjob()).logs, 'messageIndex'),
      parseNumericLogField((await triggerCronjob()).logs, 'messageIndex'),
    ];

    assert.deepEqual(sentIndices, bag, `Expected one full bag cycle to consume bag slots in order, bag=${JSON.stringify(bag)} sent=${JSON.stringify(sentIndices)}`);

    const redCount = sentIndices.filter((entry) => entry === 0).length;
    const goldCount = sentIndices.filter((entry) => entry === 1).length;
    assert.equal(redCount, 1, `Expected Red to appear once per bag, got ${JSON.stringify(sentIndices)}`);
    assert.equal(goldCount, 2, `Expected Gold to appear twice per bag, got ${JSON.stringify(sentIndices)}`);

    for (let i = 1; i < bag.length; i++) {
      if (bag[i] === bag[i - 1]) {
        assert.equal(bag[i], 1, `Only the higher-weight message should be able to repeat adjacently within the same bag, bag=${JSON.stringify(bag)}`);
      }
    }

    const fourth = await triggerCronjob();
    assert.equal(fourth.success, true, `Expected fourth random trigger to succeed, logs: ${JSON.stringify(fourth.logs)}`);

    const stateAfterFourth = JSON.parse((await readModuleVariable(client, ctx.gameServer.id, moduleId, STATE_KEY))!.value) as {
      bag: number[];
      cursor: number;
    };
    assert.equal(stateAfterFourth.bag.length, 3, `Expected rebuilt random bag length to remain 3, got ${JSON.stringify(stateAfterFourth)}`);
    assert.equal(stateAfterFourth.cursor, 1, `Expected next cycle cursor to reset and advance to 1 after fourth send, got ${JSON.stringify(stateAfterFourth)}`);
  });
});

describe('server-messages: config fingerprint reset', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let cronjobId: string;

  const triggerCronjob = makeCronjobHelper(
    () => client,
    () => ctx.gameServer.id,
    () => cronjobId,
    () => moduleId,
  );

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;
    cronjobId = mod.latestVersion.cronJobs[0]!.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        messages: [
          { text: 'Old one' },
          { text: 'Old two' },
        ],
        order: 'sequential',
      },
    });
  });

  after(async () => {
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall config-reset test module:', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete config-reset test module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('restarts rotation cleanly after config changes', async () => {
    const beforeChange = await triggerCronjob();
    assert.equal(beforeChange.success, true, `Expected initial trigger to succeed, logs: ${JSON.stringify(beforeChange.logs)}`);
    assert.equal(parseJsonLogField(beforeChange.logs, 'rendered'), 'Old one');

    await uninstallModule(client, moduleId, ctx.gameServer.id);
    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        messages: [
          { text: 'New first' },
          { text: 'New second' },
        ],
        order: 'sequential',
      },
    });

    await upsertModuleVariable(
      client,
      ctx.gameServer.id,
      moduleId,
      STATE_KEY,
      JSON.stringify({ order: 'sequential', index: 1 }),
    );
    await upsertModuleVariable(client, ctx.gameServer.id, moduleId, FINGERPRINT_KEY, 'stale-fingerprint');

    const afterChange = await triggerCronjob();
    assert.equal(afterChange.success, true, `Expected post-change trigger to succeed, logs: ${JSON.stringify(afterChange.logs)}`);
    assert.ok(
      afterChange.logs.some((log) => log.includes('config fingerprint changed')),
      `Expected config reset log, got: ${JSON.stringify(afterChange.logs)}`,
    );
    assert.equal(parseJsonLogField(afterChange.logs, 'rendered'), 'New first');

    const stateAfterChange = await readModuleVariable(client, ctx.gameServer.id, moduleId, STATE_KEY);
    assert.deepEqual(JSON.parse(stateAfterChange!.value), { order: 'sequential', index: 1 });
  });
});
