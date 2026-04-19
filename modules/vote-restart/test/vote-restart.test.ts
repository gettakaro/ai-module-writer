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

// ── Shared helper factories ───────────────────────────────────────────────────

function makeCommandHelpers(
  getClient: () => Client,
  getGameServerId: () => string,
  getPrefix: () => string,
) {
  async function triggerCommand(playerId: string, msg: string) {
    const client = getClient();
    const gameServerId = getGameServerId();
    const prefix = getPrefix();
    const triggerTime = new Date();
    await client.command.commandControllerTrigger(gameServerId, {
      msg: `${prefix}${msg}`,
      playerId,
    });
    return waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted,
      gameserverId: gameServerId,
      after: triggerTime,
      timeout: 30000,
    });
  }

  function getResult(event: Awaited<ReturnType<typeof triggerCommand>>) {
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success,
      logs: (meta?.result?.logs ?? []).map((l) => l.msg),
    };
  }

  return { triggerCommand, getResult };
}

function makeCronjobHelper(
  getClient: () => Client,
  getGameServerId: () => string,
  getCronjobId: () => string,
  getModuleId: () => string,
) {
  return async function triggerCronjob() {
    const client = getClient();
    const gameServerId = getGameServerId();
    const cronjobId = getCronjobId();
    const moduleId = getModuleId();

    const triggerTime = new Date();
    await client.cronjob.cronJobControllerTrigger({
      gameServerId,
      cronjobId,
      moduleId,
    });
    const event = await waitForEvent(client, {
      eventName: EventSearchInputAllowedFiltersEventNameEnum.CronjobExecuted,
      gameserverId: gameServerId,
      after: triggerTime,
      timeout: 30000,
    });
    const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
    return {
      success: meta?.result?.success,
      logs: (meta?.result?.logs ?? []).map((l) => l.msg),
    };
  };
}

// Test setup:
//   voteDuration=120s, cooldownDuration=60s, restartDelay=0, passThreshold=51, minimumPlayers=2
//
// Mock server provides 3 players:
//   players[0] — has VOTE_RESTART_INITIATE (can start votes; also used as regular voter)
//   players[1] — plain player (can /voteyes, no special perms)
//   players[2] — has VOTE_RESTART_IMMUNE (excluded from voter pool + denominator)
//
// Eligible non-immune players = [0, 1] → count=2, threshold=ceil(2*51/100)=2
//
// The primary lifecycle suite below exercises the full vote flow inside a single test so
// state transitions stay local to that scenario instead of leaking across test cases.

