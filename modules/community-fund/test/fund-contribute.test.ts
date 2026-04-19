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
  assignPermissions,
  cleanupRole,
} from '../../../test/helpers/modules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_DIR = path.resolve(__dirname, '..');

// NOTE: Tests in this suite run sequentially and share fund state within the suite.
// player[0] has COMMUNITY_FUND_CONTRIBUTE permission; player[1] does NOT.
// The threshold is 100 and later tests intentionally build on earlier state:
// 1. contribute 20 (fund=20)
// 2. permission/validation failures keep fund at 20
// 3. same-player concurrent 30+30 submissions serialize behind the lock, so one paid contribution lands (fund=50)
// 4. the completion test reads the live total and contributes only what is needed to cross the threshold once
// 5. the final multiplayer concurrency test resets state and proves two simultaneous valid deposits both persist

describe('community-fund: fund-contribute command', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let contributeRoleId: string;
  let extraContributeRoleId: string | undefined;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    // Enable economy for this game server so currency operations work
    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        fundThreshold: 100,
        minimumContribution: 10,
        completionMessage: 'The community fund reached {threshold}!',
        completionCommands: [],
        broadcastContributions: true,
      },
    });
    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    // Assign COMMUNITY_FUND_CONTRIBUTE permission to player[0] only
    contributeRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['COMMUNITY_FUND_CONTRIBUTE'],
    );
  });

  after(async () => {
    await cleanupRole(client, contributeRoleId);
    await cleanupRole(client, extraContributeRoleId);
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

  async function getPog(playerId: string) {
    const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [playerId],
      },
    });
    return result.data.data[0];
  }

  async function waitForCommandEvents(after: Date, minimumCount: number) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await client.event.eventControllerSearch({
        filters: {
          eventName: [EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted],
          gameserverId: [ctx.gameServer.id],
        },
        greaterThan: {
          createdAt: after.toISOString(),
        },
        sortBy: 'createdAt',
        sortDirection: 'desc',
        limit: minimumCount + 5,
      });

      if (result.data.data.length >= minimumCount) {
        return result.data.data;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Timed out waiting for ${minimumCount} command-executed events`);
  }

  async function resetFundState() {
    const vars = await client.variable.variableControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
        key: ['fund_total', 'fund_cycle', 'fund_last_completion', 'fund_state_lock'],
      },
      limit: 100,
    });

    await Promise.all(vars.data.data.map((variable) => client.variable.variableControllerDelete(variable.id)));
  }

  async function upsertLockValue(value: string) {
    const existing = await client.variable.variableControllerSearch({
      filters: {
        key: ['fund_state_lock'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
      limit: 10,
    });

    const record = existing.data.data[0];
    if (record) {
      await client.variable.variableControllerUpdate(record.id, { value });
      return record.id;
    }

    const created = await client.variable.variableControllerCreate({
      key: 'fund_state_lock',
      value,
      gameServerId: ctx.gameServer.id,
      moduleId,
    });
    return created.data.data.id;
  }

  async function setCurrencyExact(playerId: string, desiredCurrency: number) {
    const pog = await getPog(playerId);
    assert.ok(pog, `Expected POG for player ${playerId}`);

    const currentCurrency = pog?.currency ?? 0;
    if (currentCurrency < desiredCurrency) {
      await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, playerId, {
        currency: desiredCurrency - currentCurrency,
      });
      return;
    }

    if (currentCurrency > desiredCurrency) {
      await client.playerOnGameserver.playerOnGameServerControllerDeductCurrency(ctx.gameServer.id, playerId, {
        currency: currentCurrency - desiredCurrency,
      });
    }
  }

  it('should contribute currency to the fund and PM the player', async () => {
    const player = ctx.players[0]!;

    // Give the player some currency first
    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(
      ctx.gameServer.id,
      player.playerId,
      { currency: 500 },
    );

    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 20`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected command to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('Fund contribution')),
      `Expected log to contain "Fund contribution", got: ${JSON.stringify(logMessages)}`,
    );

    // Verify actual fund total via /fundstatus after contribution
    const statusBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fundstatus`,
      playerId: player.playerId,
    });

    const statusEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: statusBefore,
      timeout: 30000,
    });

    assert.ok(statusEvent, 'Expected a fundstatus event after contribution');
    const statusMeta = statusEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(statusMeta?.result?.success, true, 'Expected fundstatus to succeed');

    const statusLogs = (statusMeta?.result?.logs ?? []).map((l) => l.msg);
    // After contributing 20, fund should show total=20 and threshold=100
    assert.ok(
      statusLogs.some((msg) => msg.includes('total=20') && msg.includes('threshold=100')),
      `Expected fundstatus log to show total=20 and threshold=100, got: ${JSON.stringify(statusLogs)}`,
    );
  });

  it('should deny contribution when player lacks permission', async () => {
    // player[1] has no COMMUNITY_FUND_CONTRIBUTE permission
    const player = ctx.players[1]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 20`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'Expected command to fail when player lacks permission');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('do not have permission')),
      `Expected log to contain "do not have permission", got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should reject contribution below minimumContribution', async () => {
    const player = ctx.players[0]!;

    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 5`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    // A TakaroUserError causes success:false
    assert.equal(meta?.result?.success, false, 'Expected command to fail with minimum contribution error');
  });

  it('should reject contribution when player has insufficient currency', async () => {
    const player = ctx.players[0]!;

    // Player0 started with 500, contributed 20, so has ~480 left
    // Contribute a huge amount the player definitely doesn't have
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 99999`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'Expected command to fail with insufficient currency error');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('enough currency')),
      `Expected log to mention "enough currency", got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should reject contribution of 0', async () => {
    const player = ctx.players[0]!;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 0`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'Expected command to fail for amount=0');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('positive whole number')),
      `Expected log to mention "positive whole number", got: ${JSON.stringify(logMessages)}`,
    );
    assert.ok(
      logMessages.some((msg) => msg.includes('Usage: /fund <amount>')),
      `Expected log to mention the in-game command form, got: ${JSON.stringify(logMessages)}`,
    );
  });

  it('should not advance the fund when a concurrent deduction fails', async () => {
    const player = ctx.players[0]!;
    const beforePog = await getPog(player.playerId);
    assert.ok(beforePog, 'Expected player POG to exist before concurrent contribution test');

    const currentCurrency = beforePog?.currency ?? 0;
    if (currentCurrency > 30) {
      await client.playerOnGameserver.playerOnGameServerControllerDeductCurrency(ctx.gameServer.id, player.playerId, {
        currency: currentCurrency - 30,
      });
    } else if (currentCurrency < 30) {
      await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, player.playerId, {
        currency: 30 - currentCurrency,
      });
    }

    const before = new Date();
    await Promise.all([
      client.command.commandControllerTrigger(ctx.gameServer.id, {
        msg: `${prefix}fund 30`,
        playerId: player.playerId,
      }),
      client.command.commandControllerTrigger(ctx.gameServer.id, {
        msg: `${prefix}fund 30`,
        playerId: player.playerId,
      }),
    ]);

    const events = await waitForCommandEvents(before, 2);
    const fundEvents = events
      .map((event) => event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } })
      .map((meta) => ({
        success: meta?.result?.success ?? false,
        logs: (meta?.result?.logs ?? []).map((l) => l.msg),
      }))
      .filter(
        (result) => result.logs.some((msg) => msg.includes('Fund contribution'))
          || result.logs.some((msg) => msg.includes('currency deduction failed'))
          || result.logs.some((msg) => msg.includes('could not be processed because your currency could not be deducted')),
      );

    assert.equal(fundEvents.length, 2, `Expected both concurrent contributions to execute, got: ${JSON.stringify(fundEvents)}`);
    assert.equal(
      fundEvents.filter((result) => result.success).length,
      1,
      `Expected exactly one contribution to succeed, got: ${JSON.stringify(fundEvents)}`,
    );
    assert.ok(
      fundEvents.some((result) => result.logs.some((msg) => msg.includes('currency deduction failed'))),
      `Expected one contribution to hit the deduction failure path, got: ${JSON.stringify(fundEvents)}`,
    );
    assert.ok(
      fundEvents.some((result) => result.logs.some((msg) => msg.includes('could not be processed because your currency could not be deducted'))),
      `Expected one contribution to surface the friendly deduction failure message, got: ${JSON.stringify(fundEvents)}`,
    );

    const afterPog = await getPog(player.playerId);
    assert.ok(afterPog, 'Expected player POG to exist after concurrent contribution test');
    assert.equal(afterPog?.currency, 0, `Expected only one 30-currency deduction to succeed, got: ${JSON.stringify(afterPog)}`);

    const statusBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fundstatus`,
      playerId: player.playerId,
    });
    const statusEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: statusBefore,
      timeout: 30000,
    });
    const statusMeta = statusEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const statusLogs = (statusMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      statusLogs.some((msg) => msg.includes('total=50')),
      `Expected only the paid contribution to advance the fund, got: ${JSON.stringify(statusLogs)}`,
    );
  });

  it('should trigger completion when fund reaches threshold', async () => {
    const player = ctx.players[0]!;

    const totalVariable = await client.variable.variableControllerSearch({
      filters: {
        key: ['fund_total'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    const currentTotal = totalVariable.data.data[0] ? JSON.parse(totalVariable.data.data[0].value) : 0;
    const amountNeeded = Math.max(10, 100 - currentTotal);

    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, player.playerId, {
      currency: amountNeeded,
    });

    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund ${amountNeeded}`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    assert.ok(event, 'Expected a command-executed event');
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected completion to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('Fund contribution')),
      `Expected a fund contribution log, got: ${JSON.stringify(logMessages)}`,
    );

    // After completion, verify fund was reset (to carryover) and cycle incremented via /fundstatus
    const statusBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fundstatus`,
      playerId: player.playerId,
    });

    const statusEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: statusBefore,
      timeout: 30000,
    });

    assert.ok(statusEvent, 'Expected a fundstatus event after completion');
    const statusMeta = statusEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(statusMeta?.result?.success, true, 'Expected fundstatus to succeed after completion');

    const statusLogs = (statusMeta?.result?.logs ?? []).map((l) => l.msg);
    // After completion, cycle should be 1
    assert.ok(
      statusLogs.some((msg) => msg.includes('cycle=1')),
      `Expected fundstatus to show cycle=1 after completion, got: ${JSON.stringify(statusLogs)}`,
    );
    assert.ok(
      statusLogs.some((msg) => msg.includes('total=0')),
      `Expected fundstatus to show total=0 after contributing the exact remaining amount, got: ${JSON.stringify(statusLogs)}`,
    );
  });

  it('should tell the contributor when excess contribution carries into the next round', async () => {
    const player = ctx.players[0]!;
    await resetFundState();
    await setCurrencyExact(player.playerId, 125);

    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 105`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected carryover contribution to succeed');

    const logMessages = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logMessages.some((msg) => msg.includes('5 currency carried over into Round #2.')),
      `Expected completion message to mention the carryover amount and next round, got: ${JSON.stringify(logMessages)}`,
    );

    const statusBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fundstatus`,
      playerId: player.playerId,
    });

    const statusEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: statusBefore,
      timeout: 30000,
    });

    const statusMeta = statusEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(statusMeta?.result?.success, true, 'Expected fundstatus to succeed after carryover completion');

    const statusLogs = (statusMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      statusLogs.some((msg) => msg.includes('total=5')),
      `Expected carryover total=5 after a 105 contribution into a 100 threshold, got: ${JSON.stringify(statusLogs)}`,
    );
  });

  it('should evict a stale lock before processing a new contribution', async () => {
    const player = ctx.players[0]!;
    await resetFundState();
    await setCurrencyExact(player.playerId, 25);
    await upsertLockValue(JSON.stringify({
      owner: 'stale-owner',
      createdAt: Date.now() - 130000,
      refreshedAt: Date.now() - 130000,
    }));

    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 10`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected contribution to succeed after stale-lock eviction');

    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logs.some((msg) => msg.includes('removed stale fund lock owned by stale-owner')),
      `Expected stale-lock eviction log, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((msg) => msg.includes('Fund contribution')),
      `Expected contribution log after stale-lock eviction, got: ${JSON.stringify(logs)}`,
    );
  });

  it('should recover from a malformed lock payload by clearing it as stale', async () => {
    const player = ctx.players[0]!;
    await resetFundState();
    await setCurrencyExact(player.playerId, 25);
    await upsertLockValue('not-json-at-all');

    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 10`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected contribution to succeed after malformed-lock recovery');

    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logs.some((msg) => msg.includes('removed stale fund lock owned by unknown')),
      `Expected malformed lock to be treated as stale, got: ${JSON.stringify(logs)}`,
    );
  });

  it('should fail cleanly when a live lock is held by another contributor', async () => {
    const player = ctx.players[0]!;
    await resetFundState();
    await setCurrencyExact(player.playerId, 25);
    await upsertLockValue(JSON.stringify({
      owner: 'active-owner',
      createdAt: Date.now(),
      refreshedAt: Date.now(),
    }));

    const before = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 10`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'Expected contribution to fail while a live lock is held');

    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logs.some((msg) => msg.includes('busy processing another contribution')),
      `Expected friendly lock-timeout message, got: ${JSON.stringify(logs)}`,
    );
  });

  it('should serialize simultaneous valid deposits from different players without losing either contribution', async () => {
    const firstPlayer = ctx.players[0]!;
    const secondPlayer = ctx.players[2]!;

    extraContributeRoleId ??= await assignPermissions(
      client,
      secondPlayer.playerId,
      ctx.gameServer.id,
      ['COMMUNITY_FUND_CONTRIBUTE'],
    );

    await resetFundState();
    await setCurrencyExact(firstPlayer.playerId, 10);
    await setCurrencyExact(secondPlayer.playerId, 10);

    const before = new Date();
    await Promise.all([
      client.command.commandControllerTrigger(ctx.gameServer.id, {
        msg: `${prefix}fund 10`,
        playerId: firstPlayer.playerId,
      }),
      client.command.commandControllerTrigger(ctx.gameServer.id, {
        msg: `${prefix}fund 10`,
        playerId: secondPlayer.playerId,
      }),
    ]);

    const events = await waitForCommandEvents(before, 2);
    const fundEvents = events
      .map((event) => event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } })
      .map((meta) => ({
        success: meta?.result?.success ?? false,
        logs: (meta?.result?.logs ?? []).map((l) => l.msg),
      }))
      .filter((result) => result.logs.some((msg) => msg.includes('Fund contribution')));

    assert.equal(fundEvents.length, 2, `Expected both contribution events, got: ${JSON.stringify(fundEvents)}`);
    assert.equal(
      fundEvents.filter((result) => result.success).length,
      2,
      `Expected both simultaneous valid deposits to succeed, got: ${JSON.stringify(fundEvents)}`,
    );

    const firstPog = await getPog(firstPlayer.playerId);
    const secondPog = await getPog(secondPlayer.playerId);
    assert.ok(firstPog, 'Expected first player POG to exist after serialized deposits');
    assert.ok(secondPog, 'Expected second player POG to exist after serialized deposits');
    assert.equal(firstPog?.currency, 0, `Expected first player currency to be deducted once, got: ${JSON.stringify(firstPog)}`);
    assert.equal(secondPog?.currency, 0, `Expected second player currency to be deducted once, got: ${JSON.stringify(secondPog)}`);

    const statusBefore = new Date();
    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fundstatus`,
      playerId: firstPlayer.playerId,
    });
    const statusEvent = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: statusBefore,
      timeout: 30000,
    });
    const statusMeta = statusEvent.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    const statusLogs = (statusMeta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      statusLogs.some((msg) => msg.includes('total=20')),
      `Expected both serialized deposits to persist in fund state, got: ${JSON.stringify(statusLogs)}`,
    );
  });
});

describe('community-fund: lock owner mismatch during release', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let contributeRoleId: string;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        fundThreshold: 100,
        minimumContribution: 10,
        completionMessage: 'The community fund reached {threshold}!',
        completionCommands: [],
        broadcastContributions: false,
        
      },
    });
    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    contributeRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['COMMUNITY_FUND_CONTRIBUTE'],
    );

    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[0].playerId, {
      currency: 50,
    });
  });

  after(async () => {
    await cleanupRole(client, contributeRoleId);
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall owner-mismatch module:', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete owner-mismatch module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  it('logs a warning and leaves the lock record alone when ownership changes before release', async () => {
    const player = ctx.players[0]!;
    await client.variable.variableControllerCreate({
      key: '__debug_replace_lock_owner_before_release',
      value: JSON.stringify(true),
      gameServerId: ctx.gameServer.id,
      moduleId,
    });
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 10`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, true, 'Expected contribution to succeed even if release sees an owner mismatch');

    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logs.some((msg) => msg.includes('was not released because ownership changed')),
      `Expected release owner-mismatch warning, got: ${JSON.stringify(logs)}`,
    );

    const lockSearch = await client.variable.variableControllerSearch({
      filters: {
        key: ['fund_state_lock'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
      limit: 10,
    });
    assert.equal(lockSearch.data.data.length, 1, `Expected mismatched lock to remain for inspection, got: ${JSON.stringify(lockSearch.data.data)}`);

    await client.variable.variableControllerDelete(lockSearch.data.data[0].id);
  });
});

