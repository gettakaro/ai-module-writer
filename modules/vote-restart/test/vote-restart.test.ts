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
// Test ordering is carefully chosen to avoid hitting threshold prematurely:
//   1. Start vote (players[0] auto-voted → 1/2)
//   2. Reject second voterestart (already active)
//   3. Reject duplicate /voteyes from players[0] — vote still 1/2, not passed yet
//   4. Reject /voteyes from immune players[2]
//   5. Reject /voterestart from players[2] (no INITIATE perm)
//   6. /votestatus → shows active vote count + threshold
//   7. players[1] /voteyes → 2/2 → immediate pass
//   8. /votestatus → shows "restarting in Xs"
//   9. Cronjob: restartDelay=0 elapsed → executes restart, clears state
//   10. /voteyes with no active vote → rejected
//   11. /votestatus with no active vote → "No active restart vote"
//   12. Start new vote, manipulate state to simulate expiry, trigger cronjob, cooldown enforced

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

  // ── Test 1: Start vote with permission ───────────────────────────────────
  // State after: vote active, players[0] auto-voted (1/2), vote NOT passed yet

  it('should start a vote when player has VOTE_RESTART_INITIATE', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, 'voterestart');
    const { success, logs } = getResult(event);

    assert.equal(success, true, `Expected success=true, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('vote started')),
      `Expected log to mention "vote started", got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 2: Start vote when already active ────────────────────────────────
  // State after: still 1/2, vote active

  it('should reject starting a vote when one is already active', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, 'voterestart');
    const { success, logs } = getResult(event);

    assert.equal(success, false, `Expected success=false, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('already in progress')),
      `Expected "already in progress" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 3: Duplicate /voteyes rejected ───────────────────────────────────
  // players[0] already voted in test 1 auto-vote. Still 1/2 after this rejection.

  it('should reject duplicate /voteyes from same player', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, 'voteyes');
    const { success, logs } = getResult(event);

    assert.equal(success, false, `Expected success=false, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('already voted')),
      `Expected "already voted" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 4: Immune player /voteyes rejected ───────────────────────────────
  // players[2] has VOTE_RESTART_IMMUNE. Still 1/2 after rejection.

  it('should reject /voteyes from an immune player', async () => {
    const event = await triggerCommand(ctx.players[2].playerId, 'voteyes');
    const { success, logs } = getResult(event);

    assert.equal(success, false, `Expected success=false, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('immune')),
      `Expected "immune" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 5: /voterestart without permission rejected ──────────────────────
  // players[2] has VOTE_RESTART_IMMUNE but NOT VOTE_RESTART_INITIATE.
  // Permission check fires before the "already active" check.

  it('should reject /voterestart without VOTE_RESTART_INITIATE permission', async () => {
    const event = await triggerCommand(ctx.players[2].playerId, 'voterestart');
    const { success, logs } = getResult(event);

    assert.equal(success, false, `Expected success=false, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('do not have permission')),
      `Expected "do not have permission" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 6: /votestatus shows active vote ────────────────────────────────
  // Vote is active with 1/2 votes, ~120s remaining

  it('should show active vote status with count and time remaining', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, 'votestatus');
    const { success, logs } = getResult(event);

    assert.equal(success, true, `Expected success=true, logs: ${JSON.stringify(logs)}`);
    // Should show vote count and remaining time
    assert.ok(
      logs.some((l) => l.includes('1/2') || (l.includes('vote') && l.includes('remaining'))),
      `Expected vote count and time remaining in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 7: /voteyes adds vote and vote passes immediately ────────────────
  // players[1] is the second non-immune voter → 2/2 = threshold → instant pass

  it('should accept /voteyes from a non-immune player and pass the vote', async () => {
    const event = await triggerCommand(ctx.players[1].playerId, 'voteyes');
    const { success, logs } = getResult(event);

    assert.equal(success, true, `Expected success=true, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('voted yes')),
      `Expected "voted yes" in logs, got: ${JSON.stringify(logs)}`,
    );
    // The vote should immediately pass since we hit the threshold
    assert.ok(
      logs.some((l) => l.includes('Vote passed')),
      `Expected "Vote passed" log, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 8: /votestatus shows passed vote with time remaining ─────────────
  // Vote just passed with restartDelay=0, should show passed state

  it('should show passed vote status after vote passes', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, 'votestatus');
    const { success, logs } = getResult(event);

    assert.equal(success, true, `Expected success=true, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('restart already initiated') || l.includes('restarting in')),
      `Expected "restart already initiated" or "restarting in" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 9: Restart executes after delay=0 (via cronjob) ──────────────────
  // Vote is in "passed" state. With restartDelay=0, cronjob should execute restart.

  it('should execute the restart command when restartDelay has elapsed', async () => {
    const varSearch = await client.variable.variableControllerSearch({
      filters: {
        key: ['vr_vote_state'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });
    assert.ok(varSearch.data.data.length > 0, 'Expected vr_vote_state variable to exist before restart cron');

    const voteStateVar = varSearch.data.data[0]!;
    const voteState = JSON.parse(voteStateVar.value);
    voteState.status = 'passed';
    voteState.passedAt = new Date(Date.now() - 2_000).toISOString();
    await client.variable.variableControllerUpdate(voteStateVar.id, {
      value: JSON.stringify(voteState),
    });

    const { success, logs } = await triggerCronjob();

    assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('restart command executed successfully')),
      `Expected "restart command executed successfully" in cronjob logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 10: /voteyes with no active vote ─────────────────────────────────
  // Vote state was cleared by restart in test 9.

  it('should reject /voteyes when no vote is active', async () => {
    const event = await triggerCommand(ctx.players[1].playerId, 'voteyes');
    const { success, logs } = getResult(event);

    assert.equal(success, false, `Expected success=false, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('no active restart vote')),
      `Expected "no active restart vote" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 11: /votestatus with no active vote ──────────────────────────────
  // Vote state was cleared by restart. Should show "No active restart vote".

  it('should show "No active restart vote" when no vote is in progress', async () => {
    const event = await triggerCommand(ctx.players[0].playerId, 'votestatus');
    const { success, logs } = getResult(event);

    assert.equal(success, true, `Expected success=true, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('No active restart vote') || l.includes('no active restart vote')),
      `Expected "No active restart vote" in logs, got: ${JSON.stringify(logs)}`,
    );
  });

  // ── Test 12: Cooldown enforced after expired vote ─────────────────────────
  // Start a new vote, manipulate startedAt to be in the past (expired),
  // trigger cronjob to detect expiry+set cooldown, then verify /voterestart blocked.

  it('should enforce cooldown after an expired vote', async () => {
    // Start a new vote (no cooldown active since prior vote passed, not expired)
    const startEvent = await triggerCommand(ctx.players[0].playerId, 'voterestart');
    const startResult = getResult(startEvent);
    assert.equal(startResult.success, true, `Expected vote to start, logs: ${JSON.stringify(startResult.logs)}`);

    // Manipulate vr_vote_state to set startedAt to 200s ago (beyond voteDuration=120)
    const varSearch = await client.variable.variableControllerSearch({
      filters: {
        key: ['vr_vote_state'],
        gameServerId: [ctx.gameServer.id],
        moduleId: [moduleId],
      },
    });

    assert.ok(varSearch.data.data.length > 0, 'Expected vr_vote_state variable to exist');
    const varRecord = varSearch.data.data[0]!;

    const pastTime = new Date(Date.now() - 200 * 1000).toISOString();
    const currentState = JSON.parse(varRecord.value);
    currentState.startedAt = pastTime;
    await client.variable.variableControllerUpdate(varRecord.id, {
      value: JSON.stringify(currentState),
    });

    // Trigger cronjob — should detect expiry, set cooldown, delete vote state
    const { success: cjSuccess, logs: cjLogs } = await triggerCronjob();
    assert.equal(cjSuccess, true, `Expected cronjob to succeed on expiry, logs: ${JSON.stringify(cjLogs)}`);
    assert.ok(
      cjLogs.some((l) => l.includes('expired') || l.includes('vote expired')),
      `Expected "expired" in cronjob logs, got: ${JSON.stringify(cjLogs)}`,
    );

    // Now try to start a vote — should be blocked by cooldown
    const cooldownEvent = await triggerCommand(ctx.players[0].playerId, 'voterestart');
    const { success, logs } = getResult(cooldownEvent);

    assert.equal(success, false, `Expected cooldown block, logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('recently failed') || l.includes('wait')),
      `Expected cooldown message in logs, got: ${JSON.stringify(logs)}`,
    );
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
});

// ── Dynamic threshold recalculation test ──────────────────────────────────────
// Tests the scenario where a voter's disconnect reduces the denominator such
// that the remaining online votes now meet the (recalculated) threshold.
// We simulate this by injecting a vote state with 1 voter and using passThreshold=49
// so that with 2 online eligible players, threshold=ceil(2*49/100)=1.
// This validates the cronjob's dynamic threshold recalculation logic.

describe('vote-restart dynamic threshold recalculation', () => {
  let client3: Client;
  let ctx3: MockServerContext;
  let moduleId3: string;
  let versionId3: string;
  let cronjobId3: string;
  let initiateRoleId3: string | undefined;
  let immuneRoleId3: string | undefined;

  before(async () => {
    client3 = await createClient();
    ctx3 = await startMockServer(client3);

    const mod = await pushModule(client3, MODULE_DIR);
    moduleId3 = mod.id;
    versionId3 = mod.latestVersion.id;

    // passThreshold=49: with 2 eligible players, threshold=ceil(2*49/100)=1
    // This means 1 vote from 1 online voter is enough to pass
    await installModule(client3, versionId3, ctx3.gameServer.id, {
      userConfig: {
        voteDuration: 120,
        cooldownDuration: 60,
        restartDelay: 0,
        restartCommand: 'say restart-test',
        passThreshold: 49,
        minimumPlayers: 2,
      },
    });

    const cronjob = mod.latestVersion.cronJobs[0];
    if (!cronjob) throw new Error('Expected at least one cronjob in vote-restart module');
    cronjobId3 = cronjob.id;

    // players[0] gets VOTE_RESTART_INITIATE
    initiateRoleId3 = await assignPermissions(
      client3,
      ctx3.players[0].playerId,
      ctx3.gameServer.id,
      ['VOTE_RESTART_INITIATE'],
    );

    // players[2] gets VOTE_RESTART_IMMUNE
    immuneRoleId3 = await assignPermissions(
      client3,
      ctx3.players[2].playerId,
      ctx3.gameServer.id,
      ['VOTE_RESTART_IMMUNE'],
    );
  });

  after(async () => {
    await cleanupRole(client3, initiateRoleId3);
    await cleanupRole(client3, immuneRoleId3);
    try {
      await uninstallModule(client3, moduleId3, ctx3.gameServer.id);
    } catch (err) {
      console.error('Cleanup: failed to uninstall dynamic-threshold module:', err);
    }
    try {
      await deleteModule(client3, moduleId3);
    } catch (err) {
      console.error('Cleanup: failed to delete dynamic-threshold module:', err);
    }
    await stopMockServer(ctx3.server, client3, ctx3.gameServer.id);
  });

  const triggerCronjob3 = makeCronjobHelper(
    () => client3,
    () => ctx3.gameServer.id,
    () => cronjobId3,
    () => moduleId3,
  );

  // Scenario: players[0] voted yes (1 vote). players[1] disconnects (non-voter).
  // After disconnect, eligible online = [players[0]], threshold = ceil(1*49/100) = 1.
  // Cronjob should detect 1 effective vote >= threshold of 1 → vote passes.
  //
  // We simulate the disconnect by injecting an "active" vote state with only
  // players[0] as a voter, while both non-immune players are online (threshold=1
  // with passThreshold=49). This tests that the cronjob dynamically recalculates
  // the threshold from current online non-immune players rather than using a
  // fixed or cached value.

  it('should detect vote pass when dynamic threshold recalculates to match effective votes', async () => {
    // Inject active vote state with players[0] as sole voter
    const voteState = {
      startedAt: new Date().toISOString(),
      initiatorName: 'TestPlayer',
      voters: [ctx3.players[0].playerId],
      status: 'active',
    };
    await client3.variable.variableControllerCreate({
      key: 'vr_vote_state',
      value: JSON.stringify(voteState),
      gameServerId: ctx3.gameServer.id,
      moduleId: moduleId3,
    });

    try {
      // With 2 eligible online players and passThreshold=49, threshold=ceil(2*49/100)=1
      // players[0] voted → effectiveVotes=1 >= threshold=1 → should pass
      const { success, logs } = await triggerCronjob3();

      assert.equal(success, true, `Expected cronjob to succeed, logs: ${JSON.stringify(logs)}`);
      assert.ok(
        logs.some((l) => l.includes('Vote passed')),
        `Expected "Vote passed" in cronjob logs (dynamic threshold recalculation), got: ${JSON.stringify(logs)}`,
      );
    } finally {
      // Clean up any remaining vote state
      const varSearch = await client3.variable.variableControllerSearch({
        filters: {
          key: ['vr_vote_state'],
          gameServerId: [ctx3.gameServer.id],
          moduleId: [moduleId3],
        },
      });
      for (const v of varSearch.data.data) {
        await client3.variable.variableControllerDelete(v.id);
      }
    }
  });
});