describe('vote-restart module', () => {
  let client: Client;
  let ctx: MockServerContext;
  let moduleId: string;
  let versionId: string;
  let prefix: string;
  let cronjobId: string;
  let initiateRoleId: string | undefined;
  let immuneRoleId: string | undefined;

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
        voteDuration: 120,
        cooldownDuration: 60,
        restartDelay: 0,
        restartCommand: 'say restart-test',
        passThreshold: 51,
        minimumPlayers: 2,
      },
    });

    prefix = await getCommandPrefix(client, ctx.gameServer.id);

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected at least one cronjob in vote-restart module');
    cronjobId = cronjob.id;

    // players[0] gets VOTE_RESTART_INITIATE
    initiateRoleId = await assignPermissions(
      client,
      ctx.players[0].playerId,
      ctx.gameServer.id,
      ['VOTE_RESTART_INITIATE'],
    );

    // players[2] gets VOTE_RESTART_IMMUNE
    immuneRoleId = await assignPermissions(
      client,
      ctx.players[2].playerId,
      ctx.gameServer.id,
      ['VOTE_RESTART_IMMUNE'],
    );
  });

  after(async () => {
    await cleanupRole(client, initiateRoleId);
    await cleanupRole(client, immuneRoleId);
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

  // ── Helpers: trigger commands and parse results ───────────────────────────

  const { triggerCommand, getResult } = makeCommandHelpers(
    () => client,
    () => ctx.gameServer.id,
    () => prefix,
  );

  const triggerCronjob = makeCronjobHelper(
    () => client,
    () => ctx.gameServer.id,
    () => cronjobId,
    () => moduleId,
  );

  it('covers the full vote lifecycle without relying on inter-test ordering', async () => {
    const start = getResult(await triggerCommand(ctx.players[0].playerId, 'voterestart'));
    assert.equal(start.success, true, `Expected vote start success, logs: ${JSON.stringify(start.logs)}`);
    assert.ok(start.logs.some((l) => l.includes('vote started')), `Expected start log, got: ${JSON.stringify(start.logs)}`);

    const duplicateStart = getResult(await triggerCommand(ctx.players[0].playerId, 'voterestart'));
    assert.equal(duplicateStart.success, false, `Expected duplicate start rejection, logs: ${JSON.stringify(duplicateStart.logs)}`);
    assert.ok(duplicateStart.logs.some((l) => l.includes('already in progress')));

    const duplicateYes = getResult(await triggerCommand(ctx.players[0].playerId, 'voteyes'));
    assert.equal(duplicateYes.success, false, `Expected duplicate /voteyes rejection, logs: ${JSON.stringify(duplicateYes.logs)}`);
    assert.ok(duplicateYes.logs.some((l) => l.includes('already voted')));

    const immuneYes = getResult(await triggerCommand(ctx.players[2].playerId, 'voteyes'));
    assert.equal(immuneYes.success, false, `Expected immune /voteyes rejection, logs: ${JSON.stringify(immuneYes.logs)}`);
    assert.ok(immuneYes.logs.some((l) => l.includes('immune')));

    const noPermStart = getResult(await triggerCommand(ctx.players[2].playerId, 'voterestart'));
    assert.equal(noPermStart.success, false, `Expected missing-permission rejection, logs: ${JSON.stringify(noPermStart.logs)}`);
    assert.ok(noPermStart.logs.some((l) => l.includes('do not have permission')));

    const activeStatus = getResult(await triggerCommand(ctx.players[0].playerId, 'votestatus'));
    assert.equal(activeStatus.success, true, `Expected active votestatus success, logs: ${JSON.stringify(activeStatus.logs)}`);
    assert.ok(activeStatus.logs.some((l) => l.includes('1/2') || (l.includes('vote') && l.includes('remaining'))));

    const secondYes = getResult(await triggerCommand(ctx.players[1].playerId, 'voteyes'));
    assert.equal(secondYes.success, true, `Expected second yes vote success, logs: ${JSON.stringify(secondYes.logs)}`);
    assert.ok(secondYes.logs.some((l) => l.includes('voted yes')));
    assert.ok(secondYes.logs.some((l) => l.includes('Vote passed')));

    const passedStatus = getResult(await triggerCommand(ctx.players[0].playerId, 'votestatus'));
    assert.equal(passedStatus.success, true, `Expected passed votestatus success, logs: ${JSON.stringify(passedStatus.logs)}`);
    assert.ok(passedStatus.logs.some((l) => l.includes('restart already initiated') || l.includes('restarting in')));

    const restartCron = await triggerCronjob();
    assert.equal(restartCron.success, true, `Expected restart cronjob success, logs: ${JSON.stringify(restartCron.logs)}`);
    assert.ok(restartCron.logs.some((l) => l.includes('restart command executed successfully')));

    const yesWithoutVote = getResult(await triggerCommand(ctx.players[1].playerId, 'voteyes'));
    assert.equal(yesWithoutVote.success, false, `Expected /voteyes without vote to fail, logs: ${JSON.stringify(yesWithoutVote.logs)}`);
    assert.ok(yesWithoutVote.logs.some((l) => l.includes('no active restart vote')));

    const noVoteStatus = getResult(await triggerCommand(ctx.players[0].playerId, 'votestatus'));
    assert.equal(noVoteStatus.success, true, `Expected idle votestatus success, logs: ${JSON.stringify(noVoteStatus.logs)}`);
    assert.ok(noVoteStatus.logs.some((l) => l.includes('No active restart vote') || l.includes('no active restart vote')));

    const restartVote = getResult(await triggerCommand(ctx.players[0].playerId, 'voterestart'));
    assert.equal(restartVote.success, true, `Expected second vote start success, logs: ${JSON.stringify(restartVote.logs)}`);

    const varSearch = await client.variable.variableControllerSearch({
      filters: {
        key: ['vr_vote_state'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    assert.ok(varSearch.data.data.length > 0, 'Expected vr_vote_state variable to exist');
    const varRecord = varSearch.data.data[0]!;
    const currentState = JSON.parse(varRecord.value);
    currentState.startedAt = new Date(Date.now() - 200 * 1000).toISOString();
    await client.variable.variableControllerUpdate(varRecord.id, { value: JSON.stringify(currentState) });

    const expiredCron = await triggerCronjob();
    assert.equal(expiredCron.success, true, `Expected expiry cronjob success, logs: ${JSON.stringify(expiredCron.logs)}`);
    assert.ok(expiredCron.logs.some((l) => l.includes('expired') || l.includes('vote expired')));

    const cooldownStart = getResult(await triggerCommand(ctx.players[0].playerId, 'voterestart'));
    assert.equal(cooldownStart.success, false, `Expected cooldown rejection, logs: ${JSON.stringify(cooldownStart.logs)}`);
    assert.ok(cooldownStart.logs.some((l) => l.includes('recently failed') || l.includes('wait')));
  });
});

// ── Additional edge-case tests ─────────────────────────────────────────────────
// These run in a separate describe block with a fresh module installation so
// they can use a different config without disrupting the sequential main suite.

describe('vote-restart edge cases', () => {
  let client2: Client;
  let ctx2: MockServerContext;
  let moduleId2: string;
  let versionId2: string;
  let prefix2: string;
  let initiateRoleId2: string | undefined;
  let immuneRoleId2: string | undefined;

  before(async () => {
    client2 = await createClient();
    ctx2 = await startMockServer(client2);

    const mod = await pushModule(client2, MODULE_DIR);
    moduleId2 = mod.id;
    versionId2 = mod.latestVersion.id;

    // Install with minimumPlayers=4 so rejection is guaranteed with only 2 eligible players
    await installModule(client2, versionId2, ctx2.gameServer.id, {
      userConfig: {
        voteDuration: 120,
        cooldownDuration: 60,
        restartDelay: 0,
        restartCommand: 'say restart-test',
        passThreshold: 51,
        minimumPlayers: 4,
      },
    });

    prefix2 = await getCommandPrefix(client2, ctx2.gameServer.id);

    // players[0] gets VOTE_RESTART_INITIATE
    initiateRoleId2 = await assignPermissions(
      client2,
      ctx2.players[0].playerId,
      ctx2.gameServer.id,
      ['VOTE_RESTART_INITIATE'],
    );

    // players[2] gets VOTE_RESTART_IMMUNE
    immuneRoleId2 = await assignPermissions(
      client2,
      ctx2.players[2].playerId,
      ctx2.gameServer.id,
      ['VOTE_RESTART_IMMUNE'],
    );
  });

  after(async () => {
    await cleanupRole(client2, initiateRoleId2);
    await cleanupRole(client2, immuneRoleId2);
    try {
      await uninstallModule(client2, moduleId2, ctx2.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall edge-case module:', err);
    }
    try {
      await deleteModule(client2, moduleId2);
    } catch (err) {
      console.error('Cleanup: failed to delete edge-case module:', err);
    }
    await stopMockServer(ctx2.server, client2, ctx2.gameServer.id);
  });

  const { triggerCommand: triggerCommand2, getResult: getResult2 } = makeCommandHelpers(
    () => client2,
    () => ctx2.gameServer.id,
    () => prefix2,
  );

  // ── Test: minimumPlayers enforcement ─────────────────────────────────────
  // minimumPlayers=4 but only 2 non-immune players online — should be rejected.

  it('should reject /voterestart when fewer than minimumPlayers non-immune players are online', async () => {
    const event = await triggerCommand2(ctx2.players[0].playerId, 'voterestart');
    const { success, logs } = getResult2(event);

    assert.equal(success, false, `Expected success=false, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('Not enough players')),
      `Expected "Not enough players" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test: /voteyes when vote already passed ───────────────────────────────
  // Directly inject a "passed" vote state via the variable API and verify
  // /voteyes is rejected with "already passed" error.
  // This avoids reinstalling the module mid-test and is more reliable.

  it('should reject /voteyes when the vote has already passed', async () => {
    // Directly write a "passed" vote state — bypass the minimumPlayers restriction
    const passedState = {
      startedAt: new Date(Date.now() - 30 * 1000).toISOString(),
      initiatorName: 'TestPlayer',
      voters: [ctx2.players[0].playerId],
      status: 'passed',
      passedAt: new Date().toISOString(),
    };
    await client2.variable.variableControllerCreate({
      key: 'vr_vote_state',
      value: JSON.stringify(passedState),
      gameServerId: ctx2.gameServer.id,
      moduleId: moduleId2,
    });

    let event: Awaited<ReturnType<typeof triggerCommand2>>;
    try {
      // Try /voteyes — vote status is "passed", should be rejected
      event = await triggerCommand2(ctx2.players[1].playerId, 'voteyes');
    } finally {
      // Always clean up the vote state we created
      const varSearch = await client2.variable.variableControllerSearch({
        filters: {
          key: ['vr_vote_state'],
          gameServerId: [ctx2.gameServer.id],
          moduleId: [moduleId2],
        },
      });
      for (const v of varSearch.data.data) {
        await client2.variable.variableControllerDelete(v.id);
      }
    }

    const { success, logs } = getResult2(event);
    assert.equal(success, false, `Expected success=false when vote already passed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('already passed') || l.includes('Waiting for restart')),
      `Expected "already passed" or "Waiting for restart" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  it('should reject /voteyes from a player excluded from the locked eligible snapshot', async () => {
    const activeState = {
      startedAt: new Date(Date.now() - 10 * 1000).toISOString(),
      initiatorName: 'TestPlayer',
      voters: [ctx2.players[0].playerId],
      status: 'active',
      requiredVotes: 2,
      eligiblePlayerIds: [ctx2.players[0].playerId],
      eligibleCountAtStart: 1,
    };
    await client2.variable.variableControllerCreate({
      key: 'vr_vote_state',
      value: JSON.stringify(activeState),
      gameServerId: ctx2.gameServer.id,
      moduleId: moduleId2,
    });

    let event: Awaited<ReturnType<typeof triggerCommand2>>;
    try {
      event = await triggerCommand2(ctx2.players[1].playerId, 'voteyes');
    } finally {
      const varSearch = await client2.variable.variableControllerSearch({
        filters: {
          key: ['vr_vote_state'],
          gameServerId: [ctx2.gameServer.id],
          moduleId: [moduleId2],
        },
      });
      for (const v of varSearch.data.data) {
        await client2.variable.variableControllerDelete(v.id);
      }
    }

    const { success, logs } = getResult2(event);
    assert.equal(success, false, `Expected snapshot-excluded vote to fail, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('cannot vote on this round') || l.includes('not online when this restart vote started')),
      `Expected snapshot-exclusion message, got: ${JSON.stringify(logs)}`,
    );
  });
});

describe('vote-restart recovery paths and locked thresholds', () => {
  let client3: Client;
  let ctx3: MockServerContext;
  let moduleId3: string;
  let versionId3: string;
  let prefix3: string;
  let cronjobId3: string;
  let initiateRoleId3: string | undefined;
  let immuneRoleId3: string | undefined;

  before(async () => {
    client3 = await createClient();
    ctx3 = await startMockServer(client3);

    const mod = await pushModule(client3, MODULE_DIR);
    moduleId3 = mod.id;
    versionId3 = mod.latestVersion.id;
    prefix3 = await getCommandPrefix(client3, ctx3.gameServer.id);

    await installModule(client3, versionId3, ctx3.gameServer.id, {
      userConfig: {
        voteDuration: 120,
        cooldownDuration: 60,
        restartDelay: 30,
        restartCommand: 'say restart-test',
        passThreshold: 51,
        minimumPlayers: 2,
      },
    });

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected at least one cronjob in vote-restart module');
    cronjobId3 = cronjob.id;

    initiateRoleId3 = await assignPermissions(client3, ctx3.players[0].playerId, ctx3.gameServer.id, ['VOTE_RESTART_INITIATE']);
    immuneRoleId3 = await assignPermissions(client3, ctx3.players[2].playerId, ctx3.gameServer.id, ['VOTE_RESTART_IMMUNE']);
  });

  after(async () => {
    await cleanupRole(client3, initiateRoleId3);
    await cleanupRole(client3, immuneRoleId3);
    try {
      await uninstallModule(client3, moduleId3, ctx3.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall recovery module:', err);
    }
    try {
      await deleteModule(client3, moduleId3);
    } catch (err) {
      console.error('Cleanup: failed to delete recovery module:', err);
    }
    await stopMockServer(ctx3.server, client3, ctx3.gameServer.id);
  });

  const { triggerCommand: triggerCommand3, getResult: getResult3 } = makeCommandHelpers(
    () => client3,
    () => ctx3.gameServer.id,
    () => prefix3,
  );
  const triggerCronjob3 = makeCronjobHelper(
    () => client3,
    () => ctx3.gameServer.id,
    () => cronjobId3,
    () => moduleId3,
  );

  it('keeps a passed restart blocked when only vr_restart_state remains', async () => {
    await client3.variable.variableControllerCreate({
      key: 'vr_restart_state',
      value: JSON.stringify({
        status: 'passed',
        initiatorName: 'TestPlayer',
        voters: [ctx3.players[0].playerId, ctx3.players[1].playerId],
        passedAt: new Date().toISOString(),
        restartAt: new Date(Date.now() + 30_000).toISOString(),
        requiredVotes: 2,
      }),
      gameServerId: ctx3.gameServer.id,
      moduleId: moduleId3,
    });

    try {
      const status = await triggerCommand3(ctx3.players[0].playerId, 'votestatus');
      const statusResult = getResult3(status);
      assert.equal(statusResult.success, true, `Expected votestatus success, logs=${JSON.stringify(statusResult.logs)}`);
      assert.ok(statusResult.logs.some((l) => l.includes('Vote passed')), `Expected passed status, logs=${JSON.stringify(statusResult.logs)}`);

      const yes = await triggerCommand3(ctx3.players[1].playerId, 'voteyes');
      const yesResult = getResult3(yes);
      assert.equal(yesResult.success, false, `Expected voteyes rejection, logs=${JSON.stringify(yesResult.logs)}`);
      assert.ok(yesResult.logs.some((l) => l.includes('already passed') || l.includes('Waiting for restart')));

      const start = await triggerCommand3(ctx3.players[0].playerId, 'voterestart');
      const startResult = getResult3(start);
      assert.equal(startResult.success, false, `Expected voterestart rejection, logs=${JSON.stringify(startResult.logs)}`);
      assert.ok(startResult.logs.some((l) => l.includes('already passed') || l.includes('restarting shortly')));
    } finally {
      const vars = await client3.variable.variableControllerSearch({ filters: { key: ['vr_restart_state'], gameServerId: [ctx3.gameServer.id], moduleId: [moduleId3] } });
      for (const row of vars.data.data) await client3.variable.variableControllerDelete(row.id);
    }
  });

  it('does not pass an active vote early when requiredVotes was locked at start', async () => {
    await client3.variable.variableControllerCreate({
      key: 'vr_vote_state',
      value: JSON.stringify({
        startedAt: new Date().toISOString(),
        initiatorName: 'TestPlayer',
        voters: [ctx3.players[0].playerId],
        status: 'active',
        requiredVotes: 2,
        eligiblePlayerIds: [ctx3.players[0].playerId, ctx3.players[1].playerId],
        eligibleCountAtStart: 2,
      }),
      gameServerId: ctx3.gameServer.id,
      moduleId: moduleId3,
    });

    try {
      const cron = await triggerCronjob3();
      assert.equal(cron.success, true, `Expected cronjob success, logs=${JSON.stringify(cron.logs)}`);
      assert.ok(cron.logs.every((l) => !l.includes('Vote passed')), `Expected locked threshold to prevent pass, logs=${JSON.stringify(cron.logs)}`);
    } finally {
      const vars = await client3.variable.variableControllerSearch({ filters: { key: ['vr_vote_state', 'vr_restart_state'], gameServerId: [ctx3.gameServer.id], moduleId: [moduleId3] } as any });
      for (const row of vars.data.data) await client3.variable.variableControllerDelete(row.id);
    }
  });
});

describe('vote-restart immune initiator behavior', () => {
  let client6: Client;
  let ctx6: MockServerContext;
  let moduleId6: string;
  let versionId6: string;
  let prefix6: string;
  let initiatorImmuneRoleId6: string | undefined;

  before(async () => {
    client6 = await createClient();
    ctx6 = await startMockServer(client6);

    const mod = await pushModule(client6, MODULE_DIR);
    moduleId6 = mod.id;
    versionId6 = mod.latestVersion.id;

    await installModule(client6, versionId6, ctx6.gameServer.id, {
      userConfig: {
        voteDuration: 120,
        cooldownDuration: 60,
        restartDelay: 30,
        restartCommand: 'say restart-test',
        passThreshold: 100,
        minimumPlayers: 1,
      },
    });

    prefix6 = await getCommandPrefix(client6, ctx6.gameServer.id);
    initiatorImmuneRoleId6 = await assignPermissions(
      client6,
      ctx6.players[0].playerId,
      ctx6.gameServer.id,
      ['VOTE_RESTART_INITIATE', 'VOTE_RESTART_IMMUNE'],
    );
  });

  after(async () => {
    await cleanupRole(client6, initiatorImmuneRoleId6);
    try {
      await uninstallModule(client6, moduleId6, ctx6.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall immune-initiator module:', err);
    }
    try {
      await deleteModule(client6, moduleId6);
    } catch (err) {
      console.error('Cleanup: failed to delete immune-initiator module:', err);
    }
    await stopMockServer(ctx6.server, client6, ctx6.gameServer.id);
  });

  const { triggerCommand: triggerCommand6, getResult: getResult6 } = makeCommandHelpers(
    () => client6,
    () => ctx6.gameServer.id,
    () => prefix6,
  );

  it('starts at 0 votes when the initiator is immune', async () => {
    const start = getResult6(await triggerCommand6(ctx6.players[0].playerId, 'voterestart'));
    assert.equal(start.success, true, `Expected immune initiator vote start to succeed, logs=${JSON.stringify(start.logs)}`);
    assert.ok(start.logs.some((l) => l.includes('0/1') || l.includes('starts at 0')), `Expected immune-initiator broadcast wording, logs=${JSON.stringify(start.logs)}`);

    const voteState = await client6.variable.variableControllerSearch({
      filters: {
        key: ['vr_vote_state'],
        gameServerId: [ctx6.gameServer.id],
        moduleId: [moduleId6],
      },
    });
    assert.equal(voteState.data.data.length, 1, 'Expected vote state row for immune initiator');
    const state = JSON.parse(voteState.data.data[0]!.value);
    assert.deepEqual(state.voters, [], `Expected immune initiator not to auto-vote, state=${JSON.stringify(state)}`);
    assert.equal(state.eligibleCountAtStart, 2, `Expected only non-immune players to count toward eligibility, state=${JSON.stringify(state)}`);
  });
});

describe('vote-restart concurrent start locking', () => {
  let client5: Client;
  let ctx5: MockServerContext;
  let moduleId5: string;
  let versionId5: string;
  let prefix5: string;
  let initiateRoleId5a: string | undefined;
  let initiateRoleId5b: string | undefined;
  let immuneRoleId5: string | undefined;

  before(async () => {
    client5 = await createClient();
    ctx5 = await startMockServer(client5);

    const mod = await pushModule(client5, MODULE_DIR);
    moduleId5 = mod.id;
    versionId5 = mod.latestVersion.id;

    await installModule(client5, versionId5, ctx5.gameServer.id, {
      userConfig: {
        voteDuration: 120,
        cooldownDuration: 60,
        restartDelay: 30,
        restartCommand: 'say restart-test',
        passThreshold: 51,
        minimumPlayers: 2,
      },
    });

    prefix5 = await getCommandPrefix(client5, ctx5.gameServer.id);
    initiateRoleId5a = await assignPermissions(client5, ctx5.players[0].playerId, ctx5.gameServer.id, ['VOTE_RESTART_INITIATE']);
    initiateRoleId5b = await assignPermissions(client5, ctx5.players[1].playerId, ctx5.gameServer.id, ['VOTE_RESTART_INITIATE']);
    immuneRoleId5 = await assignPermissions(client5, ctx5.players[2].playerId, ctx5.gameServer.id, ['VOTE_RESTART_IMMUNE']);
  });

  after(async () => {
    await cleanupRole(client5, initiateRoleId5a);
    await cleanupRole(client5, initiateRoleId5b);
    await cleanupRole(client5, immuneRoleId5);
    try {
      await uninstallModule(client5, moduleId5, ctx5.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall locking module:', err);
    }
    try {
      await deleteModule(client5, moduleId5);
    } catch (err) {
      console.error('Cleanup: failed to delete locking module:', err);
    }
    await stopMockServer(ctx5.server, client5, ctx5.gameServer.id);
  });

  it('allows only one concurrent /voterestart to create the active vote', async () => {
    const after = new Date();
    await Promise.all([
      client5.command.commandControllerTrigger(ctx5.gameServer.id, { playerId: ctx5.players[0].playerId, msg: `${prefix5}voterestart` }),
      client5.command.commandControllerTrigger(ctx5.gameServer.id, { playerId: ctx5.players[1].playerId, msg: `${prefix5}voterestart` }),
    ]);

    let events: any[] = [];
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const result = await client5.event.eventControllerSearch({
        filters: {
          eventName: [EventSearchInputAllowedFiltersEventNameEnum.CommandExecuted],
          gameserverId: [ctx5.gameServer.id],
        },
        greaterThan: { createdAt: after.toISOString() },
        sortBy: 'createdAt',
        sortDirection: 'desc',
        limit: 10,
      });
      events = result.data.data;
      if (events.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    assert.ok(events.length >= 2, `Expected two command-executed events, got ${events.length}`);
    const results = events.slice(0, 2).map((event) => {
      const meta = event.meta as { result?: { success?: boolean; logs?: Array<{ msg: string }> } };
      return {
        success: meta?.result?.success ?? false,
        logs: (meta?.result?.logs ?? []).map((l) => l.msg),
      };
    });

    assert.equal(results.filter((r) => r.success).length, 1, `Expected exactly one successful starter, got ${JSON.stringify(results)}`);
    assert.equal(results.filter((r) => !r.success).length, 1, `Expected exactly one rejected starter, got ${JSON.stringify(results)}`);
    assert.ok(results.some((r) => r.logs.some((l) => l.includes('vote started'))), `Expected a start log, got ${JSON.stringify(results)}`);
    assert.ok(results.some((r) => r.logs.some((l) => l.includes('already in progress'))), `Expected a lock rejection log, got ${JSON.stringify(results)}`);

    const voteState = await client5.variable.variableControllerSearch({
      filters: {
        key: ['vr_vote_state'],
        gameServerId: [ctx5.gameServer.id],
        moduleId: [moduleId5],
      },
    });
    assert.equal(voteState.data.data.length, 1, 'Expected exactly one active vote state row after concurrent starts');
  });
});

describe('vote-restart restart failure handling', () => {
  let client4: Client;
  let ctx4: MockServerContext;
  let moduleId4: string;
  let versionId4: string;
  let cronjobId4: string;

  before(async () => {
    client4 = await createClient();
    ctx4 = await startMockServer(client4);

    const mod = await pushModule(client4, MODULE_DIR);
    moduleId4 = mod.id;
    versionId4 = mod.latestVersion.id;
    cronjobId4 = mod.latestVersion.cronJobs[0]!.id;

    await installModule(client4, versionId4, ctx4.gameServer.id, {
      userConfig: {
        voteDuration: 120,
        cooldownDuration: 60,
        restartDelay: 0,
        restartCommand: '',
        passThreshold: 51,
        minimumPlayers: 2,
      },
    });
  });

  after(async () => {
    try {
      await uninstallModule(client4, moduleId4, ctx4.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall failure-path module:', err);
    }
    try {
      await deleteModule(client4, moduleId4);
    } catch (err) {
      console.error('Cleanup: failed to delete failure-path module:', err);
    }
    await stopMockServer(ctx4.server, client4, ctx4.gameServer.id);
  });

  const triggerCronjob4 = makeCronjobHelper(
    () => client4,
    () => ctx4.gameServer.id,
    () => cronjobId4,
    () => moduleId4,
  );

  it('puts the module on cooldown and clears state when the restart command fails', async () => {
    await client4.variable.variableControllerCreate({
      key: 'vr_restart_state',
      value: JSON.stringify({
        status: 'passed',
        initiatorName: 'TestPlayer',
        voters: [ctx4.players[0].playerId, ctx4.players[1].playerId],
        passedAt: new Date(Date.now() - 5_000).toISOString(),
        restartAt: new Date(Date.now() - 1_000).toISOString(),
        requiredVotes: 2,
      }),
      gameServerId: ctx4.gameServer.id,
      moduleId: moduleId4,
    });

    const cron = await triggerCronjob4();
    assert.equal(cron.success, true, `Expected cronjob success, logs=${JSON.stringify(cron.logs)}`);
    assert.ok(
      cron.logs.some((l) => l.includes('failed to execute restart command')),
      `Expected restart-command failure log, got: ${JSON.stringify(cron.logs)}`,
    );

    const restartState = await client4.variable.variableControllerSearch({ filters: { key: ['vr_restart_state'], gameServerId: [ctx4.gameServer.id], moduleId: [moduleId4] } });
    const voteState = await client4.variable.variableControllerSearch({ filters: { key: ['vr_vote_state'], gameServerId: [ctx4.gameServer.id], moduleId: [moduleId4] } });
    const cooldown = await client4.variable.variableControllerSearch({ filters: { key: ['vr_cooldown_until'], gameServerId: [ctx4.gameServer.id], moduleId: [moduleId4] } });

    assert.equal(restartState.data.data.length, 0, 'Expected restart state to be cleared after failure');
    assert.equal(voteState.data.data.length, 0, 'Expected vote state to be cleared after failure');
    assert.equal(cooldown.data.data.length, 1, 'Expected cooldown to be set after restart failure');
  });
});