describe('community-fund: refund handling after state-write failure', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let contributeRoleId: string;

  before(async () => {
    client = await createClient();
    await cleanupTestModules(client);
    await cleanupTestGameServers(client);
    ctx = await startMockServer(client);

    await client.settings.settingsControllerSet('economyEnabled', {
      gameServerId: ctx.gameServer.id,
      value: 'true',
    });

    const mod = await pushModule(client, MODULE_DIR);
    moduleId = mod.id;
    versionId = mod.latestVersion.id;

    await installModule(client, versionId, ctx.gameServer.id, {
      userConfig: {
        fundThreshold: 100,
        minimumContribution: 10,
        completionMessage: 'The community fund reached {threshold}!',
        completionCommands: [],
        broadcastContributions: false,
        
      },
    });
    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    contributeRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['COMMUNITY_FUND_CONTRIBUTE'],
    );

    await client.playerOnGameserver.playerOnGameServerControllerAddCurrency(ctx.gameServer.id, ctx.players[0].playerId, {
      currency: 50,
    });
  });

  after(async () => {
    await cleanupRole(client, contributeRoleId);
    try {
      await uninstallModule(client, moduleId, ctx.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall refund-test module:', err);
    }
    try {
      await deleteModule(client, moduleId);
    } catch (err) {
      console.error('Cleanup: failed to delete refund-test module:', err);
    }
    await stopMockServer(ctx.server, client, ctx.gameServer.id);
  });

  async function getPog(playerId: string) {
    const result = await client.playerOnGameserver.playerOnGameServerControllerSearch({
      filters: {
        gameServerId: [ctx.gameServer.id],
        playerId: [playerId],
      },
    });
    return result.data.data[0];
  }

  it('refunds the player and leaves fund state unchanged when persistence fails after deduction', async () => {
    const player = ctx.players[0]!;
    await client.variable.variableControllerCreate({
      key: '__debug_force_state_write_failure_after_deduct',
      value: JSON.stringify(true),
      gameServerId: ctx.gameServer.id,
      moduleId,
    });
    const beforePog = await getPog(player.playerId);
    assert.ok(beforePog, 'Expected player POG before refund-path test');
    const beforeCurrency = beforePog?.currency ?? 0;
    const before = new Date();

    await client.command.commandControllerTrigger(ctx.gameServer.id, {
      msg: `${prefix}fund 20`,
      playerId: player.playerId,
    });

    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: ctx.gameServer.id,
      after: before,
      timeout: 30000,
    });

    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    assert.equal(meta?.result?.success, false, 'Expected contribution to fail after the forced state-write error');

    const logs = (meta?.result?.logs ?? []).map((l) => l.msg);
    assert.ok(
      logs.some((msg) => msg.includes('failed to persist contribution state')),
      `Expected state-write failure to be logged, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((msg) => msg.includes('rolled back 20 currency')),
      `Expected refund success to be logged, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((msg) => msg.includes('currency was refunded')),
      `Expected player-facing refund message, got: ${JSON.stringify(logs)}`,
    );

    const afterPog = await getPog(player.playerId);
    assert.ok(afterPog, 'Expected player POG after refund-path test');
    assert.equal(afterPog?.currency, beforeCurrency, `Expected refunded currency balance, got: ${JSON.stringify(afterPog)}`);

    const totalVariable = await client.variable.variableControllerSearch({
      filters: {
        key: ['fund_total'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    assert.equal(totalVariable.data.data.length, 0, `Expected no persisted fund_total after rollback, got: ${JSON.stringify(totalVariable.data.data)}`);
  });
});
